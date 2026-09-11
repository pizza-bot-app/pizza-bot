import {
  BUILTIN_EVAL_TOOL_REF,
  ModelRegistry,
  ModelUnavailableError,
  projectSkillReadiness,
  automaticModelCatalog,
  selectModel,
  skillMcpServerIds,
  skillInfoOf,
  type AutomaticModelCatalog,
  type McpDependencyState,
  type ProviderInfo,
  type ProviderModelPreferences,
  type ResolvedProviderConfig,
  type RunInput,
  type RunOptions,
  type RunStatus,
  type RuntimeDeps,
  type ThreadState,
  type SkillCatalog,
  type SkillCatalogEntry,
  type SkillAvailability,
  type SkillInfo,
  type ThreadActivityOutcome,
} from "@pizza-bot/core";
import { registerBuiltinProviders, UnavailableChatModel } from "@pizza-bot/inference-providers";
import type { LangGraphAgent } from "@pizza-bot/runtime-langgraph";
import type { ProtocolEvent } from "@langchain/langgraph";
import {
  openPersistence,
  openAppDatabase,
  resolveLayout,
  TriggerStore,
  ThreadStore,
  FolderStore,
  SearchStore,
  SettingsStore,
  ProviderConfigStore,
  ThreadActivityStore,
  CapabilityPreferencesStore,
  LocalFolderStore,
  RunMaintenance,
  TITLE_SYSTEM_PROMPT,
  buildTitleUserMessage,
  isDefaultTitle,
  type AppDatabase,
  type AttachmentStore,
  type IndexableMessage,
  type Persistence,
  type CapabilityPreferenceKey,
} from "@pizza-bot/storage";
import {
  loadPlugins,
  createPluginHostContract,
  loadBuiltinSkills,
  loadUserSkills,
  loadUserMcpServers,
  expandMcpEnvVars,
  mergeSkillCatalogs,
  connectMcpServers,
  mcpEntriesFromRegistry,
  type McpClientPool,
  type McpConnectResult,
  type McpConnectionEvent,
  type LoadedPlugins,
  type ToolCatalog,
} from "@pizza-bot/plugin-sdk";
import { McpHealthMonitor, type McpClientLike } from "./mcp-health-monitor.js";
import {
  pluginNameSchema,
  type McpServerEntry,
  type PluginMaterializerReason,
} from "@pizza-bot/plugin-api";
import apiPackage from "../package.json" with { type: "json" };
import {
  resolvePluginsDir,
  resolveExternalPluginsDirs,
  resolveBuiltinSkillsDir,
  resolveSkillsDir,
  resolveMemoriesDir,
  resolveMcpConfig,
} from "./plugins-dir.js";
import { mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { ProtocolRunManager } from "./protocol-run-manager.js";
import type { ImportedPlugin } from "./plugin-import.js";
import { protocolRunLauncher } from "./protocol-run-launcher.js";
import { TriggerService } from "./trigger-service.js";
import { SystemMessage, HumanMessage, type AIMessage } from "@langchain/core/messages";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { GraphManager } from "./graph-manager.js";
import {
  buildSkillGeneratorPrompt,
  normalizeSkillDraft,
  parseSkillDraftJson,
  type SkillDraft,
  type SkillGeneratorTool,
} from "./skill-generator.js";
import { getLogger, redactDiagnosticText } from "@pizza-bot/logging";

const mcpLog = getLogger("mcp");
const LAST_RESORT_MODEL = "bedrock:global.anthropic.claude-sonnet-5";
const PLUGIN_HOST_CONTRACT = createPluginHostContract(apiPackage.version);

function stateAwaitsAction(state: ThreadState): boolean {
  if (state.awaitingInput === true || (state.interrupts?.length ?? 0) > 0) {
    return true;
  }
  return (state.tasks ?? []).some((task) => task.interrupts.length > 0);
}

function interruptIdsOf(state: ThreadState): string[] {
  return [
    ...new Set([
      ...(state.interrupts ?? []).map((interrupt) => interrupt.id),
      ...(state.tasks ?? []).flatMap((task) =>
        task.interrupts.map((interrupt) => interrupt.id),
      ),
    ]),
  ];
}

function terminalActivityOutcome(
  status: RunStatus,
): ThreadActivityOutcome | undefined {
  switch (status) {
    case "success":
    case "error":
    case "timeout":
    case "interrupted":
    case "cancelled":
      return status;
    default:
      return undefined;
  }
}

function threadActivityTitle(
  thread:
    | {
        title: string;
        lastMessage?: string;
      }
    | undefined,
): string {
  const title = thread?.title.trim();
  if (title && !isDefaultTitle(title)) return title;
  return thread?.lastMessage?.trim() || title || "New conversation";
}

export interface AgentHostOptions {
  dataRoot: string;
  modelId?: string;
  pluginsDir?: string | false;
}

export interface McpServerListEntry {
  id: string;
  source: "user" | "plugin";
  pluginName?: string;
  entry: McpServerEntry;
  enabled: boolean;
  status: "loading" | "retrying" | "connected" | "error" | "crashed" | "disabled";
  toolCount: number;
  crashedAt?: string;
  detail?: string;
  dependentSkills: CapabilitySkillDependency[];
}

export interface CapabilitySkillDependency {
  id: string;
  name: string;
  source: SkillCatalogEntry["source"];
  pluginName?: string;
  enabled: boolean;
}

export class CapabilityDependencyError extends Error {
  constructor(
    readonly code: "dependency_disabled" | "resource_in_use",
    readonly blockers: Array<{
      id: string;
      name?: string;
      reason?: "disabled" | "missing";
    }>,
  ) {
    super(
      code === "dependency_disabled"
        ? "Required MCP servers must be configured and enabled first."
        : "Enabled skills depend on this MCP server.",
    );
    this.name = "CapabilityDependencyError";
  }
}

type McpLifecycleState = Pick<
  McpServerListEntry,
  "status" | "toolCount" | "detail" | "crashedAt"
>;

function redactMcpEntry(entry: McpServerEntry): McpServerEntry {
  if ("command" in entry) {
    return {
      ...entry,
      ...(entry.env
        ? { env: Object.fromEntries(Object.keys(entry.env).map((key) => [key, "<redacted>"])) }
        : {}),
    };
  }
  return {
    ...entry,
    ...(entry.headers
      ? {
          headers: Object.fromEntries(
            Object.keys(entry.headers).map((key) => [key, "<redacted>"]),
          ),
        }
      : {}),
  };
}

function mergeShippedSkills(
  builtinSkills: SkillCatalog,
  pluginSkills: SkillCatalog,
): SkillCatalog {
  return new Map([...builtinSkills, ...pluginSkills]);
}

function skillPreferenceKey(skill: SkillCatalogEntry): CapabilityPreferenceKey {
  return {
    kind: "skill",
    source: skill.pluginName ? `plugin:${skill.pluginName}` : skill.source,
    id: skill.id,
  };
}

function mcpPreferenceKey(
  id: string,
  source: "user" | "plugin",
  pluginName?: string,
): CapabilityPreferenceKey {
  return {
    kind: "mcp",
    source: pluginName ? `plugin:${pluginName}` : source,
    id,
  };
}

function statusOf(
  catalog: ToolCatalog,
  server: string,
  lifecycle: ReadonlyMap<string, McpLifecycleState>,
  health: Record<string, import("./mcp-health-monitor.js").McpServerHealth> = {},
): McpLifecycleState {
  const current = lifecycle.get(server);
  if (current) return { ...current };
  const crashed = health[server]?.status === "crashed" ? health[server] : undefined;
  if (crashed) {
    return {
      status: "crashed",
      toolCount: 0,
      ...(crashed.crashedAt ? { crashedAt: crashed.crashedAt } : {}),
      ...(crashed.detail ? { detail: crashed.detail } : {}),
    };
  }
  const tools = catalog[server];
  return tools ? { status: "connected", toolCount: tools.length } : { status: "error", toolCount: 0 };
}

function sameStringRecord(
  left: Readonly<Record<string, string>> | undefined,
  right: Readonly<Record<string, string>>,
): boolean {
  const leftEntries = Object.entries(left ?? {});
  const rightKeys = Object.keys(right);
  return (
    leftEntries.length === rightKeys.length &&
    leftEntries.every(([key, value]) => right[key] === value)
  );
}

function positiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function skillProjectionFingerprint(
  projection: { ready: SkillCatalog; availability: SkillAvailability[] },
  catalog: ToolCatalog,
): string {
  const grantedTools = [...projection.ready.values()].map((skill) => ({
    id: skill.id,
    servers: skill.declaredTools
      .filter((ref) => ref.startsWith("mcp:"))
      .map((ref) => ref.split(":")[1]!)
      .filter((server, index, servers) => servers.indexOf(server) === index)
      .map((server) => [server, catalog[server] ?? []] as const),
  }));
  return JSON.stringify({
    availability: projection.availability,
    grantedTools,
  });
}

function aiMessageText(reply: { content: unknown }): string {
  const content = reply.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((c) =>
      typeof c === "object" && c !== null && "text" in c
        ? String((c as { text?: string }).text ?? "")
        : "",
    )
    .join("");
}

function toolDescription(tool: unknown, fallback: string): string {
  if (!tool || typeof tool !== "object" || !("description" in tool)) return fallback;
  const description = (tool as { description?: unknown }).description;
  return typeof description === "string" && description.trim()
    ? description.trim()
    : fallback;
}

export class AgentHost {
  readonly protocolRuns: ProtocolRunManager;

  readonly triggers: TriggerStore;
  readonly triggerService: TriggerService;

  readonly threadStore: ThreadStore;
  readonly folderStore: FolderStore;
  readonly search: SearchStore;
  readonly settings: SettingsStore;
  readonly providerConfigs: ProviderConfigStore;
  readonly threadActivity: ThreadActivityStore;
  readonly capabilityPreferences: CapabilityPreferencesStore;
  readonly localFolders: LocalFolderStore;
  modelId: string;
  readonly attachments?: AttachmentStore;

  private readonly appDb: AppDatabase;
  private readonly explicitModelId: string | null;

  private graphs?: GraphManager;
  private readonly warmup: Promise<void>;
  private readinessState: "warming" | "ready" | "failed" = "warming";

  private skillsDir?: string | false;
  private memoriesDir?: string | false;
  private builtinSkills?: SkillCatalog;
  private pluginSkills?: SkillCatalog;
  private skillInventory: SkillCatalog = new Map();
  private skillAvailability: SkillAvailability[] = [];
  private appliedSkillProjection = "";
  private mcpConfigPath?: string | false;
  private pluginMcpServers?: Record<string, McpServerEntry>;
  private providerMcpEnv?: Record<string, string>;
  private pluginsImpl?: LoadedPlugins;
  private pluginDirs?: string | readonly string[] | false;
  // The one plugins dir the host owns for read/write installs; scanned dirs it only reads.
  private pluginsInstallDir?: string | false;
  private pluginMaterializationsDir?: string | false;
  private readonly mcpHealth = new McpHealthMonitor();
  private readonly mcpLifecycle = new Map<string, McpLifecycleState>();
  private mcpTools: Record<string, unknown> = {};
  private mcpCatalog: ToolCatalog = {};
  private pendingMcpCapabilities: {
    tools: Record<string, unknown>;
    catalog: ToolCatalog;
  } | undefined;
  private mcpCapabilityUpdates: Promise<void> = Promise.resolve();
  private mcpCapabilityDrainScheduled = false;
  private mcpReloads: Promise<void> = Promise.resolve();
  private readonly mcpRetirements = new Set<Promise<void>>();
  private initialMcpStartup: Promise<void> = Promise.resolve();
  private readonly mcpRecoveryTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private closing = false;

  private constructor(
    readonly persistence: Persistence,
    readonly dataRoot: string,
    explicitModelId: string | undefined,
    appDbPath: string,
    attachmentsDir: string | false,
    warm: (host: AgentHost) => Promise<GraphManager>,
  ) {
    this.protocolRuns = new ProtocolRunManager((input, opts) => this.streamProtocolReady(input, opts));
    // All app stores share one SQLite handle and one close owner.
    this.appDb = openAppDatabase(appDbPath, attachmentsDir || undefined);
    this.triggers = this.appDb.triggers;
    this.threadStore = this.appDb.threadStore;
    this.folderStore = this.appDb.folders;
    this.search = this.appDb.search;
    this.settings = this.appDb.settings;
    this.providerConfigs = this.appDb.providerConfigs;
    this.threadActivity = this.appDb.threadActivity;
    this.capabilityPreferences = this.appDb.capabilityPreferences;
    this.localFolders = this.appDb.localFolders;
    this.explicitModelId = explicitModelId ?? process.env.PIZZA_MODEL ?? null;
    this.modelId = this.selectDefaultModel();
    if (this.appDb.attachments) this.attachments = this.appDb.attachments;
    this.triggerService = new TriggerService(protocolRunLauncher(this.protocolRuns), this.triggers, {
      isEnabled: () => this.settings.get().enableAutomations,
    });
    this.runMaintenance = new RunMaintenance({
      threadStore: this.threadStore,
      search: this.search,
      getMessages: async (threadId) => {
        await this.warmup;
        const state = await this.agent.getState(threadId);
        return (state.values as { messages?: IndexableMessage[] } | undefined)?.messages ?? [];
      },
      generateTitle: async (userMessage, assistantMessage) => {
        await this.warmup;
        const model = await this.graphs?.buildDefaultModel();
        if (!model) return undefined;
        const reply = (await model.invoke([
          new SystemMessage(TITLE_SYSTEM_PROMPT),
          new HumanMessage(buildTitleUserMessage(userMessage, assistantMessage)),
        ])) as AIMessage;
        return aiMessageText(reply);
      },
      log: (m) => console.log(m),
    });
    this.protocolEndUnsub = this.protocolRuns.onEnd(({ threadId, runId, status, inputType }) => {
      const outcome = terminalActivityOutcome(status);
      if (!outcome) return;
      void this.queueThreadMaintenance(threadId, async () => {
        let interruptIds: string[] = [];
        try {
          // The checkpoint already contains the pending interrupt. Reindexing only
          // persists sidebar metadata, making the paused thread discoverable again.
          if (status === "interrupted") {
            interruptIds = await this.readThreadInterruptIds(threadId);
            this.threadStore.ensure({ threadId });
            this.threadStore.update(threadId, { unread: true, awaitingAction: true });
            await this.runMaintenance.reindexThread(threadId);
            return;
          }
          await this.runMaintenance.onRunEnd(threadId);
          const awaitingAction = await this.readThreadAwaitingAction(
            threadId,
            inputType === "resume",
          );
          // Maintenance creates a missing thread row; unread marking must follow it.
          // Cancelled runs produce no result worth marking unread.
          if (status === "success" || status === "error") {
            this.threadStore.update(threadId, { unread: true, awaitingAction });
          } else {
            this.threadStore.update(threadId, { awaitingAction });
          }
        } finally {
          const threadTitle = threadActivityTitle(
            this.threadStore.get(threadId),
          );
          this.threadActivity.append({
            eventId: `${threadId}:${runId}`,
            threadId,
            runId,
            outcome,
            interruptIds,
            threadTitle,
          });
        }
      });
    });
    this.warmup = warm(this).then(
      (graphs) => {
        this.graphs = graphs;
        this.readinessState = "ready";
        this.initialMcpStartup = this.reloadMcpServers().catch((err) => {
          console.error("[mcp] initial background startup failed:", err);
        });
      },
      (err: unknown) => {
        this.readinessState = "failed";
        throw err;
      },
    );
  }

  private readonly protocolEndUnsub: () => void;
  private readonly runMaintenance: RunMaintenance;
  private readonly maintenanceByThread = new Map<string, Promise<void>>();
  private readonly pendingDeletes = new Map<string, Promise<boolean>>();
  private readonly deletionFences = new Map<string, () => void>();

  // Fences new runs, drains maintenance, then removes app metadata and checkpoint
  // history before releasing the thread id. Concurrent deletes share one operation.
  deleteThread(threadId: string): Promise<boolean> {
    const pending = this.pendingDeletes.get(threadId);
    if (pending) return pending;

    const deletion = this.deleteThreadResources(threadId).finally(() => {
      if (this.pendingDeletes.get(threadId) === deletion) {
        this.pendingDeletes.delete(threadId);
      }
    });
    this.pendingDeletes.set(threadId, deletion);
    return deletion;
  }

  private async deleteThreadResources(threadId: string): Promise<boolean> {
    let releaseRunDeletion = this.deletionFences.get(threadId);
    if (!releaseRunDeletion) {
      releaseRunDeletion = await this.protocolRuns.beginThreadDeletion(threadId);
      this.deletionFences.set(threadId, releaseRunDeletion);
    }
    let completed = false;
    try {
      await this.waitForThreadMaintenance(threadId);
      this.attachments?.deleteByThread(threadId);
      this.threadActivity.deleteByThread(threadId);
      const deleted = this.threadStore.delete(threadId);
      this.search.deleteThread(threadId);
      // SqliteSaver.deleteThread skips its lazy schema setup on an unopened database.
      await this.persistence.checkpointer.getTuple({
        configurable: { thread_id: threadId, checkpoint_ns: "" },
      });
      await this.persistence.checkpointer.deleteThread(threadId);
      completed = true;
      return deleted;
    } finally {
      // Partial deletion must remain fenced so a new run cannot recreate state.
      // A later retry reuses and releases this fence after cleanup succeeds.
      if (completed) {
        this.deletionFences.delete(threadId);
        releaseRunDeletion();
      }
    }
  }

  // Serialize maintenance per thread so deletion cannot race reindex/title writes.
  private queueThreadMaintenance(threadId: string, task: () => Promise<void>): Promise<void> {
    const prior = this.maintenanceByThread.get(threadId) ?? Promise.resolve();
    const queued = prior.catch(() => {}).then(task);
    this.maintenanceByThread.set(threadId, queued);
    const clear = () => {
      if (this.maintenanceByThread.get(threadId) === queued) this.maintenanceByThread.delete(threadId);
    };
    void queued.then(clear, clear);
    return queued;
  }

  private async waitForThreadMaintenance(threadId: string): Promise<void> {
    await this.maintenanceByThread.get(threadId);
  }

  // Run-end side effects and thread deletes both write through the app stores; drain
  // them before closing so no maintenance task writes into a closed database.
  private async drainMaintenance(): Promise<void> {
    await Promise.allSettled([
      ...this.pendingDeletes.values(),
      ...this.maintenanceByThread.values(),
    ]);
  }

  async clearThreadAwaitingAction(threadId: string): Promise<void> {
    await this.queueThreadMaintenance(threadId, async () => {
      this.threadStore.update(threadId, { awaitingAction: false });
    });
  }

  suspendForSystemSleep(): void {
    this.triggerService.pauseForSystemSleep();
  }

  async resumeFromSystemSleep(): Promise<void> {
    try {
      await this.reloadMcpServers();
    } finally {
      this.triggerService.recoverAfterSystemSleep();
    }
  }

  private async readThreadAwaitingAction(
    threadId: string,
    resumeFallback: boolean,
  ): Promise<boolean> {
    try {
      return stateAwaitsAction(await this.agent.getState(threadId));
    } catch {
      return resumeFallback || (this.threadStore.get(threadId)?.awaitingAction ?? false);
    }
  }

  private async readThreadInterruptIds(threadId: string): Promise<string[]> {
    try {
      return interruptIdsOf(await this.agent.getState(threadId));
    } catch {
      return [];
    }
  }

  get agent(): LangGraphAgent {
    if (!this.graphs) {
      throw new Error("AgentHost accessed before warmup completed — await host.whenReady() first.");
    }
    return this.graphs.agent;
  }

  get readiness(): "warming" | "ready" | "failed" {
    return this.readinessState;
  }

  async toolCatalog(): Promise<ToolCatalog> {
    await this.warmup;
    return this.mcpCatalog;
  }

  async skillCatalog(): Promise<SkillInfo[]> {
    await this.warmup;
    const states = new Map(this.skillAvailability.map((state) => [state.id, state]));
    const servers = new Map((await this.listMcpServers()).map((server) => [server.id, server]));
    return [...this.skillInventory.values()].map((skill) => {
      const enabled = this.skillEnabled(skill);
      const state = states.get(skill.id);
      return {
        ...skillInfoOf(skill),
        enabled,
        status: enabled ? state?.status ?? "unavailable" : "disabled",
        ...(!enabled
          ? { statusDetail: "Disabled" }
          : state
          ? {
              ...(state.detail ? { statusDetail: state.detail } : {}),
            }
          : {}),
        mcpDependencies: skillMcpServerIds(skill).map((id) => {
          const server = servers.get(id);
          return server
            ? { id, enabled: server.enabled, status: server.status }
            : { id, enabled: false, status: "missing" as const };
        }),
      };
    });
  }

  async skillsDirectory(): Promise<string | false> {
    await this.warmup;
    return this.skillsDir ?? false;
  }

  async memoriesDirectory(): Promise<string | false> {
    await this.warmup;
    if (!this.settings.get().enableMemories) return false;
    return this.memoriesDir ?? false;
  }

  async skillFor(id: string): Promise<SkillCatalogEntry | undefined> {
    await this.warmup;
    return this.skillInventory.get(id);
  }

  private skillEnabled(skill: SkillCatalogEntry): boolean {
    return this.capabilityPreferences.get(skillPreferenceKey(skill)) ?? true;
  }

  private dependentSkills(serverId: string): CapabilitySkillDependency[] {
    return [...this.skillInventory.values()]
      .filter((skill) => skillMcpServerIds(skill).includes(serverId))
      .map((skill) => ({
        id: skill.id,
        name: skill.name,
        source: skill.source,
        ...(skill.pluginName ? { pluginName: skill.pluginName } : {}),
        enabled: this.skillEnabled(skill),
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  async generateSkillDraft(prompt: string): Promise<SkillDraft> {
    await this.warmup;
    await this.initialMcpStartup;
    const model = await this.graphs!.buildDefaultModel();

    const catalog = await this.toolCatalog();
    const tools: SkillGeneratorTool[] = [
      {
        ref: BUILTIN_EVAL_TOOL_REF,
        description: "Evaluate calculations and deterministic expressions.",
      },
      ...Object.entries(catalog).flatMap(([server, names]) => [
        {
          ref: `mcp:${server}:*`,
          description: `All connected tools from the ${server} server.`,
        },
        ...names.map((name) => {
          const ref = `mcp:${server}:${name}`;
          return {
            ref,
            description: toolDescription(this.mcpTools[ref], name),
          };
        }),
      ]),
    ];

    const reply = (await model.invoke([
      new SystemMessage(buildSkillGeneratorPrompt(tools)),
      new HumanMessage(prompt),
    ])) as AIMessage;

    return normalizeSkillDraft(parseSkillDraftJson(aiMessageText(reply)), tools);
  }

  get plugins(): LoadedPlugins | undefined {
    return this.pluginsImpl;
  }

  whenReady(): Promise<void> {
    return this.warmup;
  }

  async startAutomations(): Promise<void> {
    await this.whenInitialMcpSettled();
    if (!this.closing) this.triggerService.start();
  }

  private async whenInitialMcpSettled(): Promise<void> {
    await this.warmup;
    await this.initialMcpStartup;
  }

  private async *streamProtocolReady(input: RunInput, opts: RunOptions): AsyncIterable<ProtocolEvent> {
    const { agent, cleaned } = await this.resolveTurn(opts);
    yield* agent.streamProtocol(input, cleaned);
  }

  private async resolveTurn(
    opts: RunOptions,
  ): Promise<{ agent: LangGraphAgent; cleaned: RunOptions }> {
    await this.warmup;
    const requestedModel = opts.configurable?.model;
    const explicitModel =
      typeof requestedModel === "string" && requestedModel.length > 0
        ? requestedModel
        : undefined;
    const pinnedModel = this.threadStore.get(opts.threadId)?.modelId;
    const modelId = explicitModel ?? pinnedModel ?? this.modelId;
    const agent = await this.agentFor(modelId);
    const thread = this.threadStore.ensure({ threadId: opts.threadId, modelId });
    if (thread.modelId !== modelId) {
      this.threadStore.update(opts.threadId, { modelId });
    }
    const cleaned = { ...opts };
    if (opts.configurable) {
      // `model` selects the graph here and is not a valid LangGraph configurable key.
      const { model: _dropModel, ...rest } = opts.configurable;
      cleaned.configurable = rest;
    }
    return { agent, cleaned };
  }

  async listModels(includeDisabled = false): Promise<Array<{ id: string; displayName: string; provider: string }>> {
    await this.warmup;
    return this.graphs!.listModels(includeDisabled);
  }

  async listModelCatalog(includeDisabled = false, refresh = false) {
    await this.warmup;
    return this.graphs!.listModelCatalog(includeDisabled, refresh);
  }

  async listProviders(): Promise<ProviderInfo[]> {
    await this.warmup;
    return this.graphs!.listProviders();
  }

  private selectDefaultModel(
    globalDefault = this.providerConfigs.getDefaultModel() ?? null,
    bestAvailable: string | null = null,
  ): string {
    return selectModel({
      conversationOverride: this.explicitModelId,
      globalDefault,
      bestAvailable: bestAvailable ?? LAST_RESORT_MODEL,
    });
  }

  /**
   * Automatic selection re-runs on every warm-up, so a catalog that is missing a
   * source would otherwise silently re-point scheduled runs at another model.
   * Only a complete catalog is allowed to change the remembered pick.
   */
  private async selectAutomaticModel(
    catalog: (remembered?: string) => Promise<AutomaticModelCatalog>,
    build: (qualified: string) => Promise<BaseChatModel>,
  ): Promise<{ modelId: string; model: BaseChatModel }> {
    const { ids, complete, keeping } = await catalog(
      this.providerConfigs.getAutomaticModel(),
    );
    if (keeping) {
      console.warn(
        `[model] model catalog is incomplete — keeping "${keeping}" as the automatic default`,
      );
    }
    const selected = await this.buildAutomaticModel(ids, build);
    if (complete) this.providerConfigs.setAutomaticModel(selected.modelId);
    return selected;
  }

  private async buildAutomaticModel(
    candidateIds: readonly string[],
    build: (qualified: string) => Promise<BaseChatModel>,
  ): Promise<{ modelId: string; model: BaseChatModel }> {
    const failures: string[] = [];
    for (const modelId of candidateIds) {
      try {
        return { modelId, model: await build(modelId) };
      } catch (err) {
        failures.push(`${modelId}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    const modelId = candidateIds[0] ?? LAST_RESORT_MODEL;
    if (failures.length > 0) {
      console.warn(`[model] automatic candidates unavailable (${failures.join("; ")})`);
    }
    return {
      modelId,
      model: new UnavailableChatModel(
        `Model "${modelId}" is not available. Configure an inference provider in Settings.`,
      ),
    };
  }

  private async buildConfiguredModel(
    modelId: string,
    build: (qualified: string) => Promise<BaseChatModel>,
  ): Promise<BaseChatModel> {
    return build(modelId).catch((err: unknown) => {
      console.warn(
        `[model] "${modelId}" unavailable — configure its provider in Settings. (${err instanceof Error ? err.message : String(err)})`,
      );
      return new UnavailableChatModel(
        `Model "${modelId}" is not available. Configure an inference provider in Settings.`,
      );
    });
  }

  /**
   * Single authority for the global default: validates a non-null selection,
   * persists it, then re-points the live default so `agentFor(undefined)`,
   * `/status`, and `/models` all agree without a restart.
   */
  async setDefaultModel(qualified: string | null): Promise<string> {
    await this.warmup;
    if (qualified !== null) {
      const check = await this.graphs!.validateModel(qualified);
      if (!check.available) {
        throw new ModelUnavailableError(qualified, check.reason, check.message);
      }
    }
    const configured = this.explicitModelId ?? qualified;
    const selected = configured
      ? {
          modelId: configured,
          model: await this.buildConfiguredModel(
            configured,
            (modelId) => this.graphs!.buildModel(modelId),
          ),
        }
      : await this.selectAutomaticModel(
          (remembered) => this.graphs!.automaticModels(remembered),
          (modelId) => this.graphs!.buildModel(modelId),
        );
    this.providerConfigs.setDefaultModel(qualified);
    this.modelId = selected.modelId;
    await this.graphs!.setDefaultModel(selected.modelId, selected.model);
    return this.modelId;
  }

  async configureProvider(providerId: string, config: ResolvedProviderConfig): Promise<void> {
    await this.warmup;
    await this.graphs!.configureProvider(providerId, expandMcpEnvVars(config));
    const nextMcpEnv = this.graphs!.providerProcessEnv();
    if (!sameStringRecord(this.providerMcpEnv, nextMcpEnv)) {
      this.providerMcpEnv = nextMcpEnv;
      await this.reloadMcpServers();
    }
  }

  async setProviderModelPreferences(
    providerId: string,
    preferences: ProviderModelPreferences,
  ): Promise<void> {
    await this.warmup;
    this.graphs!.setEnabledModels(
      providerId,
      preferences.mode === "selected" ? preferences.selected : undefined,
    );
    this.providerConfigs.setModelPreferences(providerId, preferences);
    if (!this.explicitModelId && !this.providerConfigs.getDefaultModel()) {
      await this.setDefaultModel(null);
    }
  }

  async clearProviderModelPreferences(providerId: string): Promise<void> {
    await this.warmup;
    this.graphs!.setEnabledModels(providerId, undefined);
    this.providerConfigs.removeModelPreferences(providerId);
  }

  async contextWindow(): Promise<number | undefined> {
    await this.warmup;
    return this.graphs!.contextWindow();
  }

  async agentFor(modelId?: string): Promise<LangGraphAgent> {
    await this.warmup;
    return this.graphs!.agentFor(modelId);
  }

  async reloadSettings(): Promise<void> {
    await this.warmup;
    await this.graphs!.reloadSettings();
  }

  private skillProjection(
    tools: Readonly<Record<string, unknown>>,
    catalog: ToolCatalog,
  ): { ready: SkillCatalog; availability: SkillAvailability[] } {
    const mcpServers = new Map<string, McpDependencyState>();
    for (const [server, state] of this.mcpLifecycle) {
      if (state.status === "connected") {
        mcpServers.set(server, { status: "ready" });
      } else if (state.status === "loading" || state.status === "retrying") {
        mcpServers.set(server, {
          status: "loading",
          detail: state.detail ?? `${server} is still loading`,
        });
      } else {
        mcpServers.set(server, {
          status: "unavailable",
          detail:
            state.status === "disabled"
              ? `${server} is disabled`
              : state.detail ?? `${server} is unavailable`,
        });
      }
    }
    const enabledSkills = new Map(
      [...this.skillInventory].filter(([, skill]) => this.skillEnabled(skill)),
    );
    return projectSkillReadiness(enabledSkills, {
      catalog,
      tools: new Set(Object.keys(tools)),
      mcpServers,
      builtins: new Set([BUILTIN_EVAL_TOOL_REF]),
    });
  }

  private async applyMcpCapabilities(
    tools: Record<string, unknown>,
    catalog: ToolCatalog,
    forceRebuild = false,
  ): Promise<void> {
    const projection = this.skillProjection(tools, catalog);
    const fingerprint = skillProjectionFingerprint(projection, catalog);
    if (forceRebuild || fingerprint !== this.appliedSkillProjection) {
      await this.graphs!.replaceCapabilities({
        skills: projection.ready,
        tools,
        catalog,
        skillAvailability: projection.availability,
      });
      this.appliedSkillProjection = fingerprint;
    }
    this.mcpTools = tools;
    this.mcpCatalog = catalog;
    this.skillAvailability = projection.availability;
    if (this.pluginsImpl) {
      (this.pluginsImpl as { tools: Record<string, unknown> }).tools = tools;
      (this.pluginsImpl as { catalog: ToolCatalog }).catalog = catalog;
    }
  }

  private queueMcpCapabilities(
    tools: Record<string, unknown>,
    catalog: ToolCatalog,
  ): void {
    this.pendingMcpCapabilities = { tools, catalog };
    if (this.mcpCapabilityDrainScheduled) return;
    this.mcpCapabilityDrainScheduled = true;
    const update = this.mcpCapabilityUpdates
      .catch(() => {})
      .then(async () => {
        while (this.pendingMcpCapabilities) {
          const next = this.pendingMcpCapabilities;
          this.pendingMcpCapabilities = undefined;
          await this.applyMcpCapabilities(next.tools, next.catalog);
        }
      })
      .finally(() => {
        this.mcpCapabilityDrainScheduled = false;
        if (this.pendingMcpCapabilities) {
          this.queueMcpCapabilities(
            this.pendingMcpCapabilities.tools,
            this.pendingMcpCapabilities.catalog,
          );
        }
      });
    this.mcpCapabilityUpdates = update;
    void update.catch((err) => console.error("[mcp] incremental capability rebuild failed:", err));
  }

  private async flushMcpCapabilities(): Promise<void> {
    await this.mcpCapabilityUpdates;
    if (this.mcpCapabilityDrainScheduled) await this.mcpCapabilityUpdates;
  }

  async reloadSkills(): Promise<void> {
    await this.warmup;
    if (!this.skillsDir) return;
    const userSkills = await loadUserSkills(this.skillsDir, (m) => console.log(`[skills] ${m}`));
    const shippedSkills = mergeShippedSkills(
      this.builtinSkills ?? new Map(),
      this.pluginSkills ?? new Map(),
    );
    const merged = mergeSkillCatalogs(shippedSkills, userSkills, (m) =>
      console.log(`[skills] ${m}`),
    );
    console.log(
      `[skills] reloaded ${userSkills.size} user skill(s); catalog now ${merged.size} total`,
    );
    const previousInventory = this.skillInventory;
    this.skillInventory = merged;
    try {
      // Skill instructions are captured when graphs are built, so force replacement
      // even when readiness and tool grants did not change.
      await this.applyMcpCapabilities(this.mcpTools, this.mcpCatalog, true);
    } catch (error) {
      this.skillInventory = previousInventory;
      throw error;
    }
  }

  async setSkillEnabled(id: string, enabled: boolean): Promise<SkillInfo | undefined> {
    await this.warmup;
    const skill = this.skillInventory.get(id);
    if (!skill) return undefined;
    if (enabled) {
      const servers = new Map((await this.listMcpServers()).map((server) => [server.id, server]));
      const blockers: Array<{
        id: string;
        reason: "disabled" | "missing";
      }> = [];
      for (const serverId of skillMcpServerIds(skill)) {
        const server = servers.get(serverId);
        if (!server) blockers.push({ id: serverId, reason: "missing" });
        else if (!server.enabled) blockers.push({ id: serverId, reason: "disabled" });
      }
      if (blockers.length > 0) {
        throw new CapabilityDependencyError("dependency_disabled", blockers);
      }
    }

    const key = skillPreferenceKey(skill);
    const previous = this.capabilityPreferences.get(key);
    this.capabilityPreferences.set(key, enabled);
    try {
      await this.applyMcpCapabilities(this.mcpTools, this.mcpCatalog, true);
    } catch (error) {
      if (previous === undefined) this.capabilityPreferences.delete(key);
      else this.capabilityPreferences.set(key, previous);
      throw error;
    }
    return (await this.skillCatalog()).find((candidate) => candidate.id === id);
  }

  clearUserSkillPreference(id: string): void {
    this.capabilityPreferences.delete({ kind: "skill", source: "user", id });
  }

  async mcpConfigFile(): Promise<string | false> {
    await this.warmup;
    return this.mcpConfigPath ?? false;
  }

  async listMcpServers(): Promise<McpServerListEntry[]> {
    await this.warmup;
    const catalog = this.mcpCatalog;
    const health = this.mcpHealth.snapshot();
    const pluginNameOf = (server: string): string | undefined =>
      this.pluginsImpl?.registry.mcpServers.get(server)?.pluginName;
    const userEntries = this.mcpConfigPath
      ? await loadUserMcpServers(this.mcpConfigPath, (f, e) =>
          console.warn(`[mcp] skipping ${f}: ${e instanceof Error ? e.message : String(e)}`),
        )
      : {};

    const out: McpServerListEntry[] = [];
    for (const [id, entry] of Object.entries(this.pluginMcpServers ?? {})) {
      if (id in userEntries) continue;
      const pluginName = pluginNameOf(id);
      const enabled =
        this.capabilityPreferences.get(mcpPreferenceKey(id, "plugin", pluginName)) ??
        entry.enabled !== false;
      out.push({
        id,
        source: "plugin",
        ...(pluginName ? { pluginName } : {}),
        entry: redactMcpEntry(entry),
        enabled,
        ...statusOf(catalog, id, this.mcpLifecycle, health),
        dependentSkills: this.dependentSkills(id),
      });
    }
    for (const [id, entry] of Object.entries(userEntries)) {
      const enabled =
        this.capabilityPreferences.get(mcpPreferenceKey(id, "user")) ??
        entry.enabled !== false;
      out.push({
        id,
        source: "user",
        entry: redactMcpEntry(entry),
        enabled,
        ...statusOf(catalog, id, this.mcpLifecycle, health),
        dependentSkills: this.dependentSkills(id),
      });
    }
    out.sort((a, b) => a.id.localeCompare(b.id));
    return out;
  }

  async userMcpServer(id: string): Promise<McpServerEntry | undefined> {
    await this.warmup;
    if (!this.mcpConfigPath) return undefined;
    const entries = await loadUserMcpServers(this.mcpConfigPath);
    return entries[id];
  }

  async setMcpServerEnabled(
    id: string,
    enabled: boolean,
  ): Promise<McpServerListEntry | undefined> {
    await this.warmup;
    const server = (await this.listMcpServers()).find((candidate) => candidate.id === id);
    if (!server) return undefined;
    if (!enabled) {
      const blockers = await this.mcpServerDisableBlockers(id);
      if (blockers.length > 0) {
        throw new CapabilityDependencyError("resource_in_use", blockers);
      }
    }

    const key = mcpPreferenceKey(id, server.source, server.pluginName);
    const previous = this.capabilityPreferences.get(key);
    this.capabilityPreferences.set(key, enabled);
    try {
      await this.reloadMcpServers();
    } catch (error) {
      if (previous === undefined) this.capabilityPreferences.delete(key);
      else this.capabilityPreferences.set(key, previous);
      await this.reloadMcpServers().catch(() => {});
      throw error;
    }
    return (await this.listMcpServers()).find((candidate) => candidate.id === id);
  }

  async reconnectMcpServer(id: string): Promise<McpServerListEntry | undefined> {
    const reconnect = this.mcpReloads.then(() => this.reconnectMcpServerOnce(id));
    this.mcpReloads = reconnect.then(
      () => {},
      () => {},
    );
    return reconnect;
  }

  async mcpServerDisableBlockers(
    id: string,
  ): Promise<Array<{ id: string; name: string }>> {
    await this.warmup;
    return this.dependentSkills(id)
      .filter((skill) => skill.enabled)
      .map((skill) => ({ id: skill.id, name: skill.name }));
  }

  clearUserMcpServerPreference(id: string): void {
    this.capabilityPreferences.delete({ kind: "mcp", source: "user", id });
  }

  mcpHealthSnapshot(): Record<string, import("./mcp-health-monitor.js").McpServerHealth> {
    return this.mcpHealth.snapshot();
  }

  private recordMcpStatus(event: McpConnectionEvent): void {
    const detail = event.detail ? redactDiagnosticText(event.detail) : undefined;
    this.mcpLifecycle.set(event.server, {
      status: event.status,
      toolCount: event.toolCount ?? 0,
      ...(detail ? { detail } : {}),
    });
    const context = {
      event: `mcp.${event.status}`,
      mcpServer: event.server,
      status: event.status,
      attempt: event.attempt,
      toolCount: event.toolCount,
      detail,
    };
    if (event.status === "error") mcpLog.error("MCP server connection failed", undefined, context);
    else if (event.status === "retrying") mcpLog.warn("Retrying MCP server connection", context);
    else mcpLog.info(`MCP server ${event.status}`, context);
    if (event.status === "error" && this.graphs) {
      const latest = this.pendingMcpCapabilities ?? {
        tools: this.mcpTools,
        catalog: this.mcpCatalog,
      };
      this.queueMcpCapabilities(latest.tools, latest.catalog);
    }
  }

  private beginMcpReload(
    servers: Readonly<Record<string, McpServerEntry>>,
  ): Map<string, McpLifecycleState> {
    const previous = new Map(this.mcpLifecycle);
    this.mcpLifecycle.clear();
    for (const [server, entry] of Object.entries(servers)) {
      this.mcpLifecycle.set(server, {
        status: entry.enabled === false ? "disabled" : "loading",
        toolCount: 0,
      });
    }
    return previous;
  }

  private restoreMcpLifecycle(previous: ReadonlyMap<string, McpLifecycleState>): void {
    this.mcpLifecycle.clear();
    for (const [server, state] of previous) this.mcpLifecycle.set(server, state);
  }

  private async armMcpHealth(): Promise<void> {
    const client = this.pluginsImpl?.client as McpClientLike | undefined;
    if (!client) return;
    await this.mcpHealth.arm(client, this.mcpCatalog, (server) =>
      this.handleMcpCrash(server),
    );
  }

  private handleMcpCrash(server: string): void {
    const plugins = this.pluginsImpl;
    if (!plugins) return;
    const deadToolNames = new Set(this.mcpCatalog[server] ?? []);
    const crashed = this.mcpHealth.snapshot()[server];
    this.mcpLifecycle.set(server, {
      status: "crashed",
      toolCount: 0,
      crashedAt: crashed?.crashedAt ?? new Date().toISOString(),
      detail: crashed?.detail ?? "connection closed unexpectedly",
    });
    console.error(
      `[mcp] server "${server}" crashed — invalidating ${deadToolNames.size} tool(s); ` +
        "scheduling reconnect",
    );
    const nextCatalog: ToolCatalog = { ...this.mcpCatalog };
    delete nextCatalog[server];
    const nextTools: Record<string, unknown> = {};
    for (const [name, tool] of Object.entries(this.mcpTools)) {
      if (!name.startsWith(`mcp:${server}:`)) {
        nextTools[name] = tool;
      }
    }
    void this.applyMcpCapabilities(nextTools, nextCatalog).catch((err) => {
      console.error(`[mcp] failed to rebuild tools after "${server}" crash:`, err);
    });
    this.scheduleMcpRecovery(server);
  }

  private scheduleMcpRecovery(server: string): void {
    if (this.closing || this.mcpRecoveryTimers.has(server)) return;
    const timer = setTimeout(() => {
      this.mcpRecoveryTimers.delete(server);
      if (this.closing) return;
      void this.reconnectMcpServer(server).catch((err) => {
        console.error(`[mcp] automatic recovery after "${server}" crash failed:`, err);
      });
    }, 1_000);
    timer.unref?.();
    this.mcpRecoveryTimers.set(server, timer);
  }

  private retireMcpClient(client: McpClientPool | undefined): void {
    if (!client || client === this.pluginsImpl?.client) return;
    const retirement = this.protocolRuns
      .whenIdle()
      .then(() => client.close());
    this.mcpRetirements.add(retirement);
    void retirement
      .catch((err) => console.error("[mcp] failed to retire replaced client:", err))
      .finally(() => this.mcpRetirements.delete(retirement));
  }

  private async loadUserMcpEntries(): Promise<Record<string, McpServerEntry>> {
    // Resolve environment references only for the live connection, never on disk.
    return this.mcpConfigPath
      ? expandMcpEnvVars(
          await loadUserMcpServers(this.mcpConfigPath, (f, e) =>
            console.warn(`[mcp] skipping ${f}: ${e instanceof Error ? e.message : String(e)}`),
          ),
        )
      : {};
  }

  private async reconnectMcpServerOnce(
    id: string,
  ): Promise<McpServerListEntry | undefined> {
    await this.warmup;
    const userEntries = await this.loadUserMcpEntries();
    const merged = this.effectiveMcpEntries(
      this.pluginMcpServers ?? {},
      userEntries,
    );
    const entry = merged[id];
    if (!entry) return undefined;
    if (entry.enabled === false) {
      return (await this.listMcpServers()).find((server) => server.id === id);
    }

    const previousLifecycle = this.mcpLifecycle.get(id);
    const previousTools = this.mcpTools;
    const previousCatalog = this.mcpCatalog;
    this.mcpLifecycle.set(id, { status: "loading", toolCount: 0 });

    const result = await connectMcpServers(
      { [id]: entry },
      process.env.PIZZA_MCP_NODE_PATH ?? undefined,
      (m) => console.log(`[mcp] ${m}`),
      "pipe",
      this.providerMcpEnv,
      {
        electronRunAsNode:
          Boolean(process.versions.electron) &&
          process.env.PIZZA_MCP_NODE_PATH === process.execPath,
        connectionTimeoutMs: positiveInt(
          process.env.PIZZA_MCP_CONNECTION_TIMEOUT_MS,
          20_000,
        ),
        onStatus: (event) => this.recordMcpStatus(event),
      },
    );
    const connectedTools = result.catalog[id];
    if (!result.client || !connectedTools) {
      return (await this.listMcpServers()).find((server) => server.id === id);
    }

    const nextTools = Object.fromEntries(
      Object.entries(previousTools).filter(
        ([name]) => !name.startsWith(`mcp:${id}:`),
      ),
    );
    Object.assign(nextTools, result.tools);
    const nextCatalog: ToolCatalog = {
      ...previousCatalog,
      [id]: connectedTools,
    };
    const plugins = this.pluginsImpl;
    if (!plugins) {
      await result.client.close().catch(() => {});
      if (previousLifecycle) this.mcpLifecycle.set(id, previousLifecycle);
      else this.mcpLifecycle.delete(id);
      throw new Error("MCP client pool is unavailable");
    }

    const mutable = plugins as { client?: McpClientPool };
    const existingPool = mutable.client;
    let activePool: McpClientPool;
    let displaced: McpClientPool | undefined;
    if (existingPool) {
      displaced = existingPool.replaceServer(id, result.client);
      activePool = existingPool;
    } else {
      activePool = result.client;
      mutable.client = activePool;
    }

    try {
      await this.applyMcpCapabilities(nextTools, nextCatalog);
      await this.mcpHealth.armServer(
        activePool as McpClientLike,
        id,
        connectedTools,
        (server) => this.handleMcpCrash(server),
      );
      this.retireMcpClient(displaced);
    } catch (error) {
      let failedReplacement: McpClientPool | undefined;
      if (existingPool) {
        failedReplacement = existingPool.replaceServer(id, displaced);
      } else {
        delete mutable.client;
        failedReplacement = activePool;
      }
      await failedReplacement?.close().catch(() => {});
      if (previousLifecycle) this.mcpLifecycle.set(id, previousLifecycle);
      else this.mcpLifecycle.delete(id);
      await this.applyMcpCapabilities(previousTools, previousCatalog).catch(() => {});
      throw error;
    }

    return (await this.listMcpServers()).find((server) => server.id === id);
  }

  private effectiveMcpEntries(
    pluginEntries: Readonly<Record<string, McpServerEntry>>,
    userEntries: Readonly<Record<string, McpServerEntry>>,
    plugins: LoadedPlugins | undefined = this.pluginsImpl,
  ): Record<string, McpServerEntry> {
    const effective: Record<string, McpServerEntry> = {};
    for (const [id, entry] of Object.entries(pluginEntries)) {
      const pluginName = plugins?.registry.mcpServers.get(id)?.pluginName;
      const enabled =
        this.capabilityPreferences.get(mcpPreferenceKey(id, "plugin", pluginName)) ??
        entry.enabled !== false;
      effective[id] = { ...entry, enabled };
    }
    for (const [id, entry] of Object.entries(userEntries)) {
      const enabled =
        this.capabilityPreferences.get(mcpPreferenceKey(id, "user")) ??
        entry.enabled !== false;
      effective[id] = { ...entry, enabled };
    }
    return effective;
  }

  /**
   * The live-reload seam: fence the lifecycle map, disarm health, connect the
   * merged server set, hand the fresh pool to `apply` for the runtime swap, then
   * re-arm and retire the old client only once no run holds it. On any failure the
   * new client is closed and the prior lifecycle snapshot is restored.
   */
  private async connectAndSwap(
    merged: Record<string, McpServerEntry>,
    apply: (result: McpConnectResult) => Promise<void>,
  ): Promise<void> {
    const previousLifecycle = this.beginMcpReload(merged);
    const previousTools = this.mcpTools;
    const previousCatalog = this.mcpCatalog;
    this.mcpHealth.disarm();
    const previousClient = this.pluginsImpl?.client;
    let replacementClient: McpClientPool | undefined;
    try {
      // Normal turns continue against a graph containing dependency-free skills.
      await this.applyMcpCapabilities({}, {});
      const result = await connectMcpServers(
        merged,
        process.env.PIZZA_MCP_NODE_PATH ?? undefined,
        (m) => console.log(`[mcp] ${m}`),
        "pipe",
        this.providerMcpEnv,
        {
          electronRunAsNode:
            Boolean(process.versions.electron) &&
            process.env.PIZZA_MCP_NODE_PATH === process.execPath,
          concurrency: positiveInt(process.env.PIZZA_MCP_STARTUP_CONCURRENCY, 3),
          connectionTimeoutMs: positiveInt(
            process.env.PIZZA_MCP_CONNECTION_TIMEOUT_MS,
            20_000,
          ),
          onStatus: (event) => this.recordMcpStatus(event),
          onProgress: ({ tools, catalog }) => {
            this.queueMcpCapabilities(tools, catalog);
          },
        },
      );
      replacementClient = result.client;
      await this.flushMcpCapabilities();
      await apply(result);
      await this.armMcpHealth();
      this.retireMcpClient(previousClient);
    } catch (err) {
      await replacementClient?.close().catch(() => {});
      this.restoreMcpLifecycle(previousLifecycle);
      await this.applyMcpCapabilities(previousTools, previousCatalog).catch(() => {});
      await this.armMcpHealth();
      throw err;
    }
  }

  async reloadPlugins(
    reason: PluginMaterializerReason = "manual",
  ): Promise<void> {
    const reload = this.mcpReloads.then(() => this.reloadPluginsOnce(reason));
    this.mcpReloads = reload.catch(() => {});
    return reload;
  }

  private async reloadPluginsOnce(
    reason: PluginMaterializerReason,
  ): Promise<void> {
    await this.warmup;
    if (!this.pluginDirs) return;
    const userEntries = await this.loadUserMcpEntries();
    const next = await loadPlugins({
      pluginsDir: this.pluginDirs,
      hostContract: PLUGIN_HOST_CONTRACT,
      extraMcpServers: userEntries,
      ...(this.providerMcpEnv ? { extraEnv: this.providerMcpEnv } : {}),
      log: (m) => console.log(`[plugins] ${m}`),
      mcpStderr: "pipe",
      connectMcp: false,
      ...(this.pluginMaterializationsDir
        ? { materializationCacheDir: this.pluginMaterializationsDir }
        : {}),
      materializationReason: reason,
    });
    const nextPluginEntries = mcpEntriesFromRegistry(next.registry);
    const mergedEntries = this.effectiveMcpEntries(nextPluginEntries, userEntries, next);

    await this.connectAndSwap(mergedEntries, async ({ client, tools, catalog }) => {
      if (client) (next as { client?: McpClientPool }).client = client;
      (next as { tools: Record<string, unknown> }).tools = tools;
      (next as { catalog: ToolCatalog }).catalog = catalog;

      const userSkills = this.skillsDir
        ? await loadUserSkills(this.skillsDir, (m) => console.log(`[skills] ${m}`))
        : new Map();
      const shippedSkills = mergeShippedSkills(this.builtinSkills ?? new Map(), next.skills);
      const skills = mergeSkillCatalogs(shippedSkills, userSkills, (m) =>
        console.log(`[skills] ${m}`),
      );
      const previousInventory = this.skillInventory;
      this.skillInventory = skills;
      try {
        await this.applyMcpCapabilities(tools, catalog, true);
        this.pluginsImpl = next;
        this.pluginMcpServers = nextPluginEntries;
        this.pluginSkills = next.skills;
      } catch (error) {
        this.skillInventory = previousInventory;
        throw error;
      }
      console.log(
        `[plugins] runtime reload complete: ${next.pluginReports.filter((plugin) => plugin.status === "loaded").length} plugin(s), ${Object.keys(catalog).length} MCP server(s) connected`,
      );
    });
  }

  /** Writable install directory, or false when plugins are disabled or data is in-memory. */
  async pluginsInstallDirectory(): Promise<string | false> {
    await this.warmup;
    return this.pluginsInstallDir ?? false;
  }

  /** A plugin is user-managed only if it was installed into the writable install dir. */
  async pluginIsInstalled(name: string): Promise<boolean> {
    const dir = await this.pluginsInstallDirectory();
    if (!dir || !pluginNameSchema.safeParse(name).success) return false;
    const entries = await readdir(join(dir, name)).catch(() => null);
    return entries !== null && entries.includes(".claude-plugin");
  }

  /** Writes the parsed bundle under the install dir, then reloads so it is live without a restart. */
  async installPlugin(plugin: ImportedPlugin): Promise<void> {
    const installDir = await this.pluginsInstallDirectory();
    if (!installDir) throw new Error("plugins_disabled");
    const dir = join(installDir, plugin.name);
    await mkdir(installDir, { recursive: true });
    await mkdir(dir, { recursive: false });
    try {
      for (const file of plugin.files) {
        const destination = resolve(dir, file.path);
        if (!destination.startsWith(`${resolve(dir)}${sep}`)) {
          throw new Error(`unsafe bundle path "${file.path}"`);
        }
        await mkdir(dirname(destination), { recursive: true });
        await writeFile(destination, file.content);
      }
    } catch (error) {
      await rm(dir, { recursive: true, force: true });
      throw error;
    }
    try {
      await this.reloadPlugins("install");
      const materialization = this.pluginsImpl?.materializations[plugin.name];
      if (materialization?.state === "error") {
        throw new Error(
          materialization.detail
            ? `Plugin materialization failed: ${materialization.detail}`
            : "Plugin materialization failed",
        );
      }
    } catch (error) {
      await rm(dir, { recursive: true, force: true });
      await this.removePluginMaterialization(plugin.name);
      await this.reloadPlugins("manual").catch(() => {});
      throw error;
    }
  }

  /**
   * Removes a user-installed plugin and reloads. Shipped/external plugins are not
   * removable here.
   *
   * Windows locks a running child's cwd and any `.node` it has loaded, so the
   * plugin's MCP servers must exit before its directory can go — and the
   * directory itself cannot be renamed aside while a server's cwd sits in it.
   * Dropping the manifest first is what makes the reload stop those servers; the
   * delete then only has to outlast the brief post-exit handle window.
   */
  async deletePlugin(name: string): Promise<boolean> {
    const installDir = await this.pluginsInstallDirectory();
    if (!installDir || !(await this.pluginIsInstalled(name))) return false;
    const dir = join(installDir, name);
    await rm(join(dir, ".claude-plugin"), { recursive: true, force: true });
    try {
      await this.reloadPlugins("manual");
    } finally {
      await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      await this.removePluginMaterialization(name);
      this.capabilityPreferences.deleteSource(`plugin:${name}`);
    }
    return true;
  }

  private async removePluginMaterialization(name: string): Promise<void> {
    if (!this.pluginMaterializationsDir) return;
    await rm(join(this.pluginMaterializationsDir, name), {
      recursive: true,
      force: true,
      maxRetries: 3,
      retryDelay: 100,
    });
  }

  async reloadMcpServers(): Promise<void> {
    const reload = this.mcpReloads.then(() => this.reloadMcpServersOnce());
    this.mcpReloads = reload.catch(() => {});
    return reload;
  }

  private async reloadMcpServersOnce(): Promise<void> {
    await this.warmup;
    const userEntries = await this.loadUserMcpEntries();
    const merged = this.effectiveMcpEntries(
      this.pluginMcpServers ?? {},
      userEntries,
    );

    await this.connectAndSwap(merged, async ({ client, tools: mcpTools, catalog }) => {
      await this.applyMcpCapabilities(mcpTools, catalog);

      if (this.pluginsImpl) {
        const mutable = this.pluginsImpl as { client?: McpClientPool };
        if (client) mutable.client = client;
        else delete mutable.client;
      }
      console.log(
        `[mcp] reloaded ${Object.keys(userEntries).length} user server(s); catalog now ${Object.keys(catalog).length} connected`,
      );
    });
  }

  static async create(opts: AgentHostOptions): Promise<AgentHost> {
    const host = AgentHost.createPhased(opts);
    await host.whenReady();
    await host.whenInitialMcpSettled();
    return host;
  }

  static createPhased(opts: AgentHostOptions): AgentHost {
    const explicitModelId = opts.modelId;
    const shippedPluginsDir = opts.pluginsDir === false ? false : opts.pluginsDir ?? resolvePluginsDir();
    const builtinSkillsDir = opts.pluginsDir === false ? false : resolveBuiltinSkillsDir();
    const dataRootIsMemory =
      opts.dataRoot === ":memory:" || opts.dataRoot.startsWith("file::memory:");
    const pluginsDir: string | string[] | false =
      shippedPluginsDir === false
        ? false
        : dataRootIsMemory
          ? shippedPluginsDir
          : [
              ...new Set([
                shippedPluginsDir,
                resolveLayout(opts.dataRoot).pluginsDir,
                ...(opts.pluginsDir === undefined ? resolveExternalPluginsDirs() : []),
              ]),
            ];

    const skillsDir =
      opts.pluginsDir === false || dataRootIsMemory ? false : resolveSkillsDir(opts.dataRoot);

    const memoriesDir = resolveMemoriesDir(opts.dataRoot);

    const mcpConfigPath = resolveMcpConfig(opts.dataRoot);
    const pluginMaterializationsDir =
      pluginsDir === false || dataRootIsMemory
        ? false
        : resolveLayout(opts.dataRoot).pluginMaterializationsDir;

    let persistence!: Persistence;
    const warm = async (host: AgentHost): Promise<GraphManager> => {
      persistence = await openPersistence({ root: opts.dataRoot });
      const registry = new ModelRegistry();
      await registerBuiltinProviders(registry, host.providerConfigs);
      host.providerMcpEnv = registry.collectProcessEnv();
      const configured = host.explicitModelId ?? host.providerConfigs.getDefaultModel();
      const selected = configured
        ? {
            modelId: configured,
            model: await host.buildConfiguredModel(
              configured,
              (modelId) => registry.buildModel(modelId),
            ),
          }
        : await host.selectAutomaticModel(
            (remembered) => automaticModelCatalog(registry, remembered),
            (modelId) => registry.buildModel(modelId),
          );
      host.modelId = selected.modelId;
      const model = selected.model;

      const userMcpServers = mcpConfigPath
        ? expandMcpEnvVars(
            await loadUserMcpServers(mcpConfigPath, (f, e) =>
              console.warn(`[mcp] skipping ${f}: ${e instanceof Error ? e.message : String(e)}`),
            ),
          )
        : {};

      const plugins = pluginsDir
        ? await loadPlugins({
            pluginsDir,
            hostContract: PLUGIN_HOST_CONTRACT,
            extraMcpServers: userMcpServers,
            extraEnv: host.providerMcpEnv,
            log: (m) => console.log(`[plugins] ${m}`),
            mcpStderr: "pipe",
            onMcpStatus: (event) => host.recordMcpStatus(event),
            connectMcp: false,
            ...(pluginMaterializationsDir
              ? { materializationCacheDir: pluginMaterializationsDir }
              : {}),
            materializationReason: "startup",
          }).catch((err) => {
            // Plugin failure degrades to no plugin tools so core setup remains usable.
            console.error("[plugins] load failed:", err);
            return undefined;
          })
        : undefined;
      if (plugins) host.pluginsImpl = plugins;
      const pluginMcpServers = plugins ? mcpEntriesFromRegistry(plugins.registry) : {};

      const builtinSkills = builtinSkillsDir
        ? await loadBuiltinSkills(builtinSkillsDir, (m) => console.log(`[skills] ${m}`))
        : new Map();
      const pluginSkills = plugins?.skills ?? new Map();
      const userSkills = skillsDir ? await loadUserSkills(skillsDir, (m) => console.log(`[skills] ${m}`)) : new Map();
      const shippedSkills = mergeShippedSkills(builtinSkills, pluginSkills);
      // User-authored skills intentionally override shipped skills with the same id.
      const skills = mergeSkillCatalogs(shippedSkills, userSkills, (m) => console.log(`[skills] ${m}`));
      if (skills.size > 0) {
        console.log(
          `[skills] catalog: ${skills.size} skill(s) ` +
          `(${userSkills.size} user, ${builtinSkills.size} builtin, ${pluginSkills.size} plugin)`,
        );
      }

      // MCP-backed capabilities arrive incrementally after the core graph is ready.
      const tools: Record<string, unknown> = {};
      const catalog: ToolCatalog = {};
      if (memoriesDir && host.settings.get().enableMemories) {
        await mkdir(memoriesDir, { recursive: true }).catch(() => {});
      }

      host.skillsDir = skillsDir;
      host.memoriesDir = memoriesDir;
      host.mcpConfigPath = mcpConfigPath;
      host.builtinSkills = builtinSkills;
      host.pluginSkills = pluginSkills;
      host.skillInventory = skills;
      host.pluginMcpServers = pluginMcpServers;
      host.pluginDirs = pluginsDir;
      host.pluginsInstallDir =
        pluginsDir === false || dataRootIsMemory ? false : resolveLayout(opts.dataRoot).pluginsDir;
      host.pluginMaterializationsDir =
        pluginMaterializationsDir;
      const effectiveMcpServers = host.effectiveMcpEntries(
        pluginMcpServers,
        userMcpServers,
        plugins,
      );
      host.beginMcpReload(effectiveMcpServers);
      const skillProjection = host.skillProjection(tools, catalog);
      host.skillAvailability = skillProjection.availability;
      host.appliedSkillProjection = skillProjectionFingerprint(skillProjection, catalog);
      host.mcpTools = tools;
      host.mcpCatalog = catalog;
      const dependencies: RuntimeDeps = {
        checkpointer: persistence.checkpointer,
        store: persistence.store,
        // Surface runtime warnings (disabled agents, skipped tool refs) that are
        // otherwise dropped when no logger is wired.
        logger: {
          info: (m, ...a) => console.log(`[runtime] ${m}`, ...a),
          warn: (m, ...a) => console.warn(`[runtime] ${m}`, ...a),
          error: (m, ...a) => console.error(`[runtime] ${m}`, ...a),
          debug: () => {},
        },
        ...(memoriesDir
          ? {
              memoriesDir,
              memoryEnabled: () => host.settings.get().enableMemories,
            }
          : {}),
        localFolders: () => host.localFolders.list(),
        ...(host.attachments ? { attachmentResolver: host.attachments.resolver } : {}),
        ...(Object.keys(tools).length > 0 ? { tools } : {}),
        ...(Object.keys(catalog).length > 0 ? { catalog } : {}),
        ...(skillProjection.ready.size > 0 ? { skills: skillProjection.ready } : {}),
        skillAvailability: skillProjection.availability,
      };
      const graphs = new GraphManager({
        modelId: host.modelId,
        models: registry,
        dependencies,
        getPersonaAddendum: () => host.settings.get().customPromptAddendum,
        getMaxToolCalls: () => host.settings.get().maxToolCalls,
        getMaxSkillToolCalls: () => host.settings.get().maxSkillToolCalls,
      });
      await graphs.initialize(model);
      return graphs;
    };

    // Construction returns before persistence opens; this proxy resolves to the
    // warmup-owned handles once run entrypoints have awaited readiness.
    const lazyPersistence: Persistence = {
      get checkpointer() {
        return persistence?.checkpointer;
      },
      get store() {
        return persistence?.store;
      },
      close: () => persistence?.close(),
    } as unknown as Persistence;

    const isMemory = opts.dataRoot === ":memory:" || opts.dataRoot.startsWith("file::memory:");
    const appDbPath = isMemory ? ":memory:" : resolveLayout(opts.dataRoot).appDb;
    const attachmentsDir = isMemory ? false : resolveLayout(opts.dataRoot).attachmentsDir;

    return new AgentHost(
      lazyPersistence,
      opts.dataRoot,
      explicitModelId,
      appDbPath,
      attachmentsDir,
      warm,
    );
  }

  async close(): Promise<void> {
    this.closing = true;
    for (const timer of this.mcpRecoveryTimers.values()) clearTimeout(timer);
    this.mcpRecoveryTimers.clear();
    this.triggerService.stop();
    // Warmup may still be opening persistence or spawning MCP children.
    await this.warmup.catch(() => {});
    // Refuse new runs, abort in-flight ones, and drain them; run-end side effects
    // fire through the still-subscribed onEnd listener before we detach it.
    await this.protocolRuns.shutdown();
    this.protocolEndUnsub();
    // Run-end and pending-delete maintenance write through the app stores, so let
    // them settle before any store closes.
    await this.drainMaintenance();
    await this.mcpReloads.catch(() => {});
    await Promise.allSettled(this.mcpRetirements);
    // Disarm before closing transports because their onclose hooks also fire here.
    this.mcpHealth.disarm();
    await this.pluginsImpl?.client?.close().catch(() => {});
    this.persistence.close();
    // The app SQLite handle closes last so no drained write lands on a closed DB.
    this.appDb.close();
  }
}
