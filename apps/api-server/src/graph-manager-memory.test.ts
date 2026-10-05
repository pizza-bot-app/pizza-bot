import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  ModelRegistry,
  PIZZA_BOT_MEMORY_PROMPT,
  type RuntimeDeps,
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

  it("includes delegation guidance only while a ready skill exists", async () => {
    const models = new ModelRegistry();
    await registerBuiltinProviders(models);
    const skill: SkillCatalogEntry = {
      id: "mailer",
      name: "mailer",
      description: "mailer description",
      source: "user",
      declaredTools: [],
      interruptOn: {},
      files: [],
    };
    const registry = new GraphManager({
      modelId: MODEL_ID,
      models,
      dependencies: { skills: new Map([[skill.id, skill]]) },
    });

    await registry.initialize(await models.buildModel(MODEL_ID));
    const [readyPrompt] = vi.mocked(createPizzaBotAgent).mock.calls.at(-1)!;
    expect(readyPrompt).toContain("through the `task` tool");

    await registry.replaceCapabilities({
      skills: new Map(),
      skillAvailability: [{ id: "mailer", name: "Mailer", status: "loading" }],
    });
    const [loadingPrompt] = vi.mocked(createPizzaBotAgent).mock.calls.at(-1)!;
    expect(loadingPrompt).not.toContain("`task`");
    expect(loadingPrompt).toContain(
      "\n\nThese specialists are not currently callable:\n- Mailer: still loading",
    );
  });
});
