import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SearchHit } from "@/api-client";
import { createConversationSearch } from "./conversation-search.js";

function hit(snippet: string): SearchHit {
  return {
    threadId: "thread-1",
    messageId: snippet,
    role: "assistant",
    snippet,
    highlights: [{ text: snippet, highlighted: true }],
    rank: 1,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

describe("conversation search", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("commits only the latest request", async () => {
    const older = deferred<SearchHit[]>();
    const newer = deferred<SearchHit[]>();
    const searchMessages = vi
      .fn()
      .mockReturnValueOnce(older.promise)
      .mockReturnValueOnce(newer.promise);
    const onHits = vi.fn();
    const onSearching = vi.fn();
    const search = createConversationSearch(
      { searchMessages },
      { onHits, onSearching },
      10,
    );

    search.query("old");
    await vi.advanceTimersByTimeAsync(10);
    search.query("new");
    await vi.advanceTimersByTimeAsync(10);
    newer.resolve([hit("new")]);
    await Promise.resolve();
    await Promise.resolve();
    older.resolve([hit("old")]);
    await Promise.resolve();
    await Promise.resolve();

    expect(onHits).toHaveBeenNthCalledWith(1, []);
    expect(onHits).toHaveBeenNthCalledWith(2, []);
    expect(onHits).toHaveBeenLastCalledWith([hit("new")]);
    expect(onHits).not.toHaveBeenCalledWith([hit("old")]);
    expect(onSearching).toHaveBeenLastCalledWith(false);
  });

  it("invalidates in-flight work when cleared or disposed", async () => {
    const cleared = deferred<SearchHit[]>();
    const disposed = deferred<SearchHit[]>();
    const onHits = vi.fn();
    const onSearching = vi.fn();
    const search = createConversationSearch(
      {
        searchMessages: vi
          .fn()
          .mockReturnValueOnce(cleared.promise)
          .mockReturnValueOnce(disposed.promise),
      },
      { onHits, onSearching },
      10,
    );

    search.query("old");
    await vi.advanceTimersByTimeAsync(10);
    search.query("");
    cleared.resolve([hit("stale")]);
    await Promise.resolve();

    expect(onHits).toHaveBeenLastCalledWith([]);
    expect(onHits).not.toHaveBeenCalledWith([hit("stale")]);
    expect(onSearching).toHaveBeenLastCalledWith(false);

    search.query("later");
    await vi.advanceTimersByTimeAsync(10);
    search.dispose();
    disposed.resolve([hit("also stale")]);
    await Promise.resolve();
    await Promise.resolve();
    expect(onHits).toHaveBeenCalledTimes(3);
  });

  it("catches failures and settles the current search", async () => {
    const failure = new Error("offline");
    const onHits = vi.fn();
    const onSearching = vi.fn();
    const onError = vi.fn();
    const search = createConversationSearch(
      { searchMessages: vi.fn(async () => Promise.reject(failure)) },
      { onHits, onSearching, onError },
      10,
    );

    search.query("pizza");
    await vi.advanceTimersByTimeAsync(10);

    expect(onError).toHaveBeenCalledWith(failure);
    expect(onHits).toHaveBeenCalledWith([]);
    expect(onSearching).toHaveBeenLastCalledWith(false);
  });
});
