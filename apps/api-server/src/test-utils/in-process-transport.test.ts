import { describe, it, expect } from "vitest";
import type { ProtocolEvent } from "@langchain/langgraph";
import type { RunInput, RunOptions, ThreadState } from "@pizza-bot/core";
import { ProtocolRunManager } from "../protocol-run-manager.js";
import { InProcessTransport } from "./in-process-transport.js";

const tick = () => new Promise<void>((r) => setTimeout(r, 0));

function frame(method: string, namespace: string[] = [], data: unknown = {}): ProtocolEvent {
  return { type: "event", seq: 0, method, params: { namespace, timestamp: 0, data } } as ProtocolEvent;
}

function twoFrameStream() {
  return (_i: RunInput, opts: RunOptions): AsyncIterable<ProtocolEvent> => ({
    async *[Symbol.asyncIterator]() {
      yield frame("messages", ["model_request:a"], { event: "content-block-delta", delta: { type: "text-delta", text: "hi" } });
      yield frame("values", [], {});
      if (opts.signal?.aborted) return;
    },
  });
}

const fakeAgent = {
  getState: async (threadId: string): Promise<ThreadState> => ({
    threadId,
    checkpointId: "ckpt_1",
    values: { messages: [] },
    next: [],
    createdAt: "2026-01-01T00:00:00Z",
  }),
};

async function drainAll(handle: {
  events: AsyncIterable<ProtocolEvent>;
  close?: () => void;
}): Promise<ProtocolEvent[]> {
  const out: ProtocolEvent[] = [];
  const iter = handle.events[Symbol.asyncIterator]();
  const IDLE = Symbol("idle");
  for (;;) {
    const idle = new Promise<typeof IDLE>((r) => setTimeout(() => r(IDLE), 10));
    const res = await Promise.race([iter.next(), idle]);
    if (res === IDLE) {
      handle.close?.();
      await iter.next().catch(() => undefined);
      break;
    }
    if (res.done) break;
    out.push(res.value);
  }
  return out;
}

describe("InProcessTransport", () => {
  it("run.start echoes {run_id} and its frames replay through openEventStream", async () => {
    const mgr = new ProtocolRunManager(twoFrameStream());
    const transport = new InProcessTransport(mgr, fakeAgent, "t1");

    const res = await transport.send({ id: 1, method: "run.start", params: { input: { messages: [{ role: "user", content: "hi" }] } } });
    expect(res).toMatchObject({ type: "success", id: 1, result: { run_id: expect.stringMatching(/^run_/) } });
    await tick();

    const handle = transport.openEventStream({ channels: ["messages", "values", "lifecycle"] });
    await handle.ready;
    const frames = await drainAll(handle);
    expect(frames.map((f) => f.method)).toEqual(["messages", "values", "lifecycle"]);
    expect((frames.at(-1)!.params.data as { event?: string }).event).toBe("completed");
  });

  it("openEventStream honors the since cursor (replay after reconnect)", async () => {
    const mgr = new ProtocolRunManager(twoFrameStream());
    const transport = new InProcessTransport(mgr, fakeAgent, "t2");
    await transport.send({ id: 1, method: "run.start", params: {} });
    await tick();

    const full = await drainAll(transport.openEventStream({ channels: ["messages", "values", "lifecycle"] }));
    const tail = await drainAll(transport.openEventStream({ channels: ["messages", "values", "lifecycle"], since: 0 }));
    expect(full.length).toBeGreaterThan(tail.length);
    expect(Math.min(...tail.map((e) => e.seq!))).toBeGreaterThan(0);
  });

  it("state.get returns the agent's checkpointed state in the protocol shape", async () => {
    const mgr = new ProtocolRunManager(twoFrameStream());
    const transport = new InProcessTransport(mgr, fakeAgent, "t3");
    const res = (await transport.send({ id: 7, method: "state.get", params: {} })) as { result: Record<string, unknown> };
    expect(res.result).toMatchObject({
      values: { messages: [] },
      checkpoint_id: "ckpt_1",
      thread_id: "t3",
      next: [],
      tasks: [],
    });
  });

  it("rejects commands whose configurable thread differs from the transport thread", async () => {
    const mgr = new ProtocolRunManager(twoFrameStream());
    const transport = new InProcessTransport(mgr, fakeAgent, "url-thread");

    await expect(
      transport.send({
        id: 1,
        method: "run.start",
        params: { config: { configurable: { thread_id: "other-thread" } } },
      }),
    ).rejects.toThrow("configurable.thread_id must match URL thread url-thread");
    expect(mgr.isRunning("url-thread")).toBe(false);
    expect(mgr.isRunning("other-thread")).toBe(false);
  });

  it("run.stop cancels the active run", async () => {
    const streamFn = (_i: RunInput, opts: RunOptions): AsyncIterable<ProtocolEvent> => ({
      async *[Symbol.asyncIterator]() {
        yield frame("messages", []);
        await new Promise<void>((resolve) => {
          if (opts.signal?.aborted) return resolve();
          opts.signal?.addEventListener("abort", () => resolve(), { once: true });
        });
      },
    });
    const mgr = new ProtocolRunManager(streamFn);
    const ends: string[] = [];
    mgr.onEnd(({ status }) => ends.push(status));
    const transport = new InProcessTransport(mgr, fakeAgent, "t4");
    await transport.send({ id: 1, method: "run.start", params: {} });
    await tick();
    await transport.send({ id: 2, method: "run.stop", params: {} });
    await tick();
    expect(ends).toEqual(["cancelled"]);
  });

  it("getState() hydration returns the {values} shape", async () => {
    const mgr = new ProtocolRunManager(twoFrameStream());
    const transport = new InProcessTransport(mgr, fakeAgent, "t5");
    const state = await transport.getState();
    expect(state).toMatchObject({ values: { messages: [] }, next: [] });
  });
});
