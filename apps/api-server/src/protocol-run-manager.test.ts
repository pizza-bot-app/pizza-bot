import { describe, it, expect, vi } from "vitest";
import type { ProtocolEvent } from "@langchain/langgraph";
import { ModelUnavailableError, type RunInput, type RunOptions } from "@pizza-bot/core";
import { ProtocolRunManager, frameMatchesFilter, decideTerminal } from "./protocol-run-manager.js";

const tick = () => new Promise<void>((r) => setTimeout(r, 0));

function frame(method: string, namespace: string[] = [], data: unknown = {}): ProtocolEvent {
  return { type: "event", seq: 0, method, params: { namespace, timestamp: 0, data } } as ProtocolEvent;
}

function controllable() {
  let push!: (ev: ProtocolEvent) => void;
  let finish!: () => void;
  const streamFn = (_input: RunInput, _opts: RunOptions): AsyncIterable<ProtocolEvent> => {
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

async function drainSome(it: AsyncIterable<ProtocolEvent>, n: number): Promise<ProtocolEvent[]> {
  const out: ProtocolEvent[] = [];
  for await (const ev of it) {
    out.push(ev);
    if (out.length >= n) break;
  }
  return out;
}

describe("frameMatchesFilter", () => {
  it("matches on channel and honors custom: prefix + namespace/depth", () => {
    expect(frameMatchesFilter(frame("messages"), { channels: ["messages"] })).toBe(true);
    expect(frameMatchesFilter(frame("values"), { channels: ["messages"] })).toBe(false);
    expect(frameMatchesFilter(frame("input.requested"), { channels: ["input"] })).toBe(true);
    expect(frameMatchesFilter(frame("custom", [], { name: "foo" }), { channels: ["custom"] })).toBe(true);
    const nested = frame("messages", ["tools:X", "model_request:y"]);
    expect(frameMatchesFilter(nested, { channels: ["messages"], namespaces: [["tools:X"]] })).toBe(true);
    expect(frameMatchesFilter(nested, { channels: ["messages"], namespaces: [["tools:X"]], depth: 0 })).toBe(false);
    expect(frameMatchesFilter(nested, { channels: ["messages"], namespaces: [["other"]] })).toBe(false);
  });
});

describe("decideTerminal", () => {
  it("an explicit cancel synthesizes a CANCELLED frame, status cancelled", () => {
    expect(
      decideTerminal({ aborted: true, superseded: false, sawTerminalRoot: false, interrupted: false, failed: false }),
    ).toEqual({ synthesize: "cancelled", status: "cancelled" });
  });

  it("a supersede synthesizes NOTHING but still reports cancelled", () => {
    expect(
      decideTerminal({ aborted: true, superseded: true, sawTerminalRoot: false, interrupted: false, failed: false }),
    ).toEqual({ synthesize: null, status: "cancelled" });
  });

  it("a clean end with no stream terminal synthesizes completed", () => {
    expect(
      decideTerminal({ aborted: false, superseded: false, sawTerminalRoot: false, interrupted: false, failed: false }),
    ).toEqual({ synthesize: "completed", status: "success" });
  });

  it("does not double-synthesize when the stream already emitted a terminal", () => {
    expect(
      decideTerminal({ aborted: false, superseded: false, sawTerminalRoot: true, interrupted: false, failed: false }),
    ).toEqual({ synthesize: null, status: "success" });
  });

  it("reports interrupted / error status from a stream-emitted terminal", () => {
    expect(
      decideTerminal({ aborted: false, superseded: false, sawTerminalRoot: true, interrupted: true, failed: false }).status,
    ).toBe("interrupted");
    expect(
      decideTerminal({ aborted: false, superseded: false, sawTerminalRoot: true, interrupted: false, failed: true }).status,
    ).toBe("error");
  });

  it("abort wins over interrupted/failed flags", () => {
    expect(
      decideTerminal({ aborted: true, superseded: false, sawTerminalRoot: true, interrupted: true, failed: true }).status,
    ).toBe("cancelled");
  });
});

describe("ProtocolRunManager", () => {
  it("whenIdle waits only for runs active at its call boundary", async () => {
    const controls: Array<ReturnType<typeof controllable>> = [];
    const mgr = new ProtocolRunManager((input, opts) => {
      const control = controllable();
      controls.push(control);
      return control.streamFn(input, opts);
    });

    mgr.start("first", {} as RunInput);
    const boundary = mgr.whenIdle();
    mgr.start("later", {} as RunInput);
    controls[0]!.finish();
    await expect(boundary).resolves.toBeUndefined();
    expect(mgr.isRunning("later")).toBe(true);
    controls[1]!.finish();
  });

  it("shutdown refuses new runs and aborts+awaits active ones before resolving", async () => {
    let sawAbort = false;
    let settled = false;
    const streamFn = (_i: RunInput, opts: RunOptions): AsyncIterable<ProtocolEvent> => ({
      async *[Symbol.asyncIterator]() {
        yield frame("messages", []);
        await new Promise<void>((resolve) => {
          if (opts.signal?.aborted) return resolve();
          opts.signal?.addEventListener(
            "abort",
            () => {
              sawAbort = true;
              resolve();
            },
            { once: true },
          );
        });
        settled = true;
      },
    });
    const mgr = new ProtocolRunManager(streamFn);
    mgr.start("s1", {} as RunInput);
    await tick();

    const done = mgr.shutdown();
    // A run in flight must not still be running once shutdown resolves.
    await expect(done).resolves.toBeUndefined();
    expect(sawAbort).toBe(true);
    expect(settled).toBe(true);
    expect(mgr.isRunning("s1")).toBe(false);

    expect(() => mgr.start("s2", {} as RunInput)).toThrow(/shutting down/);
  });

  it("buffers frames by a monotonic seq and synthesizes a terminal root lifecycle", async () => {
    const { streamFn, push, finish } = controllable();
    const mgr = new ProtocolRunManager(streamFn);
    const handle = mgr.start("t1", {} as RunInput);
    expect(handle.runId).toMatch(/^run_/);

    push(frame("messages", ["model_request:a"], { event: "content-block-delta", delta: { type: "text-delta", text: "hi" } }));
    push(frame("values", [], {}));
    finish();
    await tick();

    const all = await drainAll((sig) => mgr.observe("t1", { channels: ["messages", "values", "lifecycle"] }, sig));
    expect(all.map((e) => e.seq)).toEqual([0, 1, 2]);
    expect(
      all.map(
        (e) => (e as ProtocolEvent & { event_id?: string }).event_id,
      ),
    ).toEqual([
      `${handle.runId}:0`,
      `${handle.runId}:1`,
      `${handle.runId}:2`,
    ]);
    const last = all.at(-1)!;
    expect(last.method).toBe("lifecycle");
    expect(last.params.namespace).toEqual([]);
    expect((last.params.data as { event?: string }).event).toBe("completed");
  });

  it("replays only frames with seq > since on reconnect", async () => {
    const { streamFn, push, finish } = controllable();
    const mgr = new ProtocolRunManager(streamFn);
    mgr.start("t2", {} as RunInput);
    for (let i = 0; i < 5; i++) push(frame("messages", [], { i }));
    finish();
    await tick();

    const full = await drainAll((sig) => mgr.observe("t2", { channels: ["messages", "lifecycle"] }, sig));
    const tail = await drainAll((sig) => mgr.observe("t2", { channels: ["messages", "lifecycle"], since: 2 }, sig));
    expect(full.length).toBeGreaterThan(tail.length);
    expect(Math.min(...tail.map((e) => e.seq!))).toBeGreaterThan(2);
  });

  it("replays events missed while an active run stream is reconnecting", async () => {
    const { streamFn, push, finish } = controllable();
    const mgr = new ProtocolRunManager(streamFn);
    mgr.start("t-reconnect", {} as RunInput);
    push(frame("messages", [], { text: "before disconnect" }));
    await tick();

    const before = await drainSome(
      mgr.observe("t-reconnect", { channels: ["messages"] }),
      1,
    );
    const cursor = before[0]!.seq!;
    push(frame("messages", [], { text: "during reconnect" }));
    await tick();

    const after = await drainSome(
      mgr.observe("t-reconnect", { channels: ["messages"], since: cursor }),
      1,
    );
    expect(after.map((event) => event.params.data)).toEqual([
      { text: "during reconnect" },
    ]);

    finish();
  });

  it("filters replayed frames to the subscription's channels", async () => {
    const { streamFn, push, finish } = controllable();
    const mgr = new ProtocolRunManager(streamFn);
    mgr.start("t3", {} as RunInput);
    push(frame("messages", []));
    push(frame("values", []));
    push(frame("tools", []));
    finish();
    await tick();

    const onlyValues = await drainAll((sig) => mgr.observe("t3", { channels: ["values"] }, sig));
    expect(onlyValues.every((e) => e.method === "values")).toBe(true);
    expect(onlyValues).toHaveLength(1);
  });

  it("a fresh run.start on a thread supersedes the prior run's buffer", async () => {
    const controls: Array<{
      push: (ev: ProtocolEvent) => void;
      finish: () => void;
    }> = [];
    const streamFn = (_i: RunInput, _o: RunOptions): AsyncIterable<ProtocolEvent> => {
      const c = controllable();
      controls.push({ push: c.push, finish: c.finish });
      return c.streamFn(_i, _o);
    };
    const mgr = new ProtocolRunManager(streamFn);
    const first = mgr.start("t4", {} as RunInput);
    controls[0]!.push(frame("messages", [], { gen: 1 }));
    await tick();

    const second = mgr.start("t4", {} as RunInput);
    expect(second.runId).not.toBe(first.runId);
    controls[0]!.finish();
    await vi.waitFor(() => expect(controls).toHaveLength(2));
    controls[1]!.push(frame("messages", [], { gen: 2 }));
    controls[1]!.finish();
    await tick();

    const seen = await drainAll((sig) => mgr.observe("t4", { channels: ["messages", "lifecycle"] }, sig));
    const gens = seen.filter((e) => e.method === "messages").map((e) => (e.params.data as { gen?: number }).gen);
    expect(gens).toEqual([2]);
  });

  it("waits for a superseded run to settle before starting its replacement", async () => {
    let calls = 0;
    let releaseCleanup!: () => void;
    const cleanup = new Promise<void>((resolve) => {
      releaseCleanup = resolve;
    });
    const streamFn = (_input: RunInput, opts: RunOptions): AsyncIterable<ProtocolEvent> => {
      const call = ++calls;
      return {
        [Symbol.asyncIterator]() {
          let consumed = false;
          return {
            next: async () => {
              if (consumed || call !== 1) {
                return { done: true, value: undefined };
              }
              consumed = true;
              await new Promise<void>((resolve) => {
                if (opts.signal?.aborted) return resolve();
                opts.signal?.addEventListener("abort", () => resolve(), { once: true });
              });
              await cleanup;
              return { done: true, value: undefined };
            },
          };
        },
      };
    };
    const mgr = new ProtocolRunManager(streamFn);

    mgr.start("serialized", {} as RunInput);
    await tick();
    mgr.start("serialized", {} as RunInput);
    await tick();
    expect(calls).toBe(1);

    releaseCleanup();
    await vi.waitFor(() => expect(calls).toBe(2));
  });

  it("a single long-lived observe() follows a SUCCEEDING run after the first completes", async () => {
    let latest!: { push: (ev: ProtocolEvent) => void; finish: () => void };
    const streamFn = (_i: RunInput, _o: RunOptions): AsyncIterable<ProtocolEvent> => {
      const c = controllable();
      latest = { push: c.push, finish: c.finish };
      return c.streamFn(_i, _o);
    };
    const mgr = new ProtocolRunManager(streamFn);

    const seen: ProtocolEvent[] = [];
    const ac = new AbortController();
    void (async () => {
      for await (const ev of mgr.observe("t-multi", { channels: ["messages", "lifecycle"] }, ac.signal)) {
        seen.push(ev);
      }
    })();

    mgr.start("t-multi", {} as RunInput);
    latest.push(frame("messages", [], { gen: 1 }));
    latest.finish();
    await tick();

    mgr.start("t-multi", {} as RunInput);
    latest.push(frame("messages", [], { gen: 2 }));
    latest.finish();
    await tick();
    await tick();

    ac.abort();
    const gens = seen.filter((e) => e.method === "messages").map((e) => (e.params.data as { gen?: number }).gen);
    expect(gens).toEqual([1, 2]);
  });

  it("onEnd reports status=success when the stream completes normally", async () => {
    const { streamFn, push, finish } = controllable();
    const mgr = new ProtocolRunManager(streamFn);
    const ends: Array<{ threadId: string; status: string }> = [];
    mgr.onEnd(({ threadId, status }) => ends.push({ threadId, status }));
    mgr.start("t6", {} as RunInput);
    push(frame("messages", []));
    finish();
    await tick();
    expect(ends).toEqual([{ threadId: "t6", status: "success" }]);
  });

  it("onEnd reports status=interrupted when the stream emits lifecycle:interrupted", async () => {
    const { streamFn, push, finish } = controllable();
    const mgr = new ProtocolRunManager(streamFn);
    const ends: Array<{ threadId: string; status: string }> = [];
    mgr.onEnd(({ threadId, status }) => ends.push({ threadId, status }));
    mgr.start("t-hitl", {} as RunInput);
    push(frame("messages", []));
    push(frame("lifecycle", [], { event: "interrupted", graph_name: "root" }));
    finish();
    await tick();
    expect(ends).toEqual([{ threadId: "t-hitl", status: "interrupted" }]);
  });

  it("onEnd reports status=error when the underlying stream throws", async () => {
    const streamFn = (_i: RunInput, _o: RunOptions): AsyncIterable<ProtocolEvent> => ({
      // eslint-disable-next-line require-yield
      async *[Symbol.asyncIterator]() {
        throw new Error("boom");
      },
    });
    const mgr = new ProtocolRunManager(streamFn);
    const ends: string[] = [];
    mgr.onEnd(({ status }) => ends.push(status));
    mgr.start("t7", {} as RunInput);
    await tick();
    expect(ends).toEqual(["error"]);
  });

  it("synthesizes a coded root lifecycle:failed frame when the stream throws (classifyError)", async () => {
    const streamFn = (_i: RunInput, _o: RunOptions): AsyncIterable<ProtocolEvent> => ({
      // eslint-disable-next-line require-yield
      async *[Symbol.asyncIterator]() {
        throw new Error("ThrottlingException: rate limit exceeded");
      },
    });
    const mgr = new ProtocolRunManager(streamFn);
    mgr.start("t7b", {} as RunInput);
    await tick();
    const frames = await drainAll((sig) => mgr.observe("t7b", { channels: ["lifecycle"] }, sig));
    const failed = frames.find(
      (e) => e.method === "lifecycle" && e.params.namespace.length === 0 && (e.params.data as { event?: string }).event === "failed",
    );
    expect(failed).toBeDefined();
    const data = failed!.params.data as { message?: string; code?: string };
    expect(data.message).toContain("rate limit");
    expect(data.code).toBe("RATE_LIMIT");
  });

  it("surfaces a bad model selection as a MODEL_UNAVAILABLE-coded failed frame", async () => {
    const streamFn = (_i: RunInput, _o: RunOptions): AsyncIterable<ProtocolEvent> => ({
      // eslint-disable-next-line require-yield
      async *[Symbol.asyncIterator]() {
        throw new ModelUnavailableError(
          "bedrock:retired-model",
          "build-failed",
          'Model "bedrock:retired-model" could not be built by the "bedrock" provider.',
        );
      },
    });
    const mgr = new ProtocolRunManager(streamFn);
    mgr.start("t7c", {} as RunInput);
    await tick();
    const frames = await drainAll((sig) => mgr.observe("t7c", { channels: ["lifecycle"] }, sig));
    const failed = frames.find(
      (e) => e.method === "lifecycle" && e.params.namespace.length === 0 && (e.params.data as { event?: string }).event === "failed",
    );
    expect(failed).toBeDefined();
    const data = failed!.params.data as { message?: string; code?: string };
    expect(data.code).toBe("MODEL_UNAVAILABLE");
    expect(data.message).toContain("could not be built");
  });

  it("onEnd reports status=cancelled when a run is superseded/cancelled", async () => {
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
    mgr.start("t8", {} as RunInput);
    await tick();
    mgr.cancel("t8");
    await tick();
    expect(ends).toEqual(["cancelled"]);
  });

  it("cancelAndWait does not settle until abort cleanup finishes", async () => {
    let releaseCleanup!: () => void;
    const cleanup = new Promise<void>((resolve) => {
      releaseCleanup = resolve;
    });
    const streamFn = (_i: RunInput, opts: RunOptions): AsyncIterable<ProtocolEvent> => ({
      async *[Symbol.asyncIterator]() {
        yield frame("messages", []);
        await new Promise<void>((resolve) => {
          if (opts.signal?.aborted) return resolve();
          opts.signal?.addEventListener("abort", () => resolve(), { once: true });
        });
        await cleanup;
      },
    });
    const mgr = new ProtocolRunManager(streamFn);
    const handle = mgr.start("cancel-wait", {} as RunInput);
    await tick();

    let returned = false;
    const cancelling = mgr.cancelAndWait("cancel-wait", handle.runId).then((result) => {
      returned = true;
      return result;
    });
    await tick();
    expect(returned).toBe(false);

    releaseCleanup();
    await expect(cancelling).resolves.toEqual({ accepted: true, settled: true });
  });

  it("cancelAndWait reports a cancellation that misses its deadline", async () => {
    const streamFn = (_i: RunInput): AsyncIterable<ProtocolEvent> => ({
      async *[Symbol.asyncIterator]() {
        yield frame("messages", []);
        await new Promise<void>(() => {});
      },
    });
    const mgr = new ProtocolRunManager(streamFn);
    const handle = mgr.start("cancel-timeout", {} as RunInput);
    await tick();

    await expect(mgr.cancelAndWait("cancel-timeout", handle.runId, 10)).resolves.toEqual({
      accepted: true,
      settled: false,
    });
  });

  it("discardThread aborts and drains a run without firing lifecycle hooks", async () => {
    let streamSettled = false;
    const streamFn = (_i: RunInput, opts: RunOptions): AsyncIterable<ProtocolEvent> => ({
      async *[Symbol.asyncIterator]() {
        yield frame("messages", []);
        await new Promise<void>((resolve) => {
          if (opts.signal?.aborted) return resolve();
          opts.signal?.addEventListener("abort", () => resolve(), { once: true });
        });
        streamSettled = true;
      },
    });
    const mgr = new ProtocolRunManager(streamFn);
    const ends: string[] = [];
    mgr.onEnd(({ status }) => ends.push(status));
    mgr.start("t-discard", {} as RunInput);
    await tick();

    await mgr.discardThread("t-discard");

    expect(streamSettled).toBe(true);
    expect(mgr.isRunning("t-discard")).toBe(false);
    expect(ends).toEqual([]);
  });

  it("discardThread removes a completed run without re-emitting its end", async () => {
    const { streamFn, finish } = controllable();
    const mgr = new ProtocolRunManager(streamFn);
    const ends: string[] = [];
    mgr.onEnd(({ status }) => ends.push(status));
    mgr.start("t-complete-discard", {} as RunInput);
    finish();
    await tick();
    expect(ends).toEqual(["success"]);

    await mgr.discardThread("t-complete-discard");

    expect(mgr.isRunning("t-complete-discard")).toBe(false);
    expect(ends).toEqual(["success"]);
  });

  it("discardThread drains an active run and its queued replacement", async () => {
    let calls = 0;
    let settled = 0;
    const streamFn = (_i: RunInput, opts: RunOptions): AsyncIterable<ProtocolEvent> => {
      calls++;
      return {
        // eslint-disable-next-line require-yield
        async *[Symbol.asyncIterator]() {
          await new Promise<void>((resolve) => {
            if (opts.signal?.aborted) return resolve();
            opts.signal?.addEventListener("abort", () => resolve(), { once: true });
          });
          settled++;
        },
      };
    };
    const mgr = new ProtocolRunManager(streamFn);
    const ends: string[] = [];
    mgr.onEnd(({ status }) => ends.push(status));
    mgr.start("t-superseded-discard", {} as RunInput);
    mgr.start("t-superseded-discard", {} as RunInput);

    await mgr.discardThread("t-superseded-discard");

    expect(calls).toBe(1);
    expect(settled).toBe(1);
    expect(mgr.isRunning("t-superseded-discard")).toBe(false);
    expect(ends).toEqual([]);
  });

  it("beginThreadDeletion blocks new runs until cleanup releases the thread", async () => {
    const mgr = new ProtocolRunManager(async function* () {
      yield frame("messages", []);
    });
    const release = await mgr.beginThreadDeletion("t-fenced");

    expect(() => mgr.start("t-fenced", {} as RunInput)).toThrow(
      "Cannot start a run while thread t-fenced is being deleted",
    );

    release();
    expect(() => mgr.start("t-fenced", {} as RunInput)).not.toThrow();
  });

  it("beginThreadDeletion ends observers parked on a thread with no run", async () => {
    const mgr = new ProtocolRunManager(async function* () {
      yield frame("messages", []);
    });
    let observerEnded = false;
    void (async () => {
      for await (const _event of mgr.observe("t-parked", { channels: ["messages"] })) {
        // This observer should end without yielding when deletion wakes it.
      }
      observerEnded = true;
    })();
    await tick();

    const release = await mgr.beginThreadDeletion("t-parked");
    await tick();

    expect(observerEnded).toBe(true);
    release();
  });

  it("an explicit cancel emits a terminal root lifecycle:failed(CANCELLED) frame", async () => {
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
    mgr.start("t8b", {} as RunInput);
    await tick();
    mgr.cancel("t8b");
    await tick();
    const frames = await drainAll((sig) => mgr.observe("t8b", { channels: ["lifecycle"] }, sig));
    const terminal = frames.find(
      (e) => e.method === "lifecycle" && e.params.namespace.length === 0 && (e.params.data as { event?: string }).event === "failed",
    );
    expect(terminal).toBeDefined();
    expect((terminal!.params.data as { code?: string }).code).toBe("CANCELLED");
    expect(ends).toEqual(["cancelled"]);
  });

  it("a supersede does NOT inject a spurious terminal for the superseded run", async () => {
    const controls: Array<{
      push: (ev: ProtocolEvent) => void;
      finish: () => void;
    }> = [];
    const streamFn = (_i: RunInput, _o: RunOptions): AsyncIterable<ProtocolEvent> => {
      const c = controllable();
      controls.push({ push: c.push, finish: c.finish });
      return c.streamFn(_i, _o);
    };
    const mgr = new ProtocolRunManager(streamFn);
    mgr.start("t8c", {} as RunInput);
    controls[0]!.push(frame("messages", [], { gen: 1 }));
    await tick();
    mgr.start("t8c", {} as RunInput);
    controls[0]!.finish();
    await vi.waitFor(() => expect(controls).toHaveLength(2));
    controls[1]!.push(frame("messages", [], { gen: 2 }));
    controls[1]!.finish();
    await tick();
    const frames = await drainAll((sig) => mgr.observe("t8c", { channels: ["messages", "lifecycle"] }, sig));
    const failed = frames.filter(
      (e) => e.method === "lifecycle" && (e.params.data as { event?: string }).event === "failed",
    );
    expect(failed).toEqual([]);
    const completed = frames.filter(
      (e) => e.method === "lifecycle" && (e.params.data as { event?: string }).event === "completed",
    );
    expect(completed).toHaveLength(1);
  });

  it("a caught-up observer keeps receiving frames after the ring buffer rolls over", async () => {
    const { streamFn, push, finish } = controllable();
    const mgr = new ProtocolRunManager(streamFn, { bufferCap: 4 });

    const seen: ProtocolEvent[] = [];
    const ac = new AbortController();
    void (async () => {
      for await (const ev of mgr.observe("roll", { channels: ["messages"] }, ac.signal)) {
        seen.push(ev);
      }
    })();
    await tick();

    const N = 20;
    mgr.start("roll", {} as RunInput);
    for (let i = 0; i < N; i++) {
      push(frame("messages", [], { i }));
      await tick();
    }
    finish();
    await tick();
    ac.abort();

    const is = seen.filter((e) => e.method === "messages").map((e) => (e.params.data as { i: number }).i);
    expect(is).toEqual(Array.from({ length: N }, (_, i) => i));
  });

  it("does not leak abort listeners across many wakeups on a long stream", async () => {
    const { streamFn, push, finish } = controllable();
    const mgr = new ProtocolRunManager(streamFn);

    const live = new Set<unknown>();
    const signal = new AbortController().signal;
    const mut = signal as unknown as {
      addEventListener: (...a: unknown[]) => unknown;
      removeEventListener: (...a: unknown[]) => unknown;
    };
    const realAdd = mut.addEventListener.bind(signal);
    const realRemove = mut.removeEventListener.bind(signal);
    mut.addEventListener = (type: unknown, cb: unknown, opts?: unknown) => {
      if (type === "abort") live.add(cb);
      const wrapped =
        opts && typeof opts === "object" && (opts as { once?: boolean }).once
          ? (...a: unknown[]) => {
              live.delete(cb);
              return (cb as (...x: unknown[]) => unknown)(...a);
            }
          : cb;
      return realAdd(type, wrapped, opts);
    };
    mut.removeEventListener = (type: unknown, cb: unknown, opts?: unknown) => {
      if (type === "abort") live.delete(cb);
      return realRemove(type, cb, opts);
    };

    const seen: ProtocolEvent[] = [];
    void (async () => {
      for await (const ev of mgr.observe("leak", { channels: ["messages"] }, signal)) {
        seen.push(ev);
      }
    })();
    await tick();

    mgr.start("leak", {} as RunInput);
    for (let i = 0; i < 50; i++) {
      push(frame("messages", [], { i }));
      await tick();
    }
    finish();
    await tick();

    expect(live.size).toBeLessThanOrEqual(1);
    expect(seen).toHaveLength(50);
  });

  it("cancel(threadId, runId) ignores a stale run id (does not abort a newer run)", async () => {
    let latest!: { push: (ev: ProtocolEvent) => void; finish: () => void };
    const streamFn = (_i: RunInput, opts: RunOptions): AsyncIterable<ProtocolEvent> => {
      const c = controllable();
      latest = { push: c.push, finish: c.finish };
      const inner = c.streamFn(_i, opts);
      return {
        async *[Symbol.asyncIterator]() {
          for await (const ev of inner) yield ev;
        },
      };
    };
    const mgr = new ProtocolRunManager(streamFn);
    const first = mgr.start("race", {} as RunInput);
    await tick();
    const second = mgr.start("race", {} as RunInput);
    await tick();
    expect(second.runId).not.toBe(first.runId);

    expect(mgr.cancel("race", first.runId)).toBe(false);
    expect(mgr.isRunning("race")).toBe(true);

    expect(mgr.cancel("race", second.runId)).toBe(true);
    latest.finish();
    await tick();
    expect(mgr.isRunning("race")).toBe(false);
  });

  it("does not park forever when the signal aborts in the waitOn registration window", async () => {
    const mgr = new ProtocolRunManager(async function* () {
      yield frame("messages", []);
    });
    // aborted reads false for observe's pre-wait guard, then true — so waitOn sees
    // an already-aborted signal at listener registration (the lost-abort window).
    let reads = 0;
    const signal = {
      get aborted() {
        return reads++ > 0;
      },
      addEventListener() {},
      removeEventListener() {},
    } as unknown as AbortSignal;

    const drained = (async () => {
      for await (const _event of mgr.observe("no-run", { channels: ["messages"] }, signal)) {
        // No run exists, so this parks in waitForRun -> waitOn before ending.
      }
    })();

    const TIMED_OUT = Symbol("timed-out");
    const outcome = await Promise.race([
      drained.then(() => "resolved"),
      new Promise<typeof TIMED_OUT>((r) => setTimeout(() => r(TIMED_OUT), 500)),
    ]);
    expect(outcome).toBe("resolved");
  });

  it("streams opened before run.start park until a run appears", async () => {
    const { streamFn, push, finish } = controllable();
    const mgr = new ProtocolRunManager(streamFn);
    const observed = drainSome(mgr.observe("t5", { channels: ["messages"] }), 1);
    await tick();
    mgr.start("t5", {} as RunInput);
    push(frame("messages", [], { late: true }));
    finish();
    const got = await observed;
    expect(got).toHaveLength(1);
    expect(got[0]!.method).toBe("messages");
  });
});

async function drainAll(
  observe: (signal: AbortSignal) => AsyncIterable<ProtocolEvent>,
): Promise<ProtocolEvent[]> {
  const out: ProtocolEvent[] = [];
  const ac = new AbortController();
  const iter = observe(ac.signal)[Symbol.asyncIterator]();
  const IDLE = Symbol("idle");
  for (;;) {
    const idle = new Promise<typeof IDLE>((r) => setTimeout(() => r(IDLE), 10));
    const res = await Promise.race([iter.next(), idle]);
    if (res === IDLE) {
      ac.abort();
      await iter.next().catch(() => undefined);
      break;
    }
    if (res.done) break;
    out.push(res.value);
  }
  return out;
}
