import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  ModelRegistry,
  PIZZA_BOT_MEMORY_PROMPT,
  type RuntimeDeps,
} from "@pizza-bot/core";
import { registerBuiltinProviders } from "@pizza-bot/inference-providers";
import { createPizzaBotAgent } from "@pizza-bot/runtime-langgraph";
import { GraphManager } from "./graph-manager.js";

vi.mock("@pizza-bot/runtime-langgraph", async () => ({
  ...(await vi.importActual<typeof import("@pizza-bot/runtime-langgraph")>(
    "@pizza-bot/runtime-langgraph",
  )),
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

  it("rebuilds when a grant becomes writable, since eval's tool bridge is fixed at build", async () => {
    const models = new ModelRegistry();
    await registerBuiltinProviders(models);
    let readOnly = true;
    const registry = new GraphManager({
      modelId: MODEL_ID,
      models,
      dependencies: {
        localFolders: () => [{
          id: "notes",
          label: "Notes",
          path: "/host/notes",
          virtualPath: "/local/notes",
          readOnly,
          createdAt: "2026-01-01T00:00:00.000Z",
        }],
      },
    });

    await registry.initialize(await models.buildModel(MODEL_ID));
    expect(vi.mocked(createPizzaBotAgent)).toHaveBeenCalledTimes(1);

    await registry.ensureSettings();
    expect(vi.mocked(createPizzaBotAgent)).toHaveBeenCalledTimes(1);

    readOnly = false;
    await registry.ensureSettings();
    expect(vi.mocked(createPizzaBotAgent)).toHaveBeenCalledTimes(2);
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
