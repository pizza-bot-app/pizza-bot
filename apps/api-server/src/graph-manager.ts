import {
  pizzaBotSystemPrompt,
  recommendedModelCandidates,
  type ModelCatalogStatus,
  type ModelAvailability,
  type ModelRegistry,
  type ProviderInfo,
  type ResolvedProviderConfig,
  type RuntimeDeps,
  type SkillAvailability,
  type SkillCatalog,
} from "@pizza-bot/core";
import { createPizzaBotAgent, type LangGraphAgent } from "@pizza-bot/runtime-langgraph";
import type { ToolCatalog } from "@pizza-bot/plugin-sdk";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";

export interface GraphManagerOptions {
  modelId: string;
  models: ModelRegistry;
  dependencies: RuntimeDeps;
  /** Read at every graph build so a persona change takes effect on rebuild. */
  getPersonaAddendum?: () => string;
}

export interface CapabilityReplacement {
  skills?: SkillCatalog;
  tools?: Record<string, unknown>;
  catalog?: ToolCatalog;
  skillAvailability?: readonly SkillAvailability[];
}

/** Appends the global persona to a definition's base system prompt (additive only). */
function withPersona(systemPrompt: string, addendum: string): string {
  const trimmed = addendum.trim();
  return trimmed ? `${systemPrompt}\n\n${trimmed}` : systemPrompt;
}

function withSkillAvailability(
  systemPrompt: string,
  availability: readonly SkillAvailability[] | undefined,
): string {
  const unavailable = availability?.filter((skill) => skill.status !== "ready") ?? [];
  if (unavailable.length === 0) return systemPrompt;
  const statuses = unavailable.map((skill) => {
    const state = skill.status === "loading" ? "still loading" : "unavailable";
    return `- ${skill.name}: ${state}${skill.detail ? ` (${skill.detail})` : ""}`;
  });
  return [
    systemPrompt,
    "These specialists are not currently callable:",
    ...statuses,
    "Do not delegate to them. If a request depends on one, state its current availability instead of pretending the task can be completed.",
  ].join("\n");
}

/** Owns the model-specific compiled Pizza Bot graphs and capability reloads. */
export class GraphManager {
  private modelId: string;
  private readonly models: ModelRegistry;
  private dependencies: RuntimeDeps;
  private readonly getPersonaAddendum: () => string;

  private agentImpl?: LangGraphAgent;
  private readonly cache = new Map<string, Promise<LangGraphAgent>>();
  private updates: Promise<void> = Promise.resolve();
  private appliedPromptSettings?: { addendum: string; memoriesEnabled: boolean };

  constructor(opts: GraphManagerOptions) {
    this.modelId = opts.modelId;
    this.models = opts.models;
    this.dependencies = opts.dependencies;
    this.getPersonaAddendum = opts.getPersonaAddendum ?? (() => "");
  }

  get agent(): LangGraphAgent {
    if (!this.agentImpl) throw new Error("Graph manager accessed before initialization.");
    return this.agentImpl;
  }

  skills(): SkillCatalog | undefined {
    return this.dependencies.skills;
  }

  async buildDefaultModel(): Promise<BaseChatModel> {
    return this.models.buildModel(this.modelId);
  }

  buildModel(qualified: string): Promise<BaseChatModel> {
    return this.models.buildModel(qualified);
  }

  private depsForModel(deps: RuntimeDeps, model: BaseChatModel): RuntimeDeps {
    return { ...deps, model };
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

  async recommendedModelIds(): Promise<string[]> {
    const descriptors = await this.models.listAll();
    return recommendedModelCandidates(descriptors).map(
      (descriptor) => `${descriptor.provider}:${descriptor.id}`,
    );
  }

  async contextWindow(): Promise<number | undefined> {
    const descriptors = await this.models.listAll();
    return descriptors.find((descriptor) => `${descriptor.provider}:${descriptor.id}` === this.modelId)
      ?.contextWindow;
  }

  listProviders(): ProviderInfo[] {
    return this.models.listProviders();
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
    if (this.promptSettingsMatch()) return;
    await this.reloadSettings();
  }

  async replaceCapabilities(replacement: CapabilityReplacement): Promise<void> {
    await this.enqueueUpdate(async () => {
      const dependencies = { ...this.dependencies };
      if (replacement.skills) {
        if (replacement.skills.size > 0) dependencies.skills = replacement.skills;
        else delete dependencies.skills;
      }
      if (replacement.tools) {
        if (Object.keys(replacement.tools).length > 0) dependencies.tools = replacement.tools;
        else delete dependencies.tools;
      }
      if (replacement.catalog) {
        if (Object.keys(replacement.catalog).length > 0) dependencies.catalog = replacement.catalog;
        else delete dependencies.catalog;
      }
      if (replacement.skillAvailability) {
        dependencies.skillAvailability = replacement.skillAvailability;
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
      return createPizzaBotAgent(
        this.systemPrompt(this.dependencies),
        this.depsForModel(this.dependencies, model),
      );
    })().catch((err) => {
      // Rejected promises must not poison the graph cache.
      this.cache.delete(resolvedModelId);
      throw err;
    });
    this.cache.set(resolvedModelId, built);
    return built;
  }

  private async rebuild(dependencies = this.dependencies): Promise<void> {
    await this.applyCapabilities(await this.buildDefaultModel(), dependencies);
  }

  private async applyCapabilities(
    model: BaseChatModel,
    dependencies = this.dependencies,
  ): Promise<void> {
    const promptSettings = this.readPromptSettings(dependencies);
    const agent = await createPizzaBotAgent(
      this.systemPrompt(dependencies),
      this.depsForModel(dependencies, model),
    );

    this.dependencies = dependencies;
    this.agentImpl = agent;
    this.appliedPromptSettings = promptSettings;
    this.cache.clear();
    this.cache.set(this.modelId, Promise.resolve(agent));
  }

  private readPromptSettings(dependencies: RuntimeDeps): {
    addendum: string;
    memoriesEnabled: boolean;
  } {
    return {
      addendum: this.getPersonaAddendum(),
      memoriesEnabled: dependencies.memoriesDir
        ? (dependencies.memoryEnabled?.() ?? true)
        : false,
    };
  }

  private promptSettingsMatch(): boolean {
    if (!this.appliedPromptSettings) return false;
    const current = this.readPromptSettings(this.dependencies);
    return (
      current.addendum === this.appliedPromptSettings.addendum &&
      current.memoriesEnabled === this.appliedPromptSettings.memoriesEnabled
    );
  }

  private systemPrompt(dependencies: RuntimeDeps): string {
    const settings = this.readPromptSettings(dependencies);
    return withPersona(
      withSkillAvailability(
        pizzaBotSystemPrompt(settings.memoriesEnabled),
        dependencies.skillAvailability,
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
