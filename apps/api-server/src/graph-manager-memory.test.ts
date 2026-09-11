import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  ModelRegistry,
  PIZZA_BOT_MEMORY_PROMPT,
  type RuntimeDeps,
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

  it("rebuilds with the current tool-call limit", async () => {
    const models = new ModelRegistry();
    await registerBuiltinProviders(models);
    let maxToolCalls = 40;
    const registry = new GraphManager({
      modelId: MODEL_ID,
      models,
      dependencies: {},
      getMaxToolCalls: () => maxToolCalls,
    });

    await registry.initialize(await models.buildModel(MODEL_ID));
    expect((vi.mocked(createPizzaBotAgent).mock.calls[0]![1] as RuntimeDeps).maxToolCalls).toBe(40);

    maxToolCalls = -1;
    await registry.ensureSettings();
    expect((vi.mocked(createPizzaBotAgent).mock.calls.at(-1)![1] as RuntimeDeps).maxToolCalls).toBe(-1);
  });
});
