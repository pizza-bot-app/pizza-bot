/** HTTP client for API server operations. */
import { createParser } from "eventsource-parser";
import type {
  ThreadState,
  Checkpoint,
  TriggerDef,
  AppSettings,
  AppSettingsPatch,
  AttachmentMeta,
  ModelCatalogStatus,
  ProviderAuthMethod,
  SkillInterruptOn,
} from "@pizza-bot/core";
import type { ThreadStateValues } from "@pizza-bot/core";
import {
  threadStateWireSchema,
  updateStateWireSchema,
  type ThreadStateWire,
} from "@pizza-bot/core";

export interface ApiClientOptions {
  baseUrl: string;
  headers?: Record<string, string>;
  fetch?: typeof fetch;
}

const SSE_IDLE_TIMEOUT_MS = 45_000;
const SSE_CONNECT_TIMEOUT_MS = 10_000;
const STATUS_REQUEST_TIMEOUT_MS = 10_000;

/** Consistent error for any non-2xx server response. */
export class ApiError extends Error {
  constructor(
    readonly action: string,
    readonly status: number,
    readonly statusText: string,
    detail?: string,
  ) {
    super(`${action} failed: ${status} ${detail ?? statusText}`);
    this.name = "ApiError";
  }
}

interface RequestInitLike {
  method?: string;
  body?: unknown;
  headers?: Record<string, string>;
  keepalive?: boolean;
}

export class ApiClient {
  private readonly baseUrl: string;
  private readonly headers: Record<string, string>;
  private readonly doFetch: typeof fetch;

  constructor(opts: ApiClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/$/, "");
    this.headers = opts.headers ?? {};
    // Browser fetch requires a global receiver; an unbound reference can throw
    // "Illegal invocation". Custom fetch implementations retain their receiver.
    this.doFetch = opts.fetch ?? globalThis.fetch.bind(globalThis);
  }

  /**
   * The single request path: encodes JSON bodies, forwards auth headers, and
   * throws {@link ApiError} on any non-2xx so a failure is never mistaken for an
   * empty-but-successful response.
   */
  private async send(action: string, path: string, init: RequestInitLike = {}): Promise<Response> {
    const isForm = init.body instanceof FormData;
    const headers: Record<string, string> = {
      ...(init.body !== undefined && !isForm ? { "content-type": "application/json" } : {}),
      ...this.headers,
      ...init.headers,
    };
    const res = await this.doFetch(`${this.baseUrl}${path}`, {
      method: init.method,
      headers,
      body:
        init.body === undefined
          ? undefined
          : isForm
            ? (init.body as FormData)
            : JSON.stringify(init.body),
      ...(init.keepalive ? { keepalive: true } : {}),
    });
    if (!res.ok) throw await apiError(action, res);
    return res;
  }

  private async json<T>(action: string, path: string, init?: RequestInitLike): Promise<T> {
    return (await (await this.send(action, path, init)).json()) as T;
  }

  /** 404 resolves to undefined (absent resource); any other failure throws. */
  private async optional<T>(
    action: string,
    path: string,
    timeoutMs?: number,
  ): Promise<T | undefined> {
    const url = `${this.baseUrl}${path}`;
    const init = { headers: this.headers };
    const res =
      timeoutMs === undefined
        ? await this.doFetch(url, init)
        : await fetchWithTimeout(this.doFetch, url, init, timeoutMs);
    if (res.status === 404) return undefined;
    if (!res.ok) throw await apiError(action, res);
    return (await res.json()) as T;
  }

  async getState(threadId: string, checkpointId?: string): Promise<ThreadState> {
    const q = checkpointId ? `?checkpoint_id=${encodeURIComponent(checkpointId)}` : "";
    const res = await this.send("get state", `/threads/${encodeURIComponent(threadId)}/state${q}`);
    return fromWireState(decode(threadStateWireSchema, await res.json(), "getState"));
  }

  async stopRun(threadId: string): Promise<void> {
    await this.send("stop run", `/threads/${encodeURIComponent(threadId)}/commands`, {
      method: "POST",
      body: { id: Date.now(), method: "run.stop", params: {} },
    });
  }

  async *getStateHistory(threadId: string): AsyncIterable<ThreadState> {
    const res = await this.send("get state history", `/threads/${encodeURIComponent(threadId)}/history`);
    const list = decode(threadStateWireSchema.array(), await res.json(), "getStateHistory");
    for (const s of list) yield fromWireState(s);
  }

  async updateState(threadId: string, values: unknown, asNode?: string): Promise<Checkpoint> {
    const body = decode(
      updateStateWireSchema,
      await this.json("update state", `/threads/${encodeURIComponent(threadId)}/state`, {
        method: "POST",
        body: { values, ...(asNode ? { as_node: asNode } : {}) },
      }),
      "updateState",
    );
    return { checkpointId: body.checkpoint_id, threadId: body.thread_id };
  }

  async listThreads(): Promise<ThreadInfo[]> {
    return this.json("list threads", "/threads/list");
  }

  async watchThreadChanges(
    signal: AbortSignal,
    handlers: { onReady: () => void; onChange: () => void },
  ): Promise<void> {
    const res = await fetchWithTimeout(
      this.doFetch,
      `${this.baseUrl}/threads/events`,
      {
        headers: { accept: "text/event-stream", ...this.headers },
      },
      SSE_CONNECT_TIMEOUT_MS,
      signal,
    );
    if (!res.ok) throw await apiError("watch thread changes", res);
    if (!res.body) throw new Error("watch thread changes failed: response has no body");

    const parser = createParser({
      maxBufferSize: 64 * 1024,
      onEvent: (event) => {
        if (event.event === "ready") handlers.onReady();
        else if (event.event === "changed") handlers.onChange();
      },
    });
    await consumeSseBody(res.body, signal, (chunk) => parser.feed(chunk));
  }

  /** Returns undefined only when the server has no status yet (404). */
  async getStatus(): Promise<StatusInfo | undefined> {
    return this.optional(
      "get status",
      "/status",
      STATUS_REQUEST_TIMEOUT_MS,
    );
  }

  async listLogs(query: LogQueryParams = {}): Promise<LogQueryResult> {
    return this.json("list logs", `/logs${logQuerySuffix(query, true)}`);
  }

  async downloadLogs(query: LogQueryParams = {}): Promise<Blob> {
    return (await this.send("download logs", `/logs/download${logQuerySuffix(query, false)}`)).blob();
  }

  async clearLogs(): Promise<{ deleted: number }> {
    return this.json("clear logs", "/logs", { method: "DELETE" });
  }

  async listModels(includeDisabled = false, refresh = false): Promise<ModelsInfo> {
    const query = new URLSearchParams();
    if (includeDisabled) query.set("include_disabled", "true");
    if (refresh) query.set("refresh", "true");
    return this.json("list models", `/models${query.size > 0 ? `?${query}` : ""}`);
  }

  async listTools(): Promise<ToolCatalogInfo> {
    return this.json("list tools", "/tools");
  }

  async listSkills(): Promise<SkillCatalogInfo> {
    return this.json("list skills", "/skills");
  }

  /** Returns undefined for unknown IDs. */
  async getSkill(id: string): Promise<SkillBundle | undefined> {
    return this.optional("get skill", `/skills/${encodeURIComponent(id)}`);
  }

  async createSkill(bundle: SkillBundle): Promise<SkillBundle> {
    return this.json("create skill", "/skills", { method: "POST", body: bundle });
  }

  /** Imports an Agent Skills bundle from ZIP as a custom skill. */
  async importSkill(file: File): Promise<SkillBundle> {
    const form = new FormData();
    form.set("file", file);
    return this.json("import skill", "/skills/import", { method: "POST", body: form });
  }

  /** Replaces the complete bundle except its immutable ID. */
  async updateSkill(id: string, bundle: SkillBundle): Promise<SkillBundle> {
    return this.json("update skill", `/skills/${encodeURIComponent(id)}`, { method: "PATCH", body: bundle });
  }

  async setSkillEnabled(id: string, enabled: boolean): Promise<SkillCatalogEntryInfo> {
    return this.json("update skill enablement", `/skills/${encodeURIComponent(id)}/enabled`, {
      method: "PUT",
      body: { enabled },
    });
  }

  async deleteSkill(id: string): Promise<boolean> {
    return deletedFlag(await this.json("delete skill", `/skills/${encodeURIComponent(id)}`, { method: "DELETE" }));
  }

  /** Drafts a skill from a natural-language description. */
  async generateSkill(prompt: string): Promise<SkillDraft> {
    return this.json("generate skill", "/skills/generate", { method: "POST", body: { prompt } });
  }

  async listMcpServers(): Promise<McpServerRow[]> {
    return (await this.json<{ servers: McpServerRow[] }>("list mcp servers", "/mcp-servers")).servers;
  }

  /** Returns undefined for plugin or unknown IDs. */
  async getMcpServer(id: string): Promise<McpServerDoc | undefined> {
    return this.optional("get mcp server", `/mcp-servers/${encodeURIComponent(id)}`);
  }

  /** Returns after reconnection completes. */
  async createMcpServer(id: string, entry: McpServerEntryWire): Promise<McpServerRow> {
    return this.json("create mcp server", "/mcp-servers", { method: "POST", body: { id, ...entry } });
  }

  async updateMcpServer(id: string, entry: McpServerEntryWire): Promise<McpServerRow> {
    return this.json("update mcp server", `/mcp-servers/${encodeURIComponent(id)}`, { method: "PATCH", body: entry });
  }

  async setMcpServerEnabled(id: string, enabled: boolean): Promise<McpServerRow> {
    return this.json("update MCP server enablement", `/mcp-servers/${encodeURIComponent(id)}/enabled`, {
      method: "PUT",
      body: { enabled },
    });
  }

  async reconnectMcpServer(id: string): Promise<McpServerRow> {
    return this.json(
      "reconnect MCP server",
      `/mcp-servers/${encodeURIComponent(id)}/reconnect`,
      { method: "POST" },
    );
  }

  async deleteMcpServer(id: string): Promise<boolean> {
    return deletedFlag(
      await this.json("delete mcp server", `/mcp-servers/${encodeURIComponent(id)}`, { method: "DELETE" }),
    );
  }

  async listPlugins(): Promise<PluginInfo[]> {
    return (await this.json<PluginsResponse>("list plugins", "/plugins")).plugins;
  }

  /** Installs a plugin ZIP into the writable install dir and reloads it live. */
  async importPlugin(file: File): Promise<{ name: string }> {
    const form = new FormData();
    form.set("file", file);
    return this.json("import plugin", "/plugins/import", { method: "POST", body: form });
  }

  /** Removes a user-installed plugin. Shipped and external plugins are not removable. */
  async deletePlugin(name: string): Promise<boolean> {
    return deletedFlag(
      await this.json("delete plugin", `/plugins/${encodeURIComponent(name)}`, { method: "DELETE" }),
    );
  }

  /** Re-discovers plugins and reconnects their MCP servers after an atomic install. */
  async reloadPlugins(): Promise<void> {
    await this.send("reload plugins", "/plugins/reload", { method: "POST" });
  }

  async refreshPlugin(name: string): Promise<void> {
    await this.send(
      "refresh plugin",
      `/plugins/${encodeURIComponent(name)}/refresh`,
      { method: "POST" },
    );
  }

  async listMemories(): Promise<MemoryInfo[]> {
    return (await this.json<{ memories: MemoryInfo[] }>("list memories", "/memories")).memories;
  }

  /** Returns undefined for unknown IDs. */
  async getMemory(id: string): Promise<MemoryDoc | undefined> {
    return this.optional("get memory", `/memories/${encodeURIComponent(id)}`);
  }

  async createMemory(id: string, content: string): Promise<MemoryDoc> {
    return this.json("create memory", "/memories", { method: "POST", body: { id, content } });
  }

  async updateMemory(id: string, content: string): Promise<MemoryDoc> {
    return this.json("update memory", `/memories/${encodeURIComponent(id)}`, { method: "PUT", body: { content } });
  }

  async deleteMemory(id: string): Promise<boolean> {
    return deletedFlag(await this.json("delete memory", `/memories/${encodeURIComponent(id)}`, { method: "DELETE" }));
  }

  async listTriggers(): Promise<TriggerDef[]> {
    return this.json("list triggers", "/triggers");
  }

  /** Returns undefined for missing triggers. */
  async getTrigger(id: string): Promise<TriggerDef | undefined> {
    return this.optional("get trigger", `/triggers/${encodeURIComponent(id)}`);
  }

  /** The server schedules the trigger before responding. */
  async createTrigger(def: Partial<TriggerDef>): Promise<TriggerDef> {
    return this.json("create trigger", "/triggers", { method: "POST", body: def });
  }

  /** Reschedules before responding. */
  async updateTrigger(id: string, patch: Partial<TriggerDef>): Promise<TriggerDef> {
    return this.json("update trigger", `/triggers/${encodeURIComponent(id)}`, { method: "PATCH", body: patch });
  }

  async deleteTrigger(id: string): Promise<boolean> {
    return deletedFlag(await this.json("delete trigger", `/triggers/${encodeURIComponent(id)}`, { method: "DELETE" }));
  }

  /** Uses the externally exposed, secret-guarded webhook path. */
  async invokeTrigger(
    id: string,
    secret: string,
    body: unknown = {},
  ): Promise<{ runId: string; threadId: string; status: string }> {
    return toRunIds(
      await this.json("invoke trigger", `/triggers/${encodeURIComponent(id)}/invoke`, {
        method: "POST",
        headers: { "x-trigger-secret": secret },
        body,
      }),
    );
  }

  /** Uses the local authenticated path and deliberately omits the webhook secret. */
  async runTrigger(id: string): Promise<{ runId: string; threadId: string; status: string }> {
    return toRunIds(
      await this.json("run trigger", `/triggers/${encodeURIComponent(id)}/run`, { method: "POST", body: {} }),
    );
  }

  /** Returns highlighted FTS hits. */
  async searchMessages(query: string, limit = 50): Promise<SearchHit[]> {
    return this.json("search messages", `/threads/search?q=${encodeURIComponent(query)}&limit=${limit}`);
  }

  /**
   * Prefer the stable message ID. The raw-history index supports freshly streamed
   * messages whose persistent ID is not yet available.
   */
  async forkThread(
    threadId: string,
    target: { messageId?: string; messageIndex?: number; title?: string },
  ): Promise<ThreadInfo> {
    return this.json("fork thread", `/threads/${encodeURIComponent(threadId)}/fork`, { method: "POST", body: target });
  }

  async setThreadPinned(threadId: string, pinned: boolean): Promise<ThreadInfo> {
    return this.json("pin thread", `/threads/${encodeURIComponent(threadId)}`, { method: "PATCH", body: { pinned } });
  }

  async setThreadTitle(threadId: string, title: string): Promise<ThreadInfo> {
    return this.json("rename thread", `/threads/${encodeURIComponent(threadId)}`, { method: "PATCH", body: { title } });
  }

  async markThreadRead(threadId: string): Promise<ThreadInfo> {
    return this.json("mark thread read", `/threads/${encodeURIComponent(threadId)}`, {
      method: "PATCH",
      body: { unread: false },
    });
  }

  async deleteThread(threadId: string): Promise<boolean> {
    return deletedFlag(
      await this.json("delete thread", `/threads/${encodeURIComponent(threadId)}`, { method: "DELETE" }),
    );
  }

  /**
   * Returns a durable `attachment://<id>` reference. Rejected size or MIME type
   * responses throw so callers can surface the upload failure.
   */
  async uploadAttachment(file: File, threadId?: string): Promise<AttachmentMeta> {
    const form = new FormData();
    form.set("file", file);
    if (threadId) form.set("thread_id", threadId);
    return this.json("upload attachment", "/attachments", { method: "POST", body: form });
  }

  async deleteAttachment(id: string): Promise<boolean> {
    return deletedFlag(
      await this.json("delete attachment", `/attachments/${encodeURIComponent(id)}`, { method: "DELETE" }),
    );
  }

  async fetchAttachment(id: string): Promise<Blob> {
    return (await this.send("download attachment", `/attachments/${encodeURIComponent(id)}`)).blob();
  }

  attachmentSrc(id: string): string {
    return `${this.baseUrl}/attachments/${encodeURIComponent(id)}`;
  }

  /** Returns undefined only when settings have never been written (404). */
  async getSettings(): Promise<AppSettings | undefined> {
    return this.optional("get settings", "/settings");
  }

  async updateSettings(patch: AppSettingsPatch): Promise<AppSettings> {
    return this.json("update settings", "/settings", { method: "PUT", body: patch, keepalive: true });
  }

  /** Secret values are redacted. */
  async listProviders(): Promise<ProviderView[]> {
    return (await this.json<{ providers: ProviderView[] }>("list providers", "/providers")).providers;
  }

  /**
   * Secret fields accept an `${ENV_REF}` name or {@link SECRET_UNCHANGED}, never
   * a raw credential.
   */
  async updateProvider(
    id: string,
    config: { method: string; values: Record<string, string> },
  ): Promise<ProviderConfigView> {
    return this.json("update provider", `/providers/${encodeURIComponent(id)}`, { method: "PUT", body: config });
  }

  async deleteProvider(id: string): Promise<boolean> {
    return (
      (await this.json("delete provider", `/providers/${encodeURIComponent(id)}`, { method: "DELETE" })) as {
        ok: boolean;
      }
    ).ok;
  }

  async updateProviderModels(
    id: string,
    preferences: ProviderModelPreferences,
  ): Promise<ProviderModelPreferences> {
    return this.json("update provider models", `/providers/${encodeURIComponent(id)}/models`, {
      method: "PUT",
      body: preferences,
    });
  }

  /** Returns null when no default model is set. */
  async getDefaultModel(): Promise<string | null> {
    const body = await this.optional<{ default: string | null }>("get default model", "/providers/default");
    return body?.default ?? null;
  }

  async setDefaultModel(model: string | null): Promise<string | null> {
    return (
      (await this.json("set default model", "/providers/default", { method: "PUT", body: { default: model } })) as {
        default: string | null;
      }
    ).default;
  }
}

async function fetchWithTimeout(
  doFetch: typeof fetch,
  url: string,
  init: RequestInit,
  timeoutMs: number,
  parentSignal?: AbortSignal,
): Promise<Response> {
  const ac = new AbortController();
  const onAbort = () => ac.abort(parentSignal?.reason);
  if (parentSignal?.aborted) onAbort();
  else parentSignal?.addEventListener("abort", onAbort, { once: true });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      ac.abort();
      reject(new Error(`request timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    (timer as { unref?: () => void }).unref?.();
  });
  try {
    return await Promise.race([
      doFetch(url, { ...init, signal: ac.signal }),
      timeout,
    ]);
  } finally {
    if (timer) clearTimeout(timer);
    parentSignal?.removeEventListener("abort", onAbort);
  }
}

async function consumeSseBody(
  body: ReadableStream<Uint8Array>,
  signal: AbortSignal,
  feed: (chunk: string) => void,
): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const onAbort = () => {
    void reader.cancel().catch(() => {});
  };
  if (signal.aborted) onAbort();
  else signal.addEventListener("abort", onAbort, { once: true });
  try {
    while (true) {
      const { done, value } = await readSseChunk(reader);
      if (done) break;
      feed(decoder.decode(value, { stream: true }));
    }
    feed(decoder.decode());
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  } finally {
    signal.removeEventListener("abort", onAbort);
    reader.releaseLock();
  }
}

async function readSseChunk(
  reader: ReadableStreamDefaultReader<Uint8Array>,
): Promise<ReadableStreamReadResult<Uint8Array>> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () =>
        reject(
          new Error(
            `SSE stream received no data for ${SSE_IDLE_TIMEOUT_MS}ms`,
          ),
        ),
      SSE_IDLE_TIMEOUT_MS,
    );
    (timer as { unref?: () => void }).unref?.();
  });
  try {
    return await Promise.race([reader.read(), timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Prevents an unchanged redacted secret from being overwritten. */
export const SECRET_UNCHANGED = "__unchanged__";

async function apiError(action: string, res: Response): Promise<ApiError> {
  const detail = await res
    .clone()
    .json()
    .then((body: unknown) => {
      if (body && typeof body === "object") {
        const b = body as { detail?: string; error?: string; message?: string };
        return b.detail ?? b.message ?? b.error;
      }
      return undefined;
    })
    .catch(() => undefined);
  return new ApiError(action, res.status, res.statusText, detail);
}

function deletedFlag(body: unknown): boolean {
  return (body as { deleted: boolean }).deleted;
}

function toRunIds(body: unknown): { runId: string; threadId: string; status: string } {
  const j = body as { run_id: string; thread_id: string; status: string };
  return { runId: j.run_id, threadId: j.thread_id, status: j.status };
}

function logQuerySuffix(query: LogQueryParams, includePaging: boolean): string {
  const params = new URLSearchParams();
  if (query.levels?.length) params.set("levels", query.levels.join(","));
  if (query.processes?.length) params.set("processes", query.processes.join(","));
  if (query.components?.length) params.set("components", query.components.join(","));
  if (query.search) params.set("search", query.search);
  if (includePaging && query.since) params.set("since", query.since);
  if (includePaging && query.limit !== undefined) params.set("limit", String(query.limit));
  return params.size > 0 ? `?${params}` : "";
}

export interface ThreadInfo {
  threadId: string;
  title: string;
  source: "user" | "trigger" | "fork";
  pinned: boolean;
  /**
   * Server-managed unread state is independent of client-only running state.
   */
  unread: boolean;
  awaitingAction: boolean;
  createdAt: string;
  lastActivityAt: string;
  parentThreadId?: string;
  parentCheckpointId?: string;
  modelId?: string;
  lastMessage?: string;
  lastMessageRole?: string;
}

export interface StatusInfo {
  model: string;
  timezone: string;
  contextWindow?: number;
  inference: {
    available: boolean;
    connected: number;
    total: number;
    providers: Array<{
      name: string;
      status: "connected" | "unavailable";
      modelCount: number;
    }>;
  };
  mcp: {
    available: boolean;
    loaded: number;
    total: number;
    disabled: number;
    servers: Array<{
      name: string;
      status: "loading" | "retrying" | "loaded" | "error" | "crashed" | "disabled";
      toolCount: number;
      crashedAt?: string;
      detail?: string;
      stderrTail?: string[];
    }>;
  };
  timestamp: string;
}

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface LogRecord {
  id: string;
  timestamp: string;
  level: LogLevel;
  process: string;
  pid: number;
  component: string;
  event?: string;
  message: string;
  error?: {
    name: string;
    message: string;
    stack?: string;
    code?: string;
    cause?: unknown;
  };
  context?: Record<string, unknown>;
}

export interface LogQueryParams {
  levels?: LogLevel[];
  processes?: string[];
  components?: string[];
  search?: string;
  since?: string;
  limit?: number;
}

export interface LogQueryResult {
  records: LogRecord[];
  latestTimestamp?: string;
  truncated: boolean;
}

export interface ToolCatalogInfo {
  builtins: Array<{ ref: string; name: string }>;
  servers: Array<{
    server: string;
    wildcard: string;
    tools: Array<{ ref: string; name: string }>;
  }>;
}

export interface SkillCatalogEntryInfo {
  id: string;
  name: string;
  description: string;
  source: "plugin" | "builtin" | "user";
  overrides?: "plugin" | "builtin";
  pluginName?: string;
  declaredTools: string[];
  enabled: boolean;
  status: "disabled" | "loading" | "ready" | "unavailable";
  statusDetail?: string;
  mcpDependencies: Array<{
    id: string;
    enabled: boolean;
    status: McpServerRow["status"] | "missing";
  }>;
}

export interface SkillCatalogInfo {
  skills: SkillCatalogEntryInfo[];
}

export interface SkillSiblingFile {
  path: string;
  /** Binary resources are base64-encoded on the JSON wire. */
  content: string;
  encoding?: "base64";
  mimeType?: string;
}

/**
 * Name, description, body, and declared tools compose `SKILL.md`; `files`
 * contains sibling resources. Editing a built-in or plugin bundle creates a
 * user override.
 */
export interface SkillBundle {
  id: string;
  name: string;
  description: string;
  body: string;
  files: SkillSiblingFile[];
  source: "plugin" | "builtin" | "user";
  overrides?: "plugin" | "builtin";
  pluginName?: string;
  /** Tool refs (`mcp:<server>:<tool>` / wildcard / `builtin:eval`) the skill declares. */
  declaredTools: string[];
  /** Declared tool calls that pause for a human decision before execution. */
  interruptOn: SkillInterruptOn;
}

/** A gen-AI skill draft: every editable field, pre-filtered to real tool refs. */
export interface SkillDraft {
  name: string;
  description: string;
  body: string;
  declaredTools: string[];
  interruptOn: SkillInterruptOn;
}

export type McpServerEntryWire =
  | {
      command: string;
      args?: string[];
      env?: Record<string, string>;
      cwd?: string;
      enabled?: boolean;
    }
  | {
      type?: "http" | "sse";
      url: string;
      headers?: Record<string, string>;
      enabled?: boolean;
    };

export interface McpServerRow {
  id: string;
  source: "user" | "plugin";
  pluginName?: string;
  entry: McpServerEntryWire;
  enabled: boolean;
  status: "loading" | "retrying" | "connected" | "error" | "crashed" | "disabled";
  toolCount: number;
  crashedAt?: string;
  detail?: string;
  dependentSkills: Array<{
    id: string;
    name: string;
    source: "plugin" | "builtin" | "user";
    pluginName?: string;
    enabled: boolean;
  }>;
}

export interface PluginInfo {
  name: string;
  version?: string;
  displayName?: string;
  description?: string;
  author?: string;
  homepage?: string;
  removable: boolean;
  contributions: { skills: number; mcpServers: number };
  materialization?: {
    state: "synced" | "stale" | "error";
    sourceRoots: string[];
    lastSyncedAt?: string;
    detail?: string;
  };
}

export interface PluginsResponse {
  plugins: PluginInfo[];
}

export interface McpServerDoc {
  id: string;
  source: "user";
  entry: McpServerEntryWire;
}

export interface MemoryInfo {
  id: string;
  preview: string;
  size: number;
  updatedAt: string;
}

export interface MemoryDoc {
  id: string;
  content: string;
  updatedAt?: string;
}

export interface ModelsInfo {
  models: Array<{
    id: string;
    displayName: string;
    provider: string;
    contextWindow?: number;
  }>;
  providers?: ModelCatalogStatus[];
  default: string;
}

/**
 * Password fields expose only presence; their values are never serialized.
 */
export type RedactedValue = { hasValue: boolean; available?: boolean } | string;

export interface ProviderConfigView {
  id?: string;
  method: string;
  values: Record<string, RedactedValue>;
}

export interface ProviderView {
  id: string;
  configurable: boolean;
  availableWithoutConfig: boolean;
  authSchema?: readonly ProviderAuthMethod[];
  config?: ProviderConfigView;
  modelPreferences: ProviderModelPreferences;
}

export interface ProviderModelPreferences {
  mode: "all" | "selected";
  selected: string[];
}

export interface AgentInfo {
  id: string;
  name: string;
  avatar: string;
  description: string;
  suggestedPrompts: Array<{ suggestion: string; prompt: string }>;
}

export interface SearchHit {
  threadId: string;
  messageId: string;
  role: string;
  snippet: string;
  highlights: Array<{ text: string; highlighted: boolean }>;
  rank: number;
}

/**
 * Throws at the trust boundary when a server response violates the wire schema.
 */
function decode<T>(schema: WireSchema<T>, raw: unknown, ctx: string): T {
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(`${ctx}: unexpected response shape from server: ${parsed.error.message}`);
  }
  return parsed.data;
}

/** Structural schema interface avoids a direct client dependency on Zod. */
interface WireSchema<T> {
  safeParse(
    data: unknown,
  ): { success: true; data: T } | { success: false; error: { message: string } };
}

function fromWireState(s: ThreadStateWire): ThreadState {
  return {
    threadId: s.thread_id,
    checkpointId: s.checkpoint_id,
    // The wire intentionally leaves runtime-specific checkpoint channels opaque.
    values: (s.values ?? {}) as ThreadStateValues,
    next: s.next,
    createdAt: s.created_at,
    ...(s.awaiting_input !== undefined ? { awaitingInput: s.awaiting_input } : {}),
  };
}
