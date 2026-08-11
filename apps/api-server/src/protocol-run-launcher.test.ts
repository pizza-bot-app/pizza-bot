import { describe, it, expect } from "vitest";
import type { ProtocolEvent } from "@langchain/langgraph";
import type { RunInput, RunOptions } from "@pizza-bot/core";
import { ProtocolRunManager } from "./protocol-run-manager.js";
import { protocolRunLauncher } from "./protocol-run-launcher.js";
import type { RunScopedEvent } from "./trigger-service.js";

const tick = () => new Promise<void>((r) => setTimeout(r, 0));

function controllable() {
  let push!: (ev: ProtocolEvent) => void;
  let finish!: () => void;
  const streamFn = (_i: RunInput, _o: RunOptions): AsyncIterable<ProtocolEvent> => {
    const queue: ProtocolEvent[] = [];
    let done = false;
    let wake: (() => void) | undefined;
    const bump = () => {
      wake?.();
      wake = undefined;
    };
    push = (ev) => {
      queue.push(ev);
      bump();
    };
    finish = () => {
      done = true;
      bump();
    };
    return {
      async *[Symbol.asyncIterator]() {
        for (;;) {
          while (queue.length) yield queue.shift()!;
          if (done) return;
          await new Promise<void>((r) => (wake = r));
        }
      },
    };
  };
  return { streamFn, push: (ev: ProtocolEvent) => push(ev), finish: () => finish() };
}

describe("protocolRunLauncher", () => {
  it("start() launches a run and returns a live RunHandle", () => {
    const { streamFn } = controllable();
    const mgr = new ProtocolRunManager(streamFn);
    const launcher = protocolRunLauncher(mgr);
    const handle = launcher.start("thread_a", {} as RunInput);
    expect(handle.threadId).toBe("thread_a");
    expect(handle.runId).toMatch(/^run_/);
    expect(handle.status).toBe("running");
  });

  it("subscribe() bridges the manager's onEnd into a run-scoped run-end event", async () => {
    const { streamFn, finish } = controllable();
    const mgr = new ProtocolRunManager(streamFn);
    const launcher = protocolRunLauncher(mgr);
    const seen: RunScopedEvent[] = [];
    launcher.subscribe((evt) => seen.push(evt));

    const handle = launcher.start("thread_b", {} as RunInput);
    finish();
    await tick();

    expect(seen).toHaveLength(1);
    expect(seen[0]!.threadId).toBe("thread_b");
    expect(seen[0]!.runId).toBe(handle.runId);
    expect(seen[0]!.event).toEqual({ type: "run-end", runId: handle.runId, status: "success" });
  });
});
