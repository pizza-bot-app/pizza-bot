/** Loads plugin contributions and connects their MCP servers. */
import type { StructuredToolInterface } from "@langchain/core/tools";
import type { SkillCatalog } from "@pizza-bot/core";
import { MultiServerMCPClient, type Connection } from "@langchain/mcp-adapters";
import type { PluginLoadStatus } from "@pizza-bot/plugin-api";
import { basename, join } from "node:path";
import {
  FsPluginLoader,
  UnsupportedPluginApiVersionError,
} from "./loader.js";
import { loadSkillCatalog } from "./skill-catalog.js";
import { ContributionRegistry } from "./registry.js";
import type {
  PluginManifest,
  McpServerEntry,
  PluginMaterializerReason,
} from "@pizza-bot/plugin-api";
import type { ToolCatalog } from "./wildcard.js";
import {
  isNodeFamilyCommand,
  prependPath,
  resolveMcpCommand,
} from "./runtime-resolver.js";
import { parseFrontmatter } from "./frontmatter.js";
import { getLogger, withLogContext } from "@pizza-bot/logging";
import {
  materializePlugin,
  type PluginMaterializationStatus,
} from "./materializer.js";
import { restoreFlattenedUnions } from "./mcp-schema.js";
import {
  evaluatePluginCompatibility,
  type PluginHostContract,
} from "./compatibility.js";

export { parseFrontmatter };

export interface LoadedPlugins {
  readonly registry: ContributionRegistry;
  readonly pluginReports: readonly PluginLoadReport[];
  readonly tools: Record<string, StructuredToolInterface>;
  readonly catalog: ToolCatalog;
  readonly skills: SkillCatalog;
  readonly materializations: Readonly<Record<string, PluginMaterializationStatus>>;
  /** The host must close the client to reap MCP subprocesses. */
  readonly client?: McpClientPool;
}

export interface PluginLoadReport {
  name: string;
  root: string;
  apiVersion: string;
  status: PluginLoadStatus;
  manifest?: PluginManifest;
  detail?: string;
}

export type McpConnectionStatus = "loading" | "retrying" | "connected" | "error";

export interface McpConnectionEvent {
  server: string;
  status: McpConnectionStatus;
  attempt: number;
  toolCount?: number;
  detail?: string;
}

export interface McpConnectOptions {
  maxAttempts?: number;
  retryDelayMs?: number;
  concurrency?: number;
  connectionTimeoutMs?: number;
  /** Launches a selected Electron executable as Node for node-family commands. */
  electronRunAsNode?: boolean;
  onStatus?: (event: McpConnectionEvent) => void;
  onProgress?: (progress: McpConnectProgress) => void;
}

export interface McpConnectProgress {
  connectedServer: string;
  tools: Record<string, StructuredToolInterface>;
  catalog: ToolCatalog;
}

type ServerClient = Awaited<ReturnType<MultiServerMCPClient["getClient"]>>;

interface ListedMcpTool {
  name?: string;
  inputSchema?: unknown;
}

interface McpToolsPage {
  tools?: ListedMcpTool[];
  nextCursor?: string;
}

interface ToolListingClient {
  listTools(params?: { cursor?: string }): Promise<McpToolsPage>;
}

/**
 * One adapter instance per server allows startup to run in parallel and keeps
 * successful connections independent from failed or restarting siblings.
 */
export class McpClientPool {
  readonly #clients: Map<string, MultiServerMCPClient>;

  constructor(clients: ReadonlyMap<string, MultiServerMCPClient>) {
    this.#clients = new Map(clients);
  }

  get size(): number {
    return this.#clients.size;
  }

  async getClient(serverName: string): Promise<ServerClient> {
    return this.#clients.get(serverName)?.getClient(serverName);
  }

  /**
   * Transfers one connection from `replacement` and returns the displaced
   * connection as a separately owned pool.
   */
  replaceServer(
    serverName: string,
    replacement: McpClientPool | undefined,
  ): McpClientPool | undefined {
    const previous = this.#clients.get(serverName);
    const next = replacement
      ? replacement.#clients.get(serverName)
      : undefined;
    if (next && replacement) {
      this.#clients.set(serverName, next);
      replacement.#clients.delete(serverName);
    } else {
      this.#clients.delete(serverName);
    }
    return previous
      ? new McpClientPool(new Map([[serverName, previous]]))
      : undefined;
  }

  async close(): Promise<void> {
    await Promise.allSettled([...this.#clients.values()].map((client) => client.close()));
  }
}

export interface LoadPluginsOptions {
  /**
   * Directories are scanned in order into one registry. Duplicate plugin or
   * contribution identifiers are logged and skipped.
   */
  pluginsDir: string | readonly string[];
  log?: (msg: string) => void;
  /**
   * Preferred Node binary for node-family MCP commands. Defaults to
   * `PIZZA_MCP_NODE_PATH`, then a system Node.
   */
  nodePath?: string;
  /** Additional MCP servers replace plugin entries with the same name. */
  extraMcpServers?: Record<string, McpServerEntry>;
  /**
   * Uses Node spawn semantics and defaults to `"inherit"`. With `"pipe"`, the
   * caller must forward captured diagnostics if they should remain visible.
   */
  mcpStderr?: "inherit" | "pipe";
  /**
   * Environment inherited by every stdio server. Per-server values take
   * precedence.
   */
  extraEnv?: Record<string, string>;
  /** Per-server lifecycle updates emitted during parallel connection attempts. */
  onMcpStatus?: (event: McpConnectionEvent) => void;
  mcpMaxAttempts?: number;
  mcpRetryDelayMs?: number;
  mcpStartupConcurrency?: number;
  mcpConnectionTimeoutMs?: number;
  /** Discover contributions without delaying host readiness on MCP connections. */
  connectMcp?: boolean;
  /** Host-owned cache for validated materializer output. */
  materializationCacheDir?: string;
  materializationReason?: PluginMaterializerReason;
  /** Host contract used to evaluate engines and required capabilities. */
  hostContract: PluginHostContract;
}

/** Invalid plugins and failed MCP connections are logged and skipped. */
export async function loadPlugins(opts: LoadPluginsOptions): Promise<LoadedPlugins> {
  const log = opts.log ?? (() => {});
  const nodePath = opts.nodePath ?? process.env.PIZZA_MCP_NODE_PATH ?? undefined;
  const loader = new FsPluginLoader();
  const registry = new ContributionRegistry();

  const dirs = Array.isArray(opts.pluginsDir) ? opts.pluginsDir : [opts.pluginsDir];
  const pluginReports: PluginLoadReport[] = [];
  const materializations: Record<string, PluginMaterializationStatus> = {};
  for (const dir of dirs) {
    const found = await loader.find(dir, (d, err) => {
      const detail = err instanceof Error ? err.message : String(err);
      const unsupported = err instanceof UnsupportedPluginApiVersionError;
      pluginReports.push({
        name: unsupported && err.pluginName ? err.pluginName : basename(d),
        root: d,
        apiVersion: unsupported ? err.apiVersion : "unknown",
        status: unsupported ? "incompatible" : "failed",
        detail,
      });
      log(`skipping plugin at ${d}: ${detail}`);
    });
    for (const source of found) {
      const report = (
        status: PluginLoadStatus,
        detail?: string,
      ): void => {
        pluginReports.push({
          name: source.manifest.name,
          root: source.root,
          apiVersion: source.manifest.apiVersion,
          status,
          manifest: source.manifest,
          ...(detail ? { detail } : {}),
        });
      };
      if (!source.manifest.enabled) {
        report("disabled", "Disabled by plugin manifest");
        log(
          `skipping plugin at ${source.root}: Disabled by plugin manifest`,
        );
        continue;
      }
      const compatibility = evaluatePluginCompatibility(
        source.manifest,
        opts.hostContract,
      );
      if (!compatibility.compatible) {
        report("incompatible", compatibility.detail);
        log(
          `skipping plugin at ${source.root}: ${compatibility.detail ?? "Incompatible plugin"}`,
        );
        continue;
      }

      const materializer =
        source.manifest.extensions?.["dev.pizzabot.materializer"];
      let loadRoot = source.root;
      if (materializer) {
        if (!opts.materializationCacheDir) {
          materializations[source.manifest.name] = {
            state: "error",
            sourceRoots: materializer.sourceRoots,
            detail: "Plugin materialization cache is not configured",
          };
          report("failed", "Plugin materialization cache is not configured");
          continue;
        }
        const result = await materializePlugin({
          pluginRoot: source.root,
          manifest: source.manifest,
          cacheRoot: opts.materializationCacheDir,
          reason: opts.materializationReason ?? "startup",
        });
        materializations[source.manifest.name] = result.status;
        if (!result.root) {
          log(
            `materializer for "${source.manifest.name}" failed: ${result.status.detail ?? "unknown error"}`,
          );
          report(
            "failed",
            result.status.detail ?? "Plugin materialization failed",
          );
          continue;
        }
        loadRoot = result.root;
        if (result.status.state === "stale") {
          log(
            `materializer for "${source.manifest.name}" failed; using last good snapshot: ${result.status.detail ?? "unknown error"}`,
          );
        }
      }
      try {
        const loadManifest = materializer
          ? await loader.readManifest(
              join(loadRoot, ".claude-plugin", "plugin.json"),
            )
          : source.manifest;
        await loader.load(loadManifest, loadRoot, registry);
        report("loaded");
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        report("failed", detail);
        log(
          `skipping plugin at ${source.root}: ${detail}`,
        );
      }
    }
  }

  const skills = await loadSkillCatalog(registry, log);

  const pluginEntries = mcpEntriesFromRegistry(registry);
  const mergedEntries = { ...pluginEntries, ...(opts.extraMcpServers ?? {}) };
  if (opts.connectMcp === false) {
    for (const [server, entry] of Object.entries(mergedEntries)) {
      if (entry.enabled === false) continue;
      opts.onMcpStatus?.({ server, status: "loading", attempt: 1 });
    }
    return {
      registry,
      pluginReports,
      tools: {},
      catalog: {},
      skills,
      materializations,
    };
  }
  const { client, tools, catalog } = await connectMcpServers(
    mergedEntries,
    nodePath,
    log,
    opts.mcpStderr,
    opts.extraEnv,
    {
      ...(opts.mcpMaxAttempts ? { maxAttempts: opts.mcpMaxAttempts } : {}),
      ...(opts.mcpRetryDelayMs !== undefined ? { retryDelayMs: opts.mcpRetryDelayMs } : {}),
      ...(opts.mcpStartupConcurrency ? { concurrency: opts.mcpStartupConcurrency } : {}),
      ...(opts.mcpConnectionTimeoutMs ? { connectionTimeoutMs: opts.mcpConnectionTimeoutMs } : {}),
      ...(opts.onMcpStatus ? { onStatus: opts.onMcpStatus } : {}),
    },
  );

  return {
    registry,
    pluginReports,
    tools,
    catalog,
    skills,
    materializations,
    ...(client ? { client } : {}),
  };
}

export interface McpConnectResult {
  client?: McpClientPool;
  tools: Record<string, StructuredToolInterface>;
  catalog: ToolCatalog;
  errors: Record<string, string>;
}

async function withTimeout<T>(operation: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error(`connection timed out after ${timeoutMs}ms`)),
          timeoutMs,
        );
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function runWithConcurrency<T>(
  values: readonly T[],
  concurrency: number,
  run: (value: T) => Promise<void>,
): Promise<void> {
  let next = 0;
  const workers = Array.from(
    { length: Math.min(values.length, Math.max(1, concurrency)) },
    async () => {
      while (next < values.length) {
        const value = values[next++]!;
        await run(value);
      }
    },
  );
  await Promise.all(workers);
}

/**
 * Tool names remain unprefixed; the separate catalog preserves server ownership.
 * Failed servers are skipped, and the caller owns the returned client's lifecycle.
 */
export async function connectMcpServers(
  entries: Record<string, McpServerEntry>,
  nodePath: string | undefined,
  log: (msg: string) => void = () => {},
  stderr: "inherit" | "pipe" = "inherit",
  extraEnv?: Record<string, string>,
  options: McpConnectOptions = {},
): Promise<McpConnectResult> {
  const mcpConnections = toMcpConnections(
    entries,
    nodePath,
    log,
    stderr,
    extraEnv,
    options.electronRunAsNode ?? false,
  );
  const tools: Record<string, StructuredToolInterface> = {};
  const catalog: ToolCatalog = {};
  const errors: Record<string, string> = {};

  for (const [server, entry] of Object.entries(entries)) {
    if (entry.enabled === false) continue;
    if (server in mcpConnections) continue;
    const detail = "server command could not be resolved";
    errors[server] = detail;
    options.onStatus?.({ server, status: "error", attempt: 1, detail });
  }

  if (Object.keys(mcpConnections).length === 0) return { tools, catalog, errors };

  const maxAttempts = Math.max(1, options.maxAttempts ?? 2);
  const retryDelayMs = Math.max(0, options.retryDelayMs ?? 250);
  const concurrency = Math.max(1, options.concurrency ?? 3);
  const connectionTimeoutMs = Math.max(1, options.connectionTimeoutMs ?? 20_000);
  const connectedClients = new Map<string, MultiServerMCPClient>();
  await runWithConcurrency(
    Object.entries(mcpConnections),
    concurrency,
    async ([server, connection]) => {
      let lastError = "connection failed";
      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        options.onStatus?.({
          server,
          status: attempt === 1 ? "loading" : "retrying",
          attempt,
          ...(attempt > 1 ? { detail: lastError } : {}),
        });
        let connectionError: unknown;
        const client = new MultiServerMCPClient({
          mcpServers: { [server]: connection },
          // MCP names are globally flat inside LangChain/Deep Agents. Keep the
          // server prefix on executable tools while the catalog retains the
          // original names used by mcp:<server>:<tool> configuration refs.
          prefixToolNameWithServerName: true,
          additionalToolNamePrefix: "",
          throwOnLoadError: false,
          onConnectionError: ({ error }) => {
            connectionError = error;
          },
          useStandardContentBlocks: true,
        });
        try {
          const byServer = (await withTimeout(
            client.initializeConnections(),
            connectionTimeoutMs,
          )) as Record<string, StructuredToolInterface[]>;
          const serverTools = byServer[server];
          if (serverTools) {
            const sourceSchemas = await withTimeout(
              listMcpToolSchemas(client, server),
              connectionTimeoutMs,
            );
            connectedClients.set(server, client);
            const prefix = `${server}__`;
            const originalNames = serverTools.map((tool) =>
              tool.name.startsWith(prefix) ? tool.name.slice(prefix.length) : tool.name
            );
            catalog[server] = originalNames;
            for (const [index, tool] of serverTools.entries()) {
              const originalName = originalNames[index]!;
              const sourceSchema = sourceSchemas.get(originalName);
              if (sourceSchema) {
                (tool as { schema: unknown }).schema = restoreFlattenedUnions(
                  tool.schema,
                  sourceSchema,
                );
              }
              // Without this, a rejected call reaches the model as a bare "did not match
              // expected schema" and it can only guess, so it retries identical arguments.
              (tool as unknown as { verboseParsingErrors: boolean }).verboseParsingErrors = true;
              // Bedrock rejects the entire request if any tool description is blank.
              if (
                typeof tool.description !== "string" ||
                tool.description.trim().length === 0
              ) {
                log(
                  `MCP tool "${originalName}" (server "${server}") has an empty description — backfilling with its name`,
                );
                (tool as { description: string }).description = originalName;
              }
              tools[`mcp:${server}:${originalName}`] = instrumentMcpTool(
                tool,
                server,
                originalName,
              );
            }
            options.onStatus?.({
              server,
              status: "connected",
              attempt,
              toolCount: serverTools.length,
            });
            log(
              `MCP server "${server}" → ${serverTools.length} tool(s): ${originalNames.join(", ")}`,
            );
            options.onProgress?.({
              connectedServer: server,
              tools: { ...tools },
              catalog: Object.fromEntries(
                Object.entries(catalog).map(([name, names]) => [name, [...names]]),
              ),
            });
            return;
          }
          lastError =
            connectionError instanceof Error
              ? connectionError.message
              : connectionError
                ? String(connectionError)
                : "server did not return a connected client";
        } catch (err) {
          lastError = err instanceof Error ? err.message : String(err);
        }
        await client.close().catch(() => {});
        if (attempt < maxAttempts && retryDelayMs > 0) {
          await new Promise((resolve) => setTimeout(resolve, retryDelayMs * attempt));
        }
      }
      errors[server] = lastError;
      options.onStatus?.({ server, status: "error", attempt: maxAttempts, detail: lastError });
      log(`MCP server "${server}" failed after ${maxAttempts} attempt(s): ${lastError}`);
    },
  );

  const client = connectedClients.size > 0 ? new McpClientPool(connectedClients) : undefined;
  return { ...(client ? { client } : {}), tools, catalog, errors };
}

async function listMcpToolSchemas(
  client: MultiServerMCPClient,
  server: string,
): Promise<Map<string, unknown>> {
  const connected = await client.getClient(server) as ToolListingClient | undefined;
  const schemas = new Map<string, unknown>();
  if (!connected) return schemas;

  let cursor: string | undefined;
  do {
    const page = await connected.listTools(cursor ? { cursor } : undefined);
    for (const tool of page.tools ?? []) {
      if (tool.name && tool.inputSchema) schemas.set(tool.name, tool.inputSchema);
    }
    cursor = page.nextCursor;
  } while (cursor);
  return schemas;
}

function instrumentMcpTool(
  tool: StructuredToolInterface,
  server: string,
  toolName: string,
): StructuredToolInterface {
  const logger = getLogger("mcp-tool");
  const toolRef = `mcp:${server}:${toolName}`;
  return new Proxy(tool, {
    get(target, property, receiver) {
      if (property !== "invoke" && property !== "call") {
        return Reflect.get(target, property, receiver);
      }
      const original = Reflect.get(target, property, target) as (...args: unknown[]) => Promise<unknown>;
      return async (...args: unknown[]) => {
        const startedAt = performance.now();
        logger.info("MCP tool call started", {
          event: "mcp.tool.started",
          mcpServer: server,
          mcpTool: toolName,
          toolRef,
        });
        try {
          const result = await withLogContext(
            { mcpServer: server, mcpTool: toolName, toolRef },
            () => original.apply(target, args),
          );
          logger.info("MCP tool call completed", {
            event: "mcp.tool.completed",
            mcpServer: server,
            mcpTool: toolName,
            toolRef,
            durationMs: Math.round(performance.now() - startedAt),
          });
          return result;
        } catch (error) {
          logger.error("MCP tool call failed", error, {
            event: "mcp.tool.failed",
            mcpServer: server,
            mcpTool: toolName,
            toolRef,
            durationMs: Math.round(performance.now() - startedAt),
          });
          throw error;
        }
      };
    },
  });
}

export function mcpEntriesFromRegistry(registry: ContributionRegistry): Record<string, McpServerEntry> {
  const out: Record<string, McpServerEntry> = {};
  for (const [server, contribution] of registry.mcpServers) out[server] = contribution.value;
  return out;
}

/**
 * Unresolvable node-family stdio commands are logged and omitted instead of
 * failing later with `ENOENT`.
 */
function toMcpConnections(
  entries: Record<string, McpServerEntry>,
  nodePath: string | undefined,
  log: (msg: string) => void,
  stderr: "inherit" | "pipe",
  extraEnv?: Record<string, string>,
  electronRunAsNode = false,
): Record<string, Connection> {
  const out: Record<string, Connection> = {};
  for (const [server, entry] of Object.entries(entries)) {
    if (entry.enabled === false) continue;
    const connection = toConnection(
      entry,
      server,
      nodePath,
      log,
      stderr,
      extraEnv,
      electronRunAsNode,
    );
    if (connection) out[server] = connection;
  }
  return out;
}

/**
 * Stdio commands use the selected Node runtime and prepend its directory to the
 * child PATH. A `null` result tells the caller to skip the server.
 */
function toConnection(
  entry: McpServerEntry,
  server: string,
  nodePath: string | undefined,
  log: (msg: string) => void,
  stderr: "inherit" | "pipe",
  extraEnv?: Record<string, string>,
  electronRunAsNode = false,
): Connection | null {
  if ("command" in entry) {
    const resolved = resolveMcpCommand(entry.command, { ...(nodePath ? { nodePath } : {}) });
    if (!resolved) {
      log(
        `MCP server "${server}": no Node runtime found for command "${entry.command}" — skipping. ` +
          `Install Node or set PIZZA_MCP_NODE_PATH / PIZZA_NODE_PATH.`,
      );
      return null;
    }
    // The executable's required launch mode overrides user-provided MCP env.
    const baseEnv: Record<string, string> | undefined =
      extraEnv || entry.env || electronRunAsNode
        ? {
            ...extraEnv,
            ...entry.env,
            ...(electronRunAsNode && isNodeFamilyCommand(entry.command)
              ? { ELECTRON_RUN_AS_NODE: "1" }
              : {}),
          }
        : undefined;
    const env =
      resolved.pathDir !== undefined
        ? { ...baseEnv, PATH: prependPath(resolved.pathDir, baseEnv?.PATH ?? process.env.PATH) }
        : baseEnv;
    return {
      transport: "stdio",
      command: resolved.command,
      args: entry.args ?? [],
      ...(env ? { env } : {}),
      ...(entry.cwd ? { cwd: entry.cwd } : {}),
      stderr,
    };
  }
  return {
    transport: entry.type === "sse" ? "sse" : "http",
    url: entry.url,
    ...(entry.headers ? { headers: entry.headers } : {}),
  } as Connection;
}
