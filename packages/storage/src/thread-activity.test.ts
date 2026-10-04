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

describe("ApprovalVerdictStore", () => {
  const verdict = (verdictId: string, threadId: string) => ({
    verdictId,
    threadId,
    runId: "run-9",
    interruptId: "approval-1",
    toolName: "mcp:mail:send",
    decision: "approve" as const,
    spans: [
      {
        arg: "body",
        text: "renews on March 4, 2027",
        evidenceId: "ev_1",
        tier: "verifiable" as const,
        breadcrumb: "mcp:mail:search (query: renewal)",
        bytes: 4096,
        truncated: false,
      },
    ],
  });

  it("keeps each span's tier and the evidence identity it was audited against", () => {
    const app = openAppDatabase(":memory:");
    const { verdict: stored } = app.approvalVerdicts.append({
      ...verdict("approval-1#0", "thread-1"),
      createdAt: "2026-09-21T10:00:00.000Z",
    });

    expect(stored).toMatchObject({
      verdictId: "approval-1#0",
      threadId: "thread-1",
      runId: "run-9",
      interruptId: "approval-1",
      toolName: "mcp:mail:send",
      decision: "approve",
      createdAt: "2026-09-21T10:00:00.000Z",
    });
    expect(stored.spans).toEqual(verdict("approval-1#0", "thread-1").spans);
    expect(app.approvalVerdicts.listByThread("thread-1")).toEqual([stored]);
    app.close();
  });

  it("keeps the judge that graded each span, its reasons and its verified support", () => {
    const app = openAppDatabase(":memory:");
    const spans = [
      {
        arg: "body",
        text: "I've waived the $12 fee",
        evidenceId: "ev_1",
        tier: "asserted" as const,
        gap: { reason: "refuted" as const },
        judge: "anthropic:claude-haiku-4-5",
      },
      {
        arg: "body",
        text: "renews on March 4, 2027",
        evidenceId: "ev_1",
        tier: "verifiable" as const,
        judge: "anthropic:claude-haiku-4-5",
        support: ['"renewal_date": "2027-03-04"'],
      },
    ];
    const { verdict: stored } = app.approvalVerdicts.append({
      ...verdict("approval-3#0", "thread-1"),
      spans,
    });

    expect(stored.spans).toEqual(spans);
    expect(app.approvalVerdicts.listByThread("thread-1")[0]?.spans).toEqual(spans);
    app.close();
  });

  it("records an edit decision with the tiers of the text that shipped", () => {
    const app = openAppDatabase(":memory:");
    const { verdict: stored } = app.approvalVerdicts.append({
      ...verdict("approval-2#0", "thread-1"),
      decision: "edit",
      spans: [
        { arg: "body", text: "renews on March 4, 2027", evidenceId: "ev_1", tier: "unresolved" },
      ],
    });

    expect(stored.decision).toBe("edit");
    expect(stored.spans).toEqual([
      { arg: "body", text: "renews on March 4, 2027", evidenceId: "ev_1", tier: "unresolved" },
    ]);
    app.close();
  });

  it("keeps the arguments that went out, so uncited text is still in the record", () => {
    const app = openAppDatabase(":memory:");
    const args = { to: "someone@example.test", body: "Renews on March 4, 2027. Fee is $12.00." };
    const { verdict: stored } = app.approvalVerdicts.append({
      ...verdict("approval-4#0", "thread-1"),
      args,
    });

    expect(stored.args).toEqual(args);
    expect(app.approvalVerdicts.listByThread("thread-1")[0]?.args).toEqual(args);
    app.close();
  });

  it("omits the arguments entirely when none were recorded", () => {
    const app = openAppDatabase(":memory:");
    const { verdict: stored } = app.approvalVerdicts.append(verdict("approval-5#0", "thread-1"));

    expect("args" in stored).toBe(false);
    app.close();
  });

  it("deduplicates a retried decision on the same action", () => {
    const app = openAppDatabase(":memory:");
    const input = verdict("approval-1#0", "thread-1");

    expect(app.approvalVerdicts.append(input).created).toBe(true);
    expect(app.approvalVerdicts.append(input).created).toBe(false);
    expect(app.approvalVerdicts.listByThread("thread-1")).toHaveLength(1);
    app.close();
  });

  it("orders a thread's approvals oldest first", () => {
    const app = openAppDatabase(":memory:");
    for (const id of ["approval-1#0", "approval-1#1", "approval-2#0"]) {
      app.approvalVerdicts.append(verdict(id, "thread-1"));
    }

    expect(
      app.approvalVerdicts.listByThread("thread-1").map((v) => v.verdictId),
    ).toEqual(["approval-1#0", "approval-1#1", "approval-2#0"]);
    app.close();
  });

  it("deletes only the verdicts belonging to a removed thread", () => {
    const app = openAppDatabase(":memory:");
    app.approvalVerdicts.append(verdict("approval-1#0", "thread-1"));
    app.approvalVerdicts.append(verdict("approval-2#0", "thread-2"));

    expect(app.approvalVerdicts.deleteByThread("thread-1")).toBe(1);
    expect(app.approvalVerdicts.deleteByThread("thread-1")).toBe(0);
    expect(app.approvalVerdicts.listByThread("thread-2")).toHaveLength(1);
    app.close();
  });
});
