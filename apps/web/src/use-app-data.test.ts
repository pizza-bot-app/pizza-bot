import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ApiClient, MemoryDoc, MemoryInfo, StatusInfo } from "@/api-client";

const react = vi.hoisted(() => ({
  cleanups: [] as Array<() => void>,
  stateWrites: [] as unknown[][],
  stateIndex: 0,
}));

vi.mock("react", () => ({
  useCallback: <T>(callback: T) => callback,
  useEffect: (effect: () => void | (() => void)) => {
    const cleanup = effect();
    if (cleanup) react.cleanups.push(cleanup);
  },
  useRef: <T>(initial: T) => ({ current: initial }),
  useState: <T>(initial: T) => {
    const index = react.stateIndex++;
    react.stateWrites[index] = [];
    return [initial, (next: T) => react.stateWrites[index]!.push(next)] as const;
  },
}));

const { useMemoriesAdmin, useStatus } = await import("./use-app-data.js");

const memory = (id: string): MemoryInfo => ({
  id,
  preview: id,
  size: id.length,
  updatedAt: "2026-08-04T00:00:00.000Z",
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function clientWith(
  listMemories: () => Promise<MemoryInfo[]>,
  createMemory: (id: string, content: string) => Promise<MemoryDoc> = async (id, content) => ({ id, content }),
) {
  return { listMemories, createMemory } as unknown as ApiClient;
}

function statusWithMcp(
  servers: StatusInfo["mcp"]["servers"],
): StatusInfo {
  const loaded = servers.filter((server) => server.status === "loaded").length;
  const disabled = servers.filter((server) => server.status === "disabled").length;
  const total = servers.length - disabled;
  return {
    model: "bedrock:test",
    timezone: "America/Los_Angeles",
    inference: { available: true, connected: 1, total: 1, providers: [] },
    mcp: {
      available: total > 0 && loaded === total,
      loaded,
      total,
      disabled,
      servers,
    },
    timestamp: "2026-08-10T00:00:00.000Z",
  };
}

describe("useMemoriesAdmin freshness", () => {
  beforeEach(() => {
    react.cleanups.splice(0).forEach((cleanup) => cleanup());
    react.stateWrites = [];
    react.stateIndex = 0;
    vi.useFakeTimers();
  });

  afterEach(() => {
    react.cleanups.splice(0).forEach((cleanup) => cleanup());
    vi.useRealTimers();
  });

  it("polls for memories created outside the admin module", async () => {
    let memories = [memory("user-interests")];
    const listMemories = vi.fn(async () => memories);

    useMemoriesAdmin(clientWith(listMemories), 100);
    await Promise.resolve();

    memories = [memory("calculation-history"), ...memories];
    await vi.advanceTimersByTimeAsync(100);

    expect(listMemories).toHaveBeenCalledTimes(2);
    expect(react.stateWrites[0]!.at(-1)).toEqual(memories);
  });

  it("does not load or poll while its panel is disabled", async () => {
    const listMemories = vi.fn(async () => [memory("user-interests")]);

    useMemoriesAdmin(clientWith(listMemories), 100, false);
    await vi.advanceTimersByTimeAsync(500);

    expect(listMemories).not.toHaveBeenCalled();
  });

  it("does not let a stale initial read overwrite the post-create refresh", async () => {
    const initial = deferred<MemoryInfo[]>();
    const refreshed = deferred<MemoryInfo[]>();
    const listMemories = vi
      .fn<() => Promise<MemoryInfo[]>>()
      .mockReturnValueOnce(initial.promise)
      .mockReturnValueOnce(refreshed.promise);
    const admin = useMemoriesAdmin(clientWith(listMemories), 60_000);

    const create = admin.create("calculation-history", "# Calculation History");
    await Promise.resolve();
    refreshed.resolve([memory("calculation-history"), memory("user-interests")]);
    await create;

    initial.resolve([memory("user-interests")]);
    await Promise.resolve();

    expect(react.stateWrites[0]!.at(-1)).toEqual([
      memory("calculation-history"),
      memory("user-interests"),
    ]);
  });
});

describe("useStatus polling", () => {
  beforeEach(() => {
    react.cleanups.splice(0).forEach((cleanup) => cleanup());
    react.stateWrites = [];
    react.stateIndex = 0;
    vi.useFakeTimers();
  });

  afterEach(() => {
    react.cleanups.splice(0).forEach((cleanup) => cleanup());
    vi.useRealTimers();
  });

  it("polls quickly while MCP servers load, then returns to the steady cadence", async () => {
    const loading = statusWithMcp([
      { name: "mail", status: "loading", toolCount: 0 },
    ]);
    const loaded = statusWithMcp([
      { name: "mail", status: "loaded", toolCount: 3 },
    ]);
    const getStatus = vi.fn<() => Promise<StatusInfo | undefined>>()
      .mockResolvedValueOnce(loading)
      .mockResolvedValue(loaded);

    useStatus({ getStatus } as unknown as ApiClient, 100, 10);
    await Promise.resolve();

    await vi.advanceTimersByTimeAsync(9);
    expect(getStatus).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(getStatus).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(99);
    expect(getStatus).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(getStatus).toHaveBeenCalledTimes(3);
  });

  it("does not start another poll while the current request is unresolved", async () => {
    const pending = deferred<StatusInfo | undefined>();
    const getStatus = vi.fn(() => pending.promise);

    useStatus({ getStatus } as unknown as ApiClient, 100, 10);
    await vi.advanceTimersByTimeAsync(1_000);

    expect(getStatus).toHaveBeenCalledTimes(1);
    pending.resolve(statusWithMcp([
      { name: "mail", status: "loading", toolCount: 0 },
    ]));
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(10);

    expect(getStatus).toHaveBeenCalledTimes(2);
  });
});
