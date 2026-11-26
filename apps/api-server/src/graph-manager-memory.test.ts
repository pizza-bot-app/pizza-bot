import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  ModelRegistry,
  PIZZA_BOT_MEMORY_PROMPT,
  type RuntimeDeps,
  type AgentCatalogEntry,
  type SkillCatalogEntry,
} from "@pizza-bot/core";
import { registerBuiltinProviders } from "@pizza-bot/inference-providers";
import { createPizzaBotAgent } from "@pizza-bot/runtime-langgraph";
import { GraphManager } from "./graph-manager.js";

vi.mock("@pizza-bot/runtime-langgraph", () => ({
  createPizzaBotAgent: vi.fn(async () => ({})),
}));

const MODEL_ID = "bedrock:global.anthropic.claude-sonnet-5";

describe("GraphManager memory settings", () => {
  beforeEach(() => {
    vi.mocked(createPizzaBotAgent).mockClear();
  });

  it("passes a live backend gate and rebuilds with memory guidance only when enabled", async () => {
    const models = new ModelRegistry();
    await registerBuiltinProviders(models);
    let memoriesEnabled = false;
    const registry = new GraphManager({
      modelId: MODEL_ID,
      models,
      dependencies: {
        memoriesDir: "/srv/pizza-bot/memories",
        memoryEnabled: () => memoriesEnabled,
      },
    });

    await registry.initialize(await models.buildModel(MODEL_ID));
    const [disabledPrompt, disabledDeps] = vi.mocked(createPizzaBotAgent).mock.calls[0]!;
    expect(disabledPrompt).not.toContain(PIZZA_BOT_MEMORY_PROMPT);
    expect((disabledDeps as RuntimeDeps).memoryEnabled?.()).toBe(false);

    memoriesEnabled = true;
    // The callback captured by the already-compiled graph changes immediately.
    expect((disabledDeps as RuntimeDeps).memoryEnabled?.()).toBe(true);

    await registry.ensureSettings();
    const [enabledPrompt, enabledDeps] = vi.mocked(createPizzaBotAgent).mock.calls.at(-1)!;
    expect(enabledPrompt).toContain(PIZZA_BOT_MEMORY_PROMPT);
    expect((enabledDeps as RuntimeDeps).memoryEnabled?.()).toBe(true);
  });

  it("rebuilds with the current orchestrator and subagent tool-call limits", async () => {
    const models = new ModelRegistry();
    await registerBuiltinProviders(models);
    let maxToolCalls = 40;
    let maxSubagentToolCalls = 80;
    const registry = new GraphManager({
      modelId: MODEL_ID,
      models,
      dependencies: {},
      getMaxToolCalls: () => maxToolCalls,
      getMaxSubagentToolCalls: () => maxSubagentToolCalls,
    });

    await registry.initialize(await models.buildModel(MODEL_ID));
    expect((vi.mocked(createPizzaBotAgent).mock.calls[0]![1] as RuntimeDeps).maxToolCalls).toBe(40);
    expect((vi.mocked(createPizzaBotAgent).mock.calls[0]![1] as RuntimeDeps).maxSubagentToolCalls)
      .toBe(80);

    maxToolCalls = -1;
    maxSubagentToolCalls = -1;
    await registry.ensureSettings();
    expect((vi.mocked(createPizzaBotAgent).mock.calls.at(-1)![1] as RuntimeDeps).maxToolCalls).toBe(-1);
    expect((vi.mocked(createPizzaBotAgent).mock.calls.at(-1)![1] as RuntimeDeps).maxSubagentToolCalls)
      .toBe(-1);
  });
});

describe("GraphManager prompt capabilities", () => {
  beforeEach(() => {
    vi.mocked(createPizzaBotAgent).mockClear();
  });

  it("includes delegation guidance only while a ready agent exists", async () => {
    const models = new ModelRegistry();
    await registerBuiltinProviders(models);
    const registry = new GraphManager({
      modelId: MODEL_ID,
      models,
      dependencies: { agents: new Map([["mailer", agent("mailer")]]) },
    });

    await registry.initialize(await models.buildModel(MODEL_ID));
    const [readyPrompt] = vi.mocked(createPizzaBotAgent).mock.calls.at(-1)!;
    expect(readyPrompt).toContain("through the `task` tool");

    await registry.replaceCapabilities({
      agents: new Map(),
      agentAvailability: [{ id: "mailer", name: "Mailer", status: "loading" }],
    });
    const [loadingPrompt] = vi.mocked(createPizzaBotAgent).mock.calls.at(-1)!;
    expect(loadingPrompt).not.toContain("`task`");
    expect(loadingPrompt).toContain(
      "\n\nThese specialists are not currently callable:\n- Mailer: still loading",
    );
  });

  it("passes root skills and the enabled skill catalog through to the runtime", async () => {
    const models = new ModelRegistry();
    await registerBuiltinProviders(models);
    const skill: SkillCatalogEntry = {
      id: "guide",
      name: "guide",
      description: "guide",
      source: "builtin",
      files: [],
    };
    const registry = new GraphManager({ modelId: MODEL_ID, models, dependencies: {} });
    await registry.initialize(await models.buildModel(MODEL_ID));
    await registry.replaceCapabilities({ skills: new Map([["guide", skill]]), rootSkills: ["guide"] });
    const deps = vi.mocked(createPizzaBotAgent).mock.calls.at(-1)![1] as RuntimeDeps;
    expect(deps.rootSkills).toEqual(["guide"]);
    expect([...(deps.skills?.keys() ?? [])]).toEqual(["guide"]);

    await registry.replaceCapabilities({ rootSkills: [] });
    expect((vi.mocked(createPizzaBotAgent).mock.calls.at(-1)![1] as RuntimeDeps).rootSkills)
      .toBeUndefined();
  });
});

describe("GraphManager pinned agent models", () => {
  beforeEach(() => {
    vi.mocked(createPizzaBotAgent).mockClear();
    vi.restoreAllMocks();
  });

  it("resolves a pinned model per agent and lets unpinned agents inherit", async () => {
    const models = new ModelRegistry();
    await registerBuiltinProviders(models);
    const pinned = await models.buildModel(MODEL_ID);
    const resolveModel = vi.spyOn(models, "resolveModel").mockResolvedValue(pinned);
    const registry = new GraphManager({
      modelId: MODEL_ID,
      models,
      dependencies: {
        agents: new Map([
          ["fast", agent("fast", "anthropic:claude-haiku-4-5")],
          ["plain", agent("plain")],
        ]),
        agentAvailability: [
          { id: "fast", name: "fast", status: "ready" },
          { id: "plain", name: "plain", status: "ready" },
        ],
      },
    });
    await registry.initialize(await models.buildModel(MODEL_ID));

    expect(resolveModel).toHaveBeenCalledWith("anthropic:claude-haiku-4-5");
    const deps = vi.mocked(createPizzaBotAgent).mock.calls.at(-1)![1] as RuntimeDeps;
    expect([...(deps.agents?.keys() ?? [])].sort()).toEqual(["fast", "plain"]);
    expect(deps.agentModels?.get("fast")).toBe(pinned);
    expect(deps.agentModels?.has("plain")).toBe(false);
  });

  it("makes an agent with an unresolvable pinned model unavailable while the graph still builds", async () => {
    const models = new ModelRegistry();
    await registerBuiltinProviders(models);
    vi.spyOn(models, "resolveModel").mockRejectedValue(new Error('Model "nope:x" is unavailable'));
    const registry = new GraphManager({
      modelId: MODEL_ID,
      models,
      dependencies: {
        agents: new Map([["broken", agent("broken", "nope:x")], ["plain", agent("plain")]]),
        agentAvailability: [
          { id: "broken", name: "broken", status: "ready" },
          { id: "plain", name: "plain", status: "ready" },
        ],
      },
    });
    await registry.initialize(await models.buildModel(MODEL_ID));

    const [prompt, deps] = vi.mocked(createPizzaBotAgent).mock.calls.at(-1)!;
    expect([...((deps as RuntimeDeps).agents?.keys() ?? [])]).toEqual(["plain"]);
    expect(prompt).toContain('- broken: unavailable (Model "nope:x" is unavailable)');
    expect(registry.agentAvailability()).toEqual([
      { id: "broken", name: "broken", status: "unavailable", detail: 'Model "nope:x" is unavailable' },
      { id: "plain", name: "plain", status: "ready" },
    ]);
  });
});

function agent(id: string, model?: string): AgentCatalogEntry {
  return {
    id,
    name: id,
    description: `${id} description`,
    systemPrompt: "",
    ...(model ? { model } : {}),
    declaredTools: [],
    skills: [],
    interruptOn: {},
    source: "user",
  };
}
