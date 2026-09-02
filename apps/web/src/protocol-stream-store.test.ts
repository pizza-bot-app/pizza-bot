import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
interface FakeController {
  initialThreadId?: string;
  isLoading: boolean;
  rootMessages: unknown[];
  subagents: Map<string, unknown>;
  submits: Array<{ input: unknown; opts: unknown }>;
  acquiredNamespaces: string[][];
  projectionMessages: Map<string, unknown[]>;
  projectionReleaseCalls: number;
  submitError?: Error;
  completeDuringStop: boolean;
  interrupt?: { id: string; value: unknown };
  rootError?: unknown;
  hydrateCalls: number;
  hydrateErrors: unknown[];
  hydratePromise?: Promise<void>;
  resolveNamespacePromise?: Promise<void>;
  resolveNamespaceCalls: string[];
  stopCalls: number;
  releaseCalls: number;
  fireCompleted: () => void;
  notify: () => void;
}
let last: FakeController;
let cancelCalls: Array<{ threadId: string; runId: string; wait: boolean | undefined }> = [];
let cancelError: Error | undefined;
let nextHydrateErrors: unknown[] = [];
let nextHydratePromise: Promise<void> | undefined;
let controllers: FakeController[] = [];
let clientStateReads: string[] = [];
let transportStateReads: string[] = [];
let protocolStopCalls: Array<{ url: string; body: unknown }> = [];

vi.mock("@langchain/langgraph-sdk", () => ({
  Client: class {
    threads = {
      getState: async (threadId: string) => {
        clientStateReads.push(threadId);
        return null;
      },
    };
    runs = {
      cancel: async (threadId: string, runId: string, wait?: boolean) => {
        cancelCalls.push({ threadId, runId, wait });
        if (cancelError) throw cancelError;
      },
    };
  },
  HttpAgentServerAdapter: class {
    threadId: string;
    constructor(opts: { threadId?: string }) {
      this.threadId = opts.threadId ?? "";
    }
    setThreadId(threadId: string) {
      this.threadId = threadId;
    }
    async getState() {
      transportStateReads.push(this.threadId);
      return null;
    }
  },
}));

vi.mock("@langchain/langgraph-sdk/stream", () => {
  class StreamController {
    private subs = new Set<() => void>();
    isLoading = false;
    rootMessages: unknown[] = [];
    subagents = new Map<string, unknown>();
    submits: Array<{ input: unknown; opts: unknown }> = [];
    acquiredNamespaces: string[][] = [];
    projectionMessages = new Map<string, unknown[]>();
    projectionReleaseCalls = 0;
    stopCalls = 0;
    releaseCalls = 0;
    hydrateCalls = 0;
    hydrateErrors = nextHydrateErrors;
    hydratePromise = nextHydratePromise;
    resolveNamespacePromise?: Promise<void>;
    resolveNamespaceCalls: string[] = [];
    completeDuringStop = false;
    submitError?: Error;
    interrupt?: { id: string; value: unknown };
    rootError?: unknown;
    private onCreated?: (info: { runId: string }) => void;
    private onCompleted?: () => void;
    private currentThreadId?: string;
    private transport?: {
      getState?: () => Promise<unknown>;
      setThreadId?: (threadId: string) => void;
    };
    initialThreadId?: string;
    rootStore = {
      subscribe: (cb: () => void) => {
        this.subs.add(cb);
        return () => this.subs.delete(cb);
      },
      getSnapshot: () => ({
        messages: this.rootMessages,
        values: {},
        isLoading: this.isLoading,
        error: this.rootError,
        interrupt: this.interrupt,
      }),
    };
    subagentStore = {
      subscribe: (cb: () => void) => {
        this.subs.add(cb);
        return () => this.subs.delete(cb);
      },
      getSnapshot: () => this.subagents,
    };
    registry = {
      acquire: (spec: { namespace: readonly string[] }) => {
        const namespace = [...spec.namespace];
        const key = namespace.join("|");
        const subscribers = new Set<() => void>();
        this.acquiredNamespaces.push(namespace);
        return {
          store: {
            subscribe: (cb: () => void) => {
              subscribers.add(cb);
              return () => subscribers.delete(cb);
            },
            getSnapshot: () => this.projectionMessages.get(key) ?? [],
          },
          release: () => {
            this.projectionReleaseCalls++;
          },
        };
      },
    };
    constructor(opts: {
      client: { threads: { getState: (threadId: string) => Promise<unknown> } };
      threadId?: string;
      transport?: {
        getState?: () => Promise<unknown>;
        setThreadId?: (threadId: string) => void;
      };
      onCreated?: (info: { runId: string }) => void;
      onCompleted?: () => void;
    }) {
      this.initialThreadId = opts.threadId;
      this.currentThreadId = opts.threadId;
      this.transport = opts.transport;
      this.onCreated = opts.onCreated;
      this.onCompleted = opts.onCompleted;
      if (opts.threadId) {
        void (opts.transport?.getState?.() ?? opts.client.threads.getState(opts.threadId));
      }
      last = this as unknown as FakeController;
      controllers.push(last);
    }
    activate() {
      return () => {
        this.releaseCalls++;
      };
    }
    async submit(input: unknown, opts: { threadId?: string } | undefined) {
      if (opts?.threadId !== undefined && opts.threadId !== this.currentThreadId) {
        this.currentThreadId = opts.threadId;
        await this.transport?.getState?.();
        this.transport?.setThreadId?.(opts.threadId);
      }
      this.submits.push({ input, opts });
      if (this.submitError) throw this.submitError;
      this.onCreated?.({ runId: `r${this.submits.length}` });
    }
    async stop(_options?: { cancel?: boolean }) {
      this.stopCalls++;
      if (this.completeDuringStop) this.onCompleted?.();
      this.isLoading = false;
    }
    async respond() {}
    async hydrate() {
      this.hydrateCalls++;
      await this.hydratePromise;
      const error = this.hydrateErrors.shift();
      if (error !== undefined) {
        this.rootError = error;
        throw error;
      }
    }
    async resolveSubagentNamespace(delegationId: string) {
      this.resolveNamespaceCalls.push(delegationId);
      await this.resolveNamespacePromise;
    }
    fireCompleted() {
      this.onCompleted?.();
    }
    notify() {
      this.subs.forEach((cb) => cb());
    }
  }
  return {
    StreamController,
    messagesProjection: (namespace: readonly string[]) => ({ namespace }),
  };
});

const { ProtocolStreamStore } = await import("./protocol-stream-store.js");

const TID = "t1";

const flush = () => new Promise((r) => setTimeout(r, 0));

describe("ProtocolStreamStore steering-enqueue", () => {
  let store: InstanceType<typeof ProtocolStreamStore>;
  beforeEach(() => {
    cancelCalls = [];
    cancelError = undefined;
    nextHydrateErrors = [];
    nextHydratePromise = undefined;
    controllers = [];
    clientStateReads = [];
    transportStateReads = [];
    protocolStopCalls = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      protocolStopCalls.push({
        url: String(input),
        body: init?.body ? JSON.parse(init.body as string) : undefined,
      });
      return new Response(null, { status: 204 });
    }));
    store = new ProtocolStreamStore();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("binds a fresh thread on first submit without fetching missing state", async () => {
    await store.attach(TID, false);

    expect(last.initialThreadId).toBeUndefined();
    expect(clientStateReads).toEqual([]);
    expect(transportStateReads).toEqual([]);

    await store.send(TID, "hello");

    expect(last.submits[0]!.opts).toEqual({ threadId: TID });
    expect(clientStateReads).toEqual([]);
    expect(transportStateReads).toEqual([]);
  });

  it("submits immediately when the thread is idle", async () => {
    await store.send(TID, "hello");
    await flush();
    expect(last.submits).toHaveLength(1);
    expect(last.submits[0]!.input).toEqual({ messages: [{ role: "user", content: "hello" }] });
    expect(store.getSlice(TID).queued).toEqual([]);
  });

  it("QUEUES (does not submit) when a run is streaming", async () => {
    await store.send(TID, "first");
    await flush();
    last.isLoading = true;
    last.notify();

    await store.send(TID, "steer me");
    await flush();
    expect(last.submits).toHaveLength(1);
    expect(store.getSlice(TID).queued).toEqual(["steer me"]);
  });

  it("drains queued entries as separate turns with their own config and attachments", async () => {
    const attachment = {
      id: "a1",
      url: "attachment://a1",
      mediaType: "text/plain",
      filename: "one.txt",
      sizeBytes: 3,
    };
    await store.send(TID, "first");
    await flush();
    last.isLoading = true;
    last.notify();
    await store.send(TID, "steer one", "model-1", [attachment]);
    await store.send(TID, "steer two", "model-2");
    await flush();
    expect(store.getSlice(TID).queued).toEqual(["steer one", "steer two"]);

    last.isLoading = false;
    last.fireCompleted();
    await flush();

    expect(last.submits).toHaveLength(2);
    last.fireCompleted();
    await flush();

    expect(last.submits).toHaveLength(3);
    expect(last.submits[1]!.input).toEqual({
      messages: [{
        role: "user",
        parts: [
          { type: "text", text: "steer one" },
          {
            type: "file",
            url: "attachment://a1",
            mediaType: "text/plain",
            name: "one.txt",
            sizeBytes: 3,
          },
        ],
      }],
    });
    expect(last.submits[1]!.opts).toEqual({
      config: { configurable: { model: "model-1" } },
    });
    expect(last.submits[2]).toEqual({
      input: { messages: [{ role: "user", content: "steer two" }] },
      opts: { config: { configurable: { model: "model-2" } } },
    });
    expect(store.getSlice(TID).queued).toEqual([]);
  });

  it("restores queued input when the drain submission fails", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    await store.send(TID, "first");
    last.isLoading = true;
    last.notify();
    await store.send(TID, "do not lose me");
    last.submitError = new Error("offline");

    last.isLoading = false;
    last.fireCompleted();
    await flush();

    expect(store.getSlice(TID).queued).toEqual(["do not lose me"]);
    expect(errorSpy).toHaveBeenCalledOnce();
    errorSpy.mockRestore();
  });

  it("cancelQueued removes a queued steer before it drains", async () => {
    await store.send(TID, "first");
    await flush();
    last.isLoading = true;
    last.notify();
    await store.send(TID, "keep");
    await store.send(TID, "drop");
    expect(store.getSlice(TID).queued).toEqual(["keep", "drop"]);

    store.cancelQueued(TID, 1);
    expect(store.getSlice(TID).queued).toEqual(["keep"]);

    last.isLoading = false;
    last.fireCompleted();
    await flush();
    expect(last.submits[1]!.input).toEqual({ messages: [{ role: "user", content: "keep" }] });
  });

  it("steerNow stops the run then submits the steer", async () => {
    await store.send(TID, "first");
    await flush();
    last.isLoading = true;
    last.notify();

    await store.steerNow(TID, "now!");
    await flush();
    expect(last.stopCalls).toBe(1);
    const lastSubmit = last.submits[last.submits.length - 1]!;
    expect(lastSubmit.input).toEqual({ messages: [{ role: "user", content: "now!" }] });
    expect(store.getSlice(TID).queued).toEqual([]);
  });

  it("does not double-drain when completion races a successful steer stop", async () => {
    await store.send(TID, "first");
    last.isLoading = true;
    last.notify();
    last.completeDuringStop = true;

    await store.steerNow(TID, "now!");
    await flush();

    expect(last.stopCalls).toBe(1);
    expect(cancelCalls).toEqual([
      { threadId: TID, runId: "r1", wait: true },
    ]);
    expect(last.submits).toHaveLength(2);
    expect(last.submits[1]!.input).toEqual({
      messages: [{ role: "user", content: "now!" }],
    });
  });

  it("leaves a steer queued when strict cancellation does not settle", async () => {
    const cancellationError = new Error("cancel deadline exceeded");
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    await store.send(TID, "first");
    last.isLoading = true;
    last.notify();
    cancelError = cancellationError;

    await expect(store.steerNow(TID, "later")).rejects.toBe(cancellationError);

    expect(last.submits).toHaveLength(1);
    expect(store.getSlice(TID).queued).toEqual(["later"]);

    cancelError = undefined;
    last.isLoading = false;
    last.fireCompleted();
    await flush();

    expect(last.submits).toHaveLength(2);
    expect(store.getSlice(TID).queued).toEqual([]);
    expect(errorSpy).not.toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  it("waits for server cancellation before clearing explicit-stop loading", async () => {
    await store.send(TID, "first");
    last.isLoading = true;
    last.notify();

    await expect(store.stop(TID)).resolves.toBeUndefined();

    expect(last.stopCalls).toBe(1);
    expect(store.getSlice(TID).status).toBe("idle");
    expect(cancelCalls).toEqual([
      { threadId: TID, runId: "r1", wait: true },
    ]);
  });

  it("keeps streaming when explicit server cancellation misses its deadline", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    await store.send(TID, "first");
    last.isLoading = true;
    last.notify();
    cancelError = new Error("cancel deadline exceeded");

    await store.stop(TID);

    expect(last.stopCalls).toBe(0);
    expect(store.getSlice(TID).status).toBe("streaming");
    expect(errorSpy).toHaveBeenCalledOnce();
    errorSpy.mockRestore();
  });

  it("stops a hydrated run through run.stop when no run ID is known", async () => {
    await store.attach(TID, false);
    last.isLoading = true;
    last.notify();

    await store.stop(TID);

    expect(protocolStopCalls).toHaveLength(1);
    expect(protocolStopCalls[0]).toMatchObject({
      url: "http://localhost/api/threads/t1/commands",
      body: { method: "run.stop", params: {} },
    });
    expect(last.stopCalls).toBe(1);
    expect(store.getSlice(TID).status).toBe("idle");
  });

  it("queues ordinary input while interrupted and drains after HITL resolves", async () => {
    await store.send(TID, "first");
    last.interrupt = { id: "int-1", value: { action_requests: [] } };
    last.notify();
    expect(store.getSlice(TID).status).toBe("interrupted");

    await store.send(TID, "after approval", "model-2");
    await store.steerNow(TID, "also after approval");

    expect(last.submits).toHaveLength(1);
    expect(last.stopCalls).toBe(0);
    expect(store.getSlice(TID).queued).toEqual([
      "after approval",
      "also after approval",
    ]);

    last.interrupt = undefined;
    last.fireCompleted();
    await flush();

    expect(last.submits).toHaveLength(2);
    last.fireCompleted();
    await flush();

    expect(last.submits).toHaveLength(3);
    expect(last.submits[1]!.opts).toEqual({
      config: { configurable: { model: "model-2" } },
    });
    expect(store.getSlice(TID).queued).toEqual([]);
  });

  it("exposes hydration errors and retries a later attach", async () => {
    const offline = new Error("offline");
    nextHydrateErrors = [offline];
    const attach = store.attach(TID, true);

    await expect(attach).rejects.toBe(offline);
    expect(last.hydrateCalls).toBe(1);
    expect(store.getSlice(TID)).toMatchObject({
      attached: false,
      hydrationStatus: "error",
      hydrationError: "offline",
      status: "error",
      errorText: "offline",
      errorCode: "GENERAL",
    });

    await store.attach(TID, true);

    expect(last.hydrateCalls).toBe(2);
    expect(store.getSlice(TID)).toMatchObject({
      attached: true,
      hydrationStatus: "ready",
      hydrationError: undefined,
      status: "idle",
    });
  });

  it("surfaces a failed run's error text and classified code", async () => {
    await store.attach(TID, false);
    await store.send(TID, "what can you do?");
    await flush();

    // The SDK writes the terminal failure to root.error, then notifies.
    last.rootError = new Error("Could not load credentials from any providers");
    last.isLoading = false;
    last.notify();

    expect(store.getSlice(TID)).toMatchObject({
      status: "error",
      errorText: "Could not load credentials from any providers",
      errorCode: "AUTH_EXPIRED",
    });
  });

  it("clears a prior run error once the next run resolves", async () => {
    await store.attach(TID, false);
    last.rootError = new Error("Could not load credentials from any providers");
    last.notify();
    expect(store.getSlice(TID).status).toBe("error");

    // A fresh run clears root.error; the slice must drop the stale banner.
    last.rootError = undefined;
    last.notify();
    expect(store.getSlice(TID)).toMatchObject({
      status: "idle",
      errorText: undefined,
      errorCode: undefined,
    });
  });

  it("projects an errored task result as a failed delegation after the subagent settles", async () => {
    await store.attach(TID, false);
    last.rootMessages = [
      {
        id: "assistant-1",
        tool_calls: [{
          id: "task-1",
          name: "task",
          args: { description: "look up accounts", subagent_type: "sfdc-assistant" },
        }],
      },
      {
        tool_call_id: "task-1",
        status: "error",
        content: 'Error running tool "task": search_accounts rejected its arguments',
      },
    ];
    last.subagents = new Map([[
      "task-1",
      {
        id: "task-1",
        name: "sfdc-assistant",
        status: "complete",
        taskInput: "look up accounts",
        namespace: [],
        parentId: null,
        depth: 0,
      },
    ]]);

    last.notify();

    expect(store.getSlice(TID).delegations["task-1"]).toMatchObject({
      status: "error",
      errorText: 'Error running tool "task": search_accounts rejected its arguments',
    });
  });

  it("marks an in-flight delegation as awaiting input while an approval is pending", async () => {
    await store.attach(TID, false);
    last.subagents = new Map([[
      "task-1",
      {
        id: "task-1",
        name: "mail-assistant",
        status: "running",
        taskInput: "send the note",
        namespace: [],
        parentId: null,
        depth: 0,
      },
    ]]);
    last.notify();

    expect(store.getSlice(TID).delegations["task-1"]).toMatchObject({ status: "running" });

    last.interrupt = { id: "int-1", value: { action_requests: [] } };
    last.notify();

    expect(store.getSlice(TID).delegations["task-1"]).toMatchObject({ status: "awaiting-input" });
    expect(store.getSlice(TID).delegations["task-1"]!.errorText).toBeUndefined();

    // Approval resolves the pause; the delegation resumes as ordinary work.
    last.interrupt = undefined;
    last.notify();

    expect(store.getSlice(TID).delegations["task-1"]).toMatchObject({ status: "running" });
  });

  it("keeps a settled delegation's own outcome while an approval is pending", async () => {
    await store.attach(TID, false);
    last.subagents = new Map([
      [
        "task-1",
        {
          id: "task-1",
          name: "mail-assistant",
          status: "complete",
          taskInput: "send the note",
          namespace: [],
          parentId: null,
          depth: 0,
        },
      ],
      [
        "task-2",
        {
          id: "task-2",
          name: "sfdc-assistant",
          status: "error",
          error: "search_accounts rejected its arguments",
          taskInput: "look up accounts",
          namespace: [],
          parentId: null,
          depth: 0,
        },
      ],
    ]);
    last.interrupt = { id: "int-1", value: { action_requests: [] } };
    last.notify();

    const { delegations } = store.getSlice(TID);
    expect(delegations["task-1"]).toMatchObject({ status: "completed" });
    expect(delegations["task-2"]).toMatchObject({ status: "error" });
  });

  it("acquires a hydrated subagent transcript after namespace resolution", async () => {
    await store.attach(TID, true);
    let resolveNamespace!: () => void;
    last.resolveNamespacePromise = new Promise<void>((resolve) => {
      resolveNamespace = resolve;
    });
    last.subagents = new Map([[
      "task-1",
      {
        id: "task-1",
        name: "researcher",
        status: "complete",
        namespace: ["tools:task-1"],
        parentId: null,
        depth: 0,
      },
    ]]);
    last.projectionMessages.set("tools:worker-1", [
      {
        id: "assistant-1",
        content: "",
        tool_calls: [{ id: "search-1", name: "search", args: { q: "pizza" } }],
      },
      {
        id: "tool-1",
        tool_call_id: "search-1",
        content: "found it",
      },
    ]);

    const handle = store.openSubagentTranscript(TID, "task-1");
    expect(handle).not.toBeNull();
    const notify = vi.fn();
    const unsubscribe = handle!.subscribe(notify);
    expect(last.acquiredNamespaces).toEqual([]);

    last.subagents = new Map([[
      "task-1",
      {
        id: "task-1",
        name: "researcher",
        status: "complete",
        namespace: ["tools:worker-1"],
        parentId: null,
        depth: 0,
      },
    ]]);
    resolveNamespace();
    await flush();

    expect(last.resolveNamespaceCalls).toEqual(["task-1"]);
    expect(last.acquiredNamespaces).toEqual([["tools:worker-1"]]);
    expect(notify).toHaveBeenCalled();
    expect(handle!.getMessages()[0]!.parts[0]).toMatchObject({
      type: "tool-search",
      toolCallId: "search-1",
      state: "output-available",
      output: "found it",
    });

    unsubscribe();
    handle!.release();
    expect(last.projectionReleaseCalls).toBe(1);
  });

  it("does not acquire a subagent projection after the handle is released", async () => {
    await store.attach(TID, true);
    let resolveNamespace!: () => void;
    last.resolveNamespacePromise = new Promise<void>((resolve) => {
      resolveNamespace = resolve;
    });
    last.subagents = new Map([[
      "task-1",
      {
        id: "task-1",
        name: "researcher",
        status: "complete",
        namespace: ["tools:task-1"],
        parentId: null,
        depth: 0,
      },
    ]]);

    const handle = store.openSubagentTranscript(TID, "task-1");
    handle!.release();
    resolveNamespace();
    await flush();

    expect(last.acquiredNamespaces).toEqual([]);
    expect(last.projectionReleaseCalls).toBe(0);
  });

  it("exposes unattached, loading, and ready hydration states", async () => {
    let resolveHydration!: () => void;
    nextHydratePromise = new Promise<void>((resolve) => {
      resolveHydration = resolve;
    });

    expect(store.getSlice(TID).hydrationStatus).toBe("unattached");
    const attach = store.attach(TID, true);
    expect(store.getSlice(TID)).toMatchObject({
      attached: false,
      hydrationStatus: "loading",
    });

    resolveHydration();
    await attach;

    expect(store.getSlice(TID)).toMatchObject({
      attached: true,
      hydrationStatus: "ready",
    });
  });

  it("seals an unmatched tool call once refreshed history is settled", async () => {
    let resolveHydration!: () => void;
    nextHydratePromise = new Promise<void>((resolve) => {
      resolveHydration = resolve;
    });

    const attach = store.attach(TID, true);
    last.rootMessages = [{
      id: ["langchain", "AIMessage"],
      tool_calls: [{ id: "eval-1", name: "eval", args: { code: "1 + 1" } }],
    }];
    last.notify();

    expect(store.getSlice(TID).messages[0]!.parts[0]).toMatchObject({
      toolCallId: "eval-1",
      state: "input-available",
    });

    resolveHydration();
    await attach;

    expect(store.getSlice(TID)).toMatchObject({ status: "idle", hydrationStatus: "ready" });
    expect(store.getSlice(TID).messages[0]!.parts[0]).toMatchObject({
      toolCallId: "eval-1",
      state: "output-error",
      errorText: "Run ended before this tool finished.",
    });
  });

  it("keeps an unmatched tool call running while the root is loading", async () => {
    await store.attach(TID, false);
    last.isLoading = true;
    last.rootMessages = [{
      id: ["langchain", "AIMessage"],
      tool_calls: [{ id: "eval-1", name: "eval", args: { code: "1 + 1" } }],
    }];
    last.notify();

    expect(store.getSlice(TID)).toMatchObject({ status: "streaming" });
    expect(store.getSlice(TID).messages[0]!.parts[0]).toMatchObject({
      toolCallId: "eval-1",
      state: "input-available",
    });
  });

  it("treats a missing checkpoint as a ready fresh thread", async () => {
    const missing = Object.assign(new Error("missing"), { status: 404 });
    nextHydrateErrors = [missing];
    const attach = store.attach(TID, true);

    await expect(attach).resolves.toBeUndefined();

    expect(store.getSlice(TID)).toMatchObject({
      attached: true,
      hydrationStatus: "ready",
      hydrationError: undefined,
    });
  });

  it("disposes a deleted thread's controller and cached slice", async () => {
    await store.send(TID, "hello");

    store.disposeThread(TID);

    expect(last.releaseCalls).toBe(1);
    expect(store.getSlice(TID).messages).toEqual([]);
  });

  it("keeps multiple local drafts discoverable before server metadata exists", async () => {
    await store.attach("one", false);
    await store.attach("two", false);

    const known = store.knownThreadIds();
    expect(known).toEqual(["one", "two"]);
    expect(store.knownThreadIds()).toBe(known);

    store.disposeThread("one");
    expect(store.knownThreadIds()).toEqual(["two"]);
  });

  it("publishes every parallel local completion exactly once", async () => {
    await store.attach("one", false);
    await store.attach("two", false);
    const completed = vi.fn();
    const unsubscribe = store.subscribeRunCompletions(completed);

    await store.send("one", "first");
    await store.send("two", "second");
    controllers[0]!.fireCompleted();
    controllers[0]!.fireCompleted();
    await flush();
    controllers[1]!.fireCompleted();

    expect(completed.mock.calls).toEqual([["one"], ["two"]]);

    unsubscribe();
  });

  it("starts five rapid conversations without exceeding the browser stream budget", async () => {
    const sends = Array.from({ length: 5 }, (_, index) =>
      store.send(`thread-${index}`, `message-${index}`),
    );
    await flush();

    expect(controllers.map((controller) => controller.submits.length)).toEqual([
      1, 1, 0, 0, 0,
    ]);
    expect(store.getSlice("thread-2").queued).toEqual(["message-2"]);
    expect(store.getSlice("thread-3").queued).toEqual(["message-3"]);
    expect(store.getSlice("thread-4").queued).toEqual(["message-4"]);

    controllers[0]!.fireCompleted();
    await flush();
    expect(controllers[0]!.releaseCalls).toBe(1);
    expect(controllers.map((controller) => controller.submits.length)).toEqual([
      1, 1, 1, 0, 0,
    ]);

    controllers[1]!.fireCompleted();
    await flush();
    expect(controllers[1]!.releaseCalls).toBe(1);
    expect(controllers.map((controller) => controller.submits.length)).toEqual([
      1, 1, 1, 1, 0,
    ]);

    controllers[2]!.fireCompleted();
    await flush();
    expect(controllers[2]!.releaseCalls).toBe(1);
    expect(controllers.map((controller) => controller.submits.length)).toEqual([
      1, 1, 1, 1, 1,
    ]);
    expect(store.getSlice("thread-4").queued).toEqual([]);

    await Promise.all(sends);
  });

  it("keeps a background conversation streaming while another conversation is active", async () => {
    await store.attach("one", false);
    const first = controllers[0]!;
    first.isLoading = true;
    first.rootMessages = [{ id: "a1", content: "first chunk" }];
    first.notify();
    expect(store.getSlice("one").status).toBe("streaming");

    const unsubscribe = store.subscribe("one", vi.fn());
    unsubscribe();
    await store.attach("two", false);
    const second = controllers[1]!;

    first.rootMessages = [{ id: "a1", content: "complete response" }];
    first.notify();

    expect(store.getSlice("one")).toMatchObject({
      status: "streaming",
      messages: [
        expect.objectContaining({
          parts: [expect.objectContaining({ text: "complete response" })],
        }),
      ],
    });
    expect(first.releaseCalls).toBe(0);
    expect(second.releaseCalls).toBe(0);
  });

  it("rehydrates a remounted conversation after releasing its idle controller", async () => {
    await store.attach(TID, true);
    const original = controllers[0]!;

    const unsubscribe = store.subscribe(TID, vi.fn());
    unsubscribe();
    await store.attach(TID, true);

    expect(controllers).toHaveLength(2);
    expect(original.hydrateCalls).toBe(1);
    expect(original.releaseCalls).toBe(1);
    expect(controllers[1]!.hydrateCalls).toBe(1);
  });

  it("releases least-recent idle controllers while retaining their slices", async () => {
    store = new ProtocolStreamStore(2);
    await store.attach("one", false);
    await store.attach("two", false);
    await store.attach("three", false);

    expect(controllers).toHaveLength(3);
    expect(controllers[0]!.releaseCalls).toBe(1);
    expect(controllers[1]!.releaseCalls).toBe(0);
    expect(store.getSlice("one").hydrationStatus).toBe("ready");
  });

  it("creates a new controller and rehydrates when an evicted thread reopens", async () => {
    store = new ProtocolStreamStore(1);
    await store.attach("one", false);
    const evicted = controllers[0]!;
    await store.attach("two", false);

    expect(evicted.releaseCalls).toBe(1);
    await store.attach("one", true);

    expect(controllers).toHaveLength(3);
    expect(controllers[2]!.hydrateCalls).toBe(1);
    expect(store.getSlice("one").hydrationStatus).toBe("ready");
  });

  it("submits one file part for one completed attachment", async () => {
    const attachment = {
      id: "a1",
      url: "attachment://a1",
      mediaType: "text/plain",
      filename: "one.txt",
      sizeBytes: 3,
    };

    await store.send(TID, "with file", undefined, [attachment]);

    expect(last.submits[0]!.input).toEqual({
      messages: [{
        role: "user",
        parts: [
          { type: "text", text: "with file" },
          {
            type: "file",
            url: "attachment://a1",
            mediaType: "text/plain",
            name: "one.txt",
            sizeBytes: 3,
          },
        ],
      }],
    });
  });

  it("returns above-limit background controllers to the bound as runs complete", async () => {
    store = new ProtocolStreamStore(1);
    await store.send("one", "first");
    const first = controllers[0]!;
    await store.send("two", "second");
    const second = controllers[1]!;

    first.fireCompleted();
    second.fireCompleted();

    expect(first.releaseCalls + second.releaseCalls).toBe(2);
  });

  it("releases a completed background controller without waiting for other runs", async () => {
    store = new ProtocolStreamStore(1);
    await store.send("one", "first");
    const first = controllers[0]!;
    await store.send("two", "second");

    first.fireCompleted();

    expect(first.releaseCalls).toBe(1);
    expect(controllers[1]!.releaseCalls).toBe(0);
  });
});
