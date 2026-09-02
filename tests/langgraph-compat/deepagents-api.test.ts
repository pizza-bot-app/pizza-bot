import { describe, it, expect } from "vitest";

/** API surface pins for deepagents@1.13.2 and @langchain/langgraph@1.4.13. */
describe("DeepAgents API surface pins", () => {
  it("deepagents exports createDeepAgent + the four backends", async () => {
    const m = await import("deepagents");
    expect(typeof m.createDeepAgent).toBe("function");
    expect(typeof m.StateBackend).toBe("function");
    expect(typeof m.FilesystemBackend).toBe("function");
    expect(typeof m.StoreBackend).toBe("function");
    expect(typeof m.CompositeBackend).toBe("function");
  });

  it("deepagents derives summarization thresholds from maxInputTokens", async () => {
    const { computeSummarizationDefaults } = await import("deepagents");

    expect(computeSummarizationDefaults({
      profile: { maxInputTokens: 200_000 },
    } as never)).toEqual({
      trigger: { type: "fraction", value: 0.85 },
      keep: { type: "fraction", value: 0.1 },
      truncateArgsSettings: {
        trigger: { type: "fraction", value: 0.85 },
        keep: { type: "fraction", value: 0.1 },
      },
    });
  });

  it("the runtime prevents Codex profiles from restoring todo middleware", async () => {
    await import("@pizza-bot/runtime-langgraph");
    const m = await import("deepagents");
    const profile = m.getHarnessProfile("openai:gpt-5.2-codex");
    expect(profile?.excludedMiddleware.has("todoListMiddleware")).toBe(true);
  });

  it("@langchain/langgraph exports MemorySaver (NOT InMemorySaver), Command, interrupt", async () => {
    const m = (await import("@langchain/langgraph")) as Record<string, unknown>;
    expect(typeof m.MemorySaver).toBe("function");
    expect(m.InMemorySaver).toBeUndefined();
    expect(typeof m.Command).toBe("function");
    expect(typeof m.interrupt).toBe("function");
  });

  it("@langchain/langgraph-checkpoint-sqlite exports SqliteSaver.fromConnString", async () => {
    const m = await import("@langchain/langgraph-checkpoint-sqlite");
    expect(typeof m.SqliteSaver).toBe("function");
    expect(typeof m.SqliteSaver.fromConnString).toBe("function");
  });

  it("@langchain/quickjs exports createCodeInterpreterMiddleware (dynamic subagents)", async () => {
    const m = (await import("@langchain/quickjs")) as Record<string, unknown>;
    expect(typeof m.createCodeInterpreterMiddleware).toBe("function");
  });
});
