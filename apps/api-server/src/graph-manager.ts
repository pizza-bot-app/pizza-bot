import {
  pizzaBotSystemPrompt,
  automaticModelCatalog,
  DEFAULT_SETTINGS,
  type AutomaticModelCatalog,
  type ModelCatalogStatus,
  type ModelAvailability,
  type ModelRegistry,
  type ProviderInfo,
  type ResolvedProviderConfig,
  type RuntimeDeps,
  type AgentAvailability,
  type AgentCatalog,
  type AmbientTodoAccess,
  type SkillCatalog,
} from "@pizza-bot/core";
import { createAgentRootAgent, createPizzaBotAgent, type LangGraphAgent } from "@pizza-bot/runtime-langgraph";
import type { ToolCatalog } from "@pizza-bot/plugin-sdk";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";

export interface GraphManagerOptions {
  modelId: string;
  models: ModelRegistry;
  dependencies: RuntimeDeps;
  /** Read at every graph build so a persona change takes effect on rebuild. */
  getPersonaAddendum?: () => string;
  /** Read at every graph build so a tool-call limit change takes effect on rebuild. */
  getMaxToolCalls?: () => number;
  /** Read at every graph build so a skill tool-call limit change takes effect on rebuild. */
  getMaxSubagentToolCalls?: () => number;
}

/** Every field here forces a graph rebuild when it changes between runs. */
interface RuntimeSettingsSnapshot {
  addendum: string;
  memoriesEnabled: boolean;
  maxToolCalls: number;
  maxSubagentToolCalls: number;
}

export interface CapabilityReplacement {
  skills?: SkillCatalog;
  rootSkills?: readonly string[];
  agents?: AgentCatalog;
  agentAvailability?: readonly AgentAvailability[];
  tools?: Record<string, unknown>;
  catalog?: ToolCatalog;
}

/** Appends the global persona to a definition's base system prompt (additive only). */
function withPersona(systemPrompt: string, addendum: string): string {
  const trimmed = addendum.trim();
  return trimmed ? `${systemPrompt}\n\n${trimmed}` : systemPrompt;
}

function withAgentAvailability(
  systemPrompt: string,
  availability: readonly AgentAvailability[] | undefined,
): string {
  const unavailable = availability?.filter((agent) => agent.status !== "ready") ?? [];
  if (unavailable.length === 0) return systemPrompt;
  const statuses = unavailable.map((agent) => {
    const state = agent.status === "loading" ? "still loading" : "unavailable";
    return `- ${agent.name}: ${state}${agent.detail ? ` (${agent.detail})` : ""}`;
  });
  const notice = [
    "These specialists are not currently callable:",
    ...statuses,
    "Do not delegate to them. If a request depends on one, state its current availability instead of pretending the task can be completed.",
  ].join("\n");
  return `${systemPrompt}\n\n${notice}`;
}

/** Owns the model-specific compiled Pizza Bot graphs and capability reloads. */
export class GraphManager {
  private modelId: string;
  private readonly models: ModelRegistry;
  private dependencies: RuntimeDeps;
  private readonly getPersonaAddendum: () => string;
  private readonly getMaxToolCalls: () => number;
  private readonly getMaxSubagentToolCalls: () => number;

  private agentImpl?: LangGraphAgent;
  private compiledAvailability: readonly AgentAvailability[] | undefined;
  private readonly cache = new Map<string, Promise<LangGraphAgent>>();
  private readonly rootAgents = new Map<string, Promise<{ agent: LangGraphAgent; modelId: string }>>();
  private updates: Promise<void> = Promise.resolve();
  private appliedRuntimeSettings?: RuntimeSettingsSnapshot;

  constructor(opts: GraphManagerOptions) {
    this.modelId = opts.modelId;
    this.models = opts.models;
    this.dependencies = opts.dependencies;
    this.getPersonaAddendum = opts.getPersonaAddendum ?? (() => "");
    this.getMaxToolCalls = opts.getMaxToolCalls ?? (() => DEFAULT_SETTINGS.maxToolCalls);
    this.getMaxSubagentToolCalls = opts.getMaxSubagentToolCalls ??
      (() => DEFAULT_SETTINGS.maxSubagentToolCalls);
  }

  get agent(): LangGraphAgent {
    if (!this.agentImpl) throw new Error("Graph manager accessed before initialization.");
    return this.agentImpl;
  }

  skills(): SkillCatalog | undefined {
    return this.dependencies.skills;
  }

  /** Readiness after pinned models resolved; an unresolvable pin makes its agent unavailable. */
  agentAvailability(): readonly AgentAvailability[] {
    return this.compiledAvailability ?? this.dependencies.agentAvailability ?? [];
  }

  /**
   * Resolves each ready agent's pinned model. A pin that cannot resolve drops the
   * agent instead of silently falling back to the conversation model.
   */
  private async withAgentModels(deps: RuntimeDeps): Promise<RuntimeDeps> {
    const agents = deps.agents;
    if (!agents?.size) return deps;
    const ready: AgentCatalog = new Map();
    const agentModels = new Map<string, BaseChatModel>();
    const failures = new Map<string, string>();
    await Promise.all([...agents].map(async ([id, agent]) => {
      if (!agent.model) {
        ready.set(id, agent);
        return;
      }
      try {
        agentModels.set(id, await this.models.resolveModel(agent.model));
        ready.set(id, agent);
      } catch (err) {
        failures.set(id, err instanceof Error ? err.message : `Model "${agent.model}" is unavailable`);
      }
    }));
    const agentAvailability = (deps.agentAvailability ?? []).map((state) => {
      const detail = failures.get(state.id);
      return detail ? { ...state, status: "unavailable" as const, detail } : state;
    });
    const resolved: RuntimeDeps = { ...deps, agentAvailability };
    if (ready.size > 0) resolved.agents = new Map([...agents].filter(([id]) => ready.has(id)));
    else delete resolved.agents;
    if (agentModels.size > 0) resolved.agentModels = agentModels;
    return resolved;
  }

  async buildDefaultModel(): Promise<BaseChatModel> {
    return this.models.buildModel(this.modelId);
  }

  buildModel(qualified: string): Promise<BaseChatModel> {
    return this.models.buildModel(qualified);
  }

  private depsForModel(deps: RuntimeDeps, model: BaseChatModel): RuntimeDeps {
    return {
      ...deps,
      model,
      maxToolCalls: this.getMaxToolCalls(),
      maxSubagentToolCalls: this.getMaxSubagentToolCalls(),
    };
  }

  async listModels(includeDisabled = false): Promise<Array<{
    id: string;
    displayName: string;
    provider: string;
    contextWindow?: number;
  }>> {
    const descriptors = await this.models.listAll({ includeDisabled });
    return descriptors.map((descriptor) => ({
      id: `${descriptor.provider}:${descriptor.id}`,
      displayName: descriptor.displayName,
      provider: descriptor.provider,
      ...(descriptor.contextWindow ? { contextWindow: descriptor.contextWindow } : {}),
    }));
  }

  async listModelCatalog(
    includeDisabled = false,
    refresh = false,
  ): Promise<{
    models: Array<{
      id: string;
      displayName: string;
      provider: string;
      contextWindow?: number;
    }>;
    providers: ModelCatalogStatus[];
  }> {
    const snapshot = await this.models.listCatalog({ includeDisabled, refresh });
    return {
      models: snapshot.models.map((descriptor) => ({
        id: `${descriptor.provider}:${descriptor.id}`,
        displayName: descriptor.displayName,
        provider: descriptor.provider,
        ...(descriptor.contextWindow
          ? { contextWindow: descriptor.contextWindow }
          : {}),
      })),
      providers: snapshot.providers,
    };
  }

  automaticModels(remembered?: string): Promise<AutomaticModelCatalog> {
    return automaticModelCatalog(this.models, remembered);
  }

  async contextWindow(): Promise<number | undefined> {
    const descriptors = await this.models.listAll();
    return descriptors.find((descriptor) => `${descriptor.provider}:${descriptor.id}` === this.modelId)
      ?.contextWindow;
  }

  listProviders(): ProviderInfo[] {
    return this.models.listProviders();
  }

  providerFieldOptions(providerId: string, fieldKey: string) {
    return this.models.fieldOptions(providerId, fieldKey);
  }

  setEnabledModels(providerId: string, modelIds: readonly string[] | undefined): void {
    this.models.setEnabledModels(providerId, modelIds);
  }

  providerProcessEnv(): Record<string, string> {
    return this.models.collectProcessEnv();
  }

  async configureProvider(providerId: string, config: ResolvedProviderConfig): Promise<void> {
    if (!this.models.configureProvider(providerId, config)) return;
    await this.enqueueUpdate(() => this.rebuild());
  }

  /** The live default served by `agentFor(undefined)` and reported by `/status`. */
  defaultModelId(): string {
    return this.modelId;
  }

  validateModel(qualified: string): Promise<ModelAvailability> {
    return this.models.validate(qualified);
  }

  /**
   * Re-points the warm default so a new default takes effect without restart.
   * The caller supplies the built model (with the same fallback policy as
   * warmup) so an as-yet-uncredentialed default degrades rather than throws.
   */
  async setDefaultModel(qualified: string, model: BaseChatModel): Promise<void> {
    if (qualified === this.modelId) return;
    await this.enqueueUpdate(async () => {
      this.modelId = qualified;
      await this.applyCapabilities(model);
    });
  }

  async initialize(model: BaseChatModel): Promise<void> {
    await this.applyCapabilities(model);
  }

  /** Rebuilds the warm graph so prompt-affecting settings take effect. */
  async reloadSettings(): Promise<void> {
    await this.enqueueUpdate(() => this.rebuild());
  }

  /** Prevent a stale graph from serving after settings were patched elsewhere. */
  async ensureSettings(): Promise<void> {
    if (this.runtimeSettingsMatch()) return;
    await this.reloadSettings();
  }

  async replaceCapabilities(replacement: CapabilityReplacement): Promise<void> {
    await this.enqueueUpdate(async () => {
      const dependencies = { ...this.dependencies };
      if (replacement.skills) {
        if (replacement.skills.size > 0) dependencies.skills = replacement.skills;
        else delete dependencies.skills;
      }
      if (replacement.rootSkills) {
        if (replacement.rootSkills.length > 0) dependencies.rootSkills = replacement.rootSkills;
        else delete dependencies.rootSkills;
      }
      if (replacement.agents) {
        if (replacement.agents.size > 0) dependencies.agents = replacement.agents;
        else delete dependencies.agents;
      }
      if (replacement.tools) {
        if (Object.keys(replacement.tools).length > 0) dependencies.tools = replacement.tools;
        else delete dependencies.tools;
      }
      if (replacement.catalog) {
        if (Object.keys(replacement.catalog).length > 0) dependencies.catalog = replacement.catalog;
        else delete dependencies.catalog;
      }
      if (replacement.agentAvailability) {
        dependencies.agentAvailability = replacement.agentAvailability;
      }
      await this.rebuild(dependencies);
    });
  }

  async agentFor(modelId?: string): Promise<LangGraphAgent> {
    await this.ensureSettings();
    const resolvedModelId = modelId ?? this.modelId;
    if (resolvedModelId === this.modelId) return this.agent;

    const cached = this.cache.get(resolvedModelId);
    if (cached) return cached;

    const built = (async () => {
      const model = await this.models.resolveModel(resolvedModelId);
      const deps = await this.withAgentModels(this.dependencies);
      return createPizzaBotAgent(this.systemPrompt(deps), this.depsForModel(deps, model));
    })().catch((err) => {
      // Rejected promises must not poison the graph cache.
      this.cache.delete(resolvedModelId);
      throw err;
    });
    this.cache.set(resolvedModelId, built);
    return built;
  }

  /**
   * An agent definition compiled as a thread's top-level agent. Its pinned model
   * wins over `modelId`; the returned `modelId` is the one it runs on. With
   * `ambient` it is compiled for a background Todo check-in.
   */
  async rootAgentFor(
    agentId: string,
    modelId?: string,
    ambient?: AmbientTodoAccess,
  ): Promise<{ agent: LangGraphAgent; modelId: string }> {
    await this.ensureSettings();
    const definition = this.dependencies.agents?.get(agentId);
    if (!definition) throw new Error(this.unavailableAgentMessage(agentId));
    const resolvedModelId = definition.model ?? modelId ?? this.modelId;
    const key = JSON.stringify([agentId, resolvedModelId, ambient !== undefined]);
    const cached = this.rootAgents.get(key);
    if (cached) return cached;

    const built = (async () => {
      const model = await this.models.resolveModel(resolvedModelId);
      const deps = await this.withAgentModels(this.dependencies);
      const agent = await createAgentRootAgent(
        definition,
        this.depsForModel(deps, model),
        ambient ? { ambient } : {},
      );
      return { agent, modelId: resolvedModelId };
    })().catch((err) => {
      this.rootAgents.delete(key);
      throw err;
    });
    this.rootAgents.set(key, built);
    return built;
  }

  private unavailableAgentMessage(agentId: string): string {
    const state = this.agentAvailability().find((agent) => agent.id === agentId);
    if (!state) return `Agent "${agentId}" does not exist or is disabled.`;
    const reason = state.status === "loading" ? "is still loading" : "is unavailable";
    return `Agent "${state.name}" ${reason}${state.detail ? `: ${state.detail}` : "."}`;
  }

  private async rebuild(dependencies = this.dependencies): Promise<void> {
    await this.applyCapabilities(await this.buildDefaultModel(), dependencies);
  }

  private async applyCapabilities(
    model: BaseChatModel,
    dependencies = this.dependencies,
  ): Promise<void> {
    const runtimeSettings = this.readRuntimeSettings(dependencies);
    const resolved = await this.withAgentModels(dependencies);
    const agent = await createPizzaBotAgent(
      this.systemPrompt(resolved),
      this.depsForModel(resolved, model),
    );

    this.dependencies = dependencies;
    this.compiledAvailability = resolved.agentAvailability;
    this.agentImpl = agent;
    this.appliedRuntimeSettings = runtimeSettings;
    this.cache.clear();
    this.cache.set(this.modelId, Promise.resolve(agent));
    this.rootAgents.clear();
  }

  private readRuntimeSettings(dependencies: RuntimeDeps): RuntimeSettingsSnapshot {
    return {
      addendum: this.getPersonaAddendum(),
      memoriesEnabled: dependencies.memoriesDir
        ? (dependencies.memoryEnabled?.() ?? true)
        : false,
      maxToolCalls: this.getMaxToolCalls(),
      maxSubagentToolCalls: this.getMaxSubagentToolCalls(),
    };
  }

  private runtimeSettingsMatch(): boolean {
    if (!this.appliedRuntimeSettings) return false;
    const current = this.readRuntimeSettings(this.dependencies);
    return (
      current.addendum === this.appliedRuntimeSettings.addendum &&
      current.memoriesEnabled === this.appliedRuntimeSettings.memoriesEnabled &&
      current.maxToolCalls === this.appliedRuntimeSettings.maxToolCalls &&
      current.maxSubagentToolCalls === this.appliedRuntimeSettings.maxSubagentToolCalls
    );
  }

  private systemPrompt(dependencies: RuntimeDeps): string {
    const settings = this.readRuntimeSettings(dependencies);
    return withPersona(
      withAgentAvailability(
        pizzaBotSystemPrompt({
          memories: settings.memoriesEnabled,
          subagents: (dependencies.agents?.size ?? 0) > 0,
          todos: dependencies.todos !== undefined,
        }),
        dependencies.agentAvailability,
      ),
      settings.addendum,
    );
  }

  private enqueueUpdate(update: () => Promise<void>): Promise<void> {
    const result = this.updates.then(update);
    this.updates = result.catch(() => {});
    return result;
  }
}
