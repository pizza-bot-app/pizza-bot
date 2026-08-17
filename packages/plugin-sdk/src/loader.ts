/** Loads Pizza Bot's declarative plugin contributions from the filesystem. */
import { readFile, readdir, realpath, stat } from "node:fs/promises";
import {
  basename,
  extname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import { z } from "zod";
import {
  PLUGIN_API_VERSION,
  pluginManifestHeaderSchema,
  pluginManifestSchema,
  pluginNameSchema,
  mcpServerEntrySchema,
  type PluginManifest,
  type McpServerEntry,
} from "@pizza-bot/plugin-api";
import { expandMcpEnvVars } from "./mcp-servers-config.js";
import { ContributionRegistry, type PluginLoader } from "./registry.js";

const MANIFEST_REL = ".claude-plugin/plugin.json";
const mcpServersFileSchema = z.object({
  mcpServers: z.record(z.string(), z.unknown()),
});

export interface PluginSource {
  root: string;
  manifest: PluginManifest;
}

export class UnsupportedPluginApiVersionError extends Error {
  constructor(
    readonly apiVersion: string,
    readonly pluginName?: string,
  ) {
    super(
      `Unsupported plugin API version "${apiVersion}"; this host supports "${PLUGIN_API_VERSION}"`,
    );
    this.name = "UnsupportedPluginApiVersionError";
  }
}

export class PluginPathError extends Error {
  constructor(
    readonly pluginRoot: string,
    readonly declaredPath: string,
    reason: string,
  ) {
    super(`Invalid plugin path "${declaredPath}": ${reason}`);
    this.name = "PluginPathError";
  }
}

export class FsPluginLoader implements PluginLoader {
  async find(
    pluginsDir: string,
    onError: (pluginDir: string, err: unknown) => void = (_d, e) => {
      throw e;
    },
  ): Promise<PluginSource[]> {
    const entries = await readdir(pluginsDir, { withFileTypes: true }).catch(
      () => [],
    );
    const found: PluginSource[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const root = join(pluginsDir, entry.name);
      try {
        found.push({
          root,
          manifest: await this.readManifest(join(root, MANIFEST_REL)),
        });
      } catch (err) {
        if (!isMissingFile(err)) onError(root, err);
      }
    }
    return found;
  }

  async readManifest(manifestPath: string): Promise<PluginManifest> {
    try {
      const raw = await readFile(manifestPath, "utf8");
      const value: unknown = JSON.parse(raw);
      const header = pluginManifestHeaderSchema.safeParse(value);
      if (
        header.success &&
        header.data.apiVersion !== PLUGIN_API_VERSION
      ) {
        const pluginName = pluginNameSchema.safeParse(header.data.name);
        throw new UnsupportedPluginApiVersionError(
          header.data.apiVersion,
          pluginName.success ? pluginName.data : undefined,
        );
      }
      return pluginManifestSchema.parse(value);
    } catch (err) {
      if (isMissingFile(err)) throw err;
      if (err instanceof UnsupportedPluginApiVersionError) throw err;
      throw new Error(
        `Invalid plugin manifest at ${manifestPath}: ${
          err instanceof Error ? err.message : String(err)
        }`,
        { cause: err },
      );
    }
  }

  async load(
    manifest: PluginManifest,
    root: string,
    into: ContributionRegistry,
  ): Promise<void> {
    const name = manifest.name;
    const canonicalRoot = await realpath(root);
    const staged = new ContributionRegistry();
    staged.registerPlugin(name);

    for (const path of await this.collectPaths(canonicalRoot, manifest.skills)) {
      staged.registerSkill(name, canonicalRoot, idFor(path), path);
    }

    for (const [server, entry] of await this.collectMcpServers(
      canonicalRoot,
      manifest.mcpServers,
    )) {
      staged.registerMcpServer(name, canonicalRoot, server, entry);
    }

    into.mergeFrom(staged);
  }

  /**
   * Directory contributions include immediate Markdown files and subdirectories,
   * matching the Claude Code plugin format.
   */
  private async collectPaths(
    root: string,
    spec: string | string[] | undefined,
  ): Promise<string[]> {
    if (!spec) return [];
    const specs = Array.isArray(spec) ? spec : [spec];
    const out: string[] = [];
    for (const s of specs) {
      const abs = await resolveContributionPath(root, s);
      const st = await stat(abs);
      if (st.isDirectory()) {
        const children = await readdir(abs, { withFileTypes: true });
        for (const child of children) {
          const isMarkdown = extname(child.name) === ".md";
          if (!child.isDirectory() && !child.isSymbolicLink() && !isMarkdown) {
            continue;
          }
          const unresolvedChild = join(abs, child.name);
          const unresolvedStat = await stat(unresolvedChild);
          if (!unresolvedStat.isDirectory() && !(unresolvedStat.isFile() && isMarkdown)) {
            continue;
          }
          const childAbs = await resolveContributionPath(root, unresolvedChild);
          if (unresolvedStat.isDirectory() || isMarkdown) {
            out.push(childAbs);
          }
        }
      } else if (st.isFile()) {
        out.push(abs);
      } else {
        throw new PluginPathError(root, s, "expected a file or directory");
      }
    }
    return out;
  }

  /**
   * Accepts inline entries or Claude Code's `.mcp.json` wrapper. Root and
   * environment placeholders are expanded before validation.
   */
  private async collectMcpServers(
    root: string,
    spec: string | Record<string, McpServerEntry> | undefined,
  ): Promise<Array<[string, McpServerEntry]>> {
    if (!spec) return [];
    let record: Record<string, unknown>;
    if (typeof spec === "string") {
      const abs = await resolveContributionPath(root, spec);
      await assertFile(abs, root, spec);
      const raw = await readFile(abs, "utf8");
      const parsed = mcpServersFileSchema.parse(JSON.parse(raw));
      record = parsed.mcpServers;
    } else {
      record = spec as Record<string, unknown>;
    }
    const out: Array<[string, McpServerEntry]> = [];
    for (const [server, rawEntry] of Object.entries(record)) {
      let entry = mcpServerEntrySchema.parse(
        expandMcpEnvVars(expandRootPlaceholders(rawEntry, root)),
      );
      if ("command" in entry && entry.cwd) {
        const cwd = await resolveContributionPath(root, entry.cwd);
        const cwdStat = await stat(cwd);
        if (!cwdStat.isDirectory()) {
          throw new PluginPathError(root, entry.cwd, "expected a directory");
        }
        entry = { ...entry, cwd };
      }
      out.push([server, entry]);
    }
    return out;
  }

}

/** Extensionless basenames keep contribution IDs stable across plugin roots. */
function idFor(path: string): string {
  const base = basename(path);
  const ext = extname(base);
  return ext ? base.slice(0, -ext.length) : base;
}

async function resolveContributionPath(root: string, declaredPath: string): Promise<string> {
  const expanded = expandRootString(declaredPath, root);
  const candidate = resolve(root, expanded);

  let canonical: string;
  try {
    canonical = await realpath(candidate);
  } catch (err) {
    throw new PluginPathError(
      root,
      declaredPath,
      err instanceof Error ? err.message : String(err),
    );
  }
  // Containment is checked canonical-to-canonical, and only after realpath: an
  // absolute declared path under a symlinked ancestor (macOS /var ->
  // /private/var) sits outside the raw `root` string without ever leaving the
  // plugin, and only realpath can tell that from a genuine escape.
  assertWithinRoot(await realpath(root), canonical, declaredPath);
  return canonical;
}

function assertWithinRoot(root: string, path: string, declaredPath: string): void {
  const rel = relative(root, path);
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new PluginPathError(root, declaredPath, "path escapes the plugin root");
  }
}

async function assertFile(path: string, root: string, declaredPath: string): Promise<void> {
  const st = await stat(path);
  if (!st.isFile()) {
    throw new PluginPathError(root, declaredPath, "expected a file");
  }
}

function expandRootString(s: string, root: string): string {
  return s.replace(/\$\{(?:CLAUDE_PLUGIN_ROOT|PLUGIN_ROOT)\}/g, root);
}

function expandRootPlaceholders(value: unknown, root: string): unknown {
  if (typeof value === "string") return expandRootString(value, root);
  if (Array.isArray(value)) return value.map((v) => expandRootPlaceholders(v, root));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = expandRootPlaceholders(v, root);
    return out;
  }
  return value;
}

function isMissingFile(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code?: unknown }).code === "ENOENT"
  );
}
