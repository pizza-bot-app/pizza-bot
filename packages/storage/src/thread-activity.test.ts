import { describe, expect, it, vi } from "vitest";
import { openAppDatabase } from "./app-db.js";

describe("ThreadActivityStore", () => {
  it("orders terminal events behind a durable cursor", () => {
    const app = openAppDatabase(":memory:");
    app.threadActivity.append({
      eventId: "run-1",
      threadId: "thread-1",
      runId: "run-1",
      outcome: "success",
      threadTitle: "First",
      createdAt: "2026-08-09T10:00:00.000Z",
    });
    app.threadActivity.append({
      eventId: "run-2",
      threadId: "thread-2",
      runId: "run-2",
      outcome: "interrupted",
      interruptIds: ["approval-1"],
      threadTitle: "Second",
      createdAt: "2026-08-09T10:01:00.000Z",
    });

    const first = app.threadActivity.listAfter(0);
    expect(first.map((event) => event.runId)).toEqual(["run-1", "run-2"]);
    expect(app.threadActivity.listAfter(first[0]!.seq)).toEqual([first[1]]);
    expect(app.threadActivity.latestSeq()).toBe(first[1]!.seq);
    app.close();
  });

  it("deduplicates event IDs and publishes only new rows", () => {
    const app = openAppDatabase(":memory:");
    const listener = vi.fn();
    app.threadActivity.subscribe(listener);
    const input = {
      eventId: "run-1",
      threadId: "thread-1",
      runId: "run-1",
      outcome: "success" as const,
      threadTitle: "First",
    };

    expect(app.threadActivity.append(input).created).toBe(true);
    expect(app.threadActivity.append(input).created).toBe(false);
    expect(listener).toHaveBeenCalledOnce();
    expect(app.threadActivity.listAfter(0)).toHaveLength(1);
    app.close();
  });

  it("deletes only the activity belonging to a removed thread", () => {
    const app = openAppDatabase(":memory:");
    for (const [eventId, threadId] of [
      ["run-1", "thread-1"],
      ["run-2", "thread-2"],
      ["run-3", "thread-1"],
    ] as const) {
      app.threadActivity.append({
        eventId,
        threadId,
        runId: eventId,
        outcome: "success",
        threadTitle: threadId,
      });
    }

    expect(app.threadActivity.deleteByThread("thread-1")).toBe(2);
    expect(app.threadActivity.deleteByThread("thread-1")).toBe(0);
    expect(
      app.threadActivity.listAfter(0).map((event) => event.threadId),
    ).toEqual(["thread-2"]);
    app.close();
  });
});
