import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createDeepAgent: vi.fn(),
  getStateHistory: vi.fn(),
}));

vi.mock("deepagents", async () => {
  const actual = await vi.importActual<typeof import("deepagents")>("deepagents");
  return { ...actual, createDeepAgent: mocks.createDeepAgent };
});

import { createPizzaBotAgent } from "./index.js";

function snapshot(checkpointId: string, checkpointNs = "") {
  return {
    config: { configurable: { thread_id: "t1", checkpoint_id: checkpointId, checkpoint_ns: checkpointNs } },
    values: {},
    next: [],
    createdAt: "t0",
    metadata: {},
    tasks: [],
  };
}

async function agentWithHistory(...snapshots: ReturnType<typeof snapshot>[]) {
  mocks.getStateHistory.mockImplementation(async function* () {
    yield* snapshots;
  });
  mocks.createDeepAgent.mockResolvedValue({ getStateHistory: mocks.getStateHistory });
  return createPizzaBotAgent("prompt", { model: { modelId: "test" } as never });
}

async function drain(iterable: AsyncIterable<unknown>) {
  const out = [];
  for await (const item of iterable) out.push(item);
  return out;
}

describe("LangGraphAgent.getStateHistory", () => {
  beforeEach(() => {
    mocks.createDeepAgent.mockReset();
    mocks.getStateHistory.mockReset();
  });

  it("forwards the page limit to the checkpointer", async () => {
    const agent = await agentWithHistory(snapshot("chk2"));
    await drain(agent.getStateHistory("t1", { limit: 20 }));

    expect(mocks.getStateHistory).toHaveBeenCalledWith(
      { configurable: { thread_id: "t1" } },
      { limit: 20 },
    );
  });

  it("wraps the cursor as the RunnableConfig the checkpointer expects", async () => {
    const agent = await agentWithHistory(snapshot("chk1"));
    await drain(agent.getStateHistory("t1", { limit: 20, beforeCheckpointId: "chk2" }));

    expect(mocks.getStateHistory).toHaveBeenCalledWith(
      { configurable: { thread_id: "t1" } },
      { limit: 20, before: { configurable: { checkpoint_id: "chk2" } } },
    );
  });

  it("bounds a scoped subagent read without losing its namespace", async () => {
    const agent = await agentWithHistory(snapshot("chk2", "tools:sub-1"));
    const states = await drain(
      agent.getStateHistory("t1", { limit: 1, checkpointNs: "tools:sub-1" }),
    );

    expect(mocks.getStateHistory).toHaveBeenCalledWith(
      { configurable: { thread_id: "t1", checkpoint_ns: "tools:sub-1" } },
      { limit: 1 },
    );
    expect(states).toMatchObject([{ checkpointId: "chk2", checkpointNs: "tools:sub-1" }]);
  });

  it("omits absent options rather than passing them as undefined", async () => {
    const agent = await agentWithHistory(snapshot("chk2"));
    await drain(agent.getStateHistory("t1"));

    expect(mocks.getStateHistory).toHaveBeenCalledWith({ configurable: { thread_id: "t1" } }, {});
  });
});
