import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openAppDatabase, type AppDatabase } from "@pizza-bot/storage";
import { JUDGE_BATCH, numberEvidenceLines, type ThreadState } from "@pizza-bot/core";
import { GroundingJudge, type JudgeModel } from "./grounding-judge.js";
import { fakeJudge, supportAll } from "./grounding-judge.test-support.js";

const THREAD = "t1";
const LEDGER = "Plan: Standard. Renewal: 2027-03-04. Two free swaps per year.";


describe("GroundingJudge", () => {
  let dir: string;
  let app: AppDatabase;
  let evidenceId: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "grounding-judge-"));
    app = openAppDatabase(":memory:", undefined, dir);
    evidenceId = app.evidence!.record({
      threadId: THREAD,
      runId: "r1",
      toolRef: "mcp:billing:account",
      breadcrumb: "billing account",
      body: numberEvidenceLines(LEDGER),
      bytes: LEDGER.length,
      truncated: false,
    })!.id;
  });

  afterEach(() => {
    app.close();
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  const judgeWith = (resolveJudge: () => Promise<JudgeModel | undefined>) =>
    new GroundingJudge({ evidence: app.evidence, resolveJudge });

  const args = (...claims: string[]) => ({
    body: claims.join(" "),
    // Every claim cites the whole ledger: [1] plan, [2] renewal, [3] swaps.
    _grounding: claims.map((text) => ({ arg: "body", text, cites: [{ evidenceId, lines: [1, 2, 3] }] })),
  });

  it("asks the judge once per claim, however often the claim is graded", async () => {
    const model = fakeJudge(supportAll);
    const judge = judgeWith(async () => model);
    const first = await judge.audit(THREAD, args("Your plan renews in 2027."));
    const again = await judge.audit(THREAD, { ...args("Your plan renews in 2027."), to: "x@example.test" });

    expect(first).toEqual(again);
    expect(first.judge).toBe("test:judge");
    expect(first.spans[0]?.tier).toBe("verifiable");
    expect(model.calls).toBe(1);
  });

  it("shares one in-flight judgement between a card and an approval that ask together", async () => {
    const model = fakeJudge(supportAll);
    const judge = judgeWith(async () => model);
    await Promise.all([
      judge.audit(THREAD, args("Your plan renews in 2027.")),
      judge.audit(THREAD, args("Your plan renews in 2027.")),
    ]);
    expect(model.calls).toBe(1);
  });

  it("asks again after a failure instead of pinning it", async () => {
    let fail = true;
    const model = fakeJudge((claim, source) => {
      if (fail) throw new Error("timeout");
      return supportAll(claim, source);
    });
    const judge = judgeWith(async () => model);
    const failed = await judge.audit(THREAD, args("Your plan renews in 2027."));
    fail = false;
    const retried = await judge.audit(THREAD, args("Your plan renews in 2027."));

    expect(failed.spans[0]?.gap).toEqual({ reason: "judge-error" });
    expect(retried.spans[0]?.tier).toBe("verifiable");
    expect(model.calls).toBe(2);
  });

  it("splits a large approval across several calls", async () => {
    const model = fakeJudge(supportAll);
    const claims = Array.from({ length: JUDGE_BATCH + 1 }, (_, i) => `Claim ${String.fromCharCode(97 + i)} renews in 2027.`);
    const { spans } = await judgeWith(async () => model).audit(THREAD, args(...claims));
    expect(spans.every((span) => span.tier === "verifiable")).toBe(true);
    expect(model.calls).toBe(2);
  });

  it("reports claims unchecked when no judge is configured", async () => {
    const { judge, spans } = await judgeWith(async () => undefined).audit(THREAD, args("Two free swaps."));
    expect(judge).toBeNull();
    expect(spans[0]).toMatchObject({ tier: "inconclusive", gap: { reason: "unjudged" } });
  });

  it("reports a judge that cannot be built as a failed judgement, not as checking switched off", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const { judge, spans } = await judgeWith(async () => {
      throw new Error("no credentials");
    }).audit(THREAD, args("Two free swaps."));
    expect(judge).toBe("unavailable");
    expect(spans[0]).toMatchObject({ tier: "inconclusive", gap: { reason: "judge-error" } });
    error.mockRestore();
  });

  it("grades every action of a pending interrupt in order, and nothing for one it is not holding", async () => {
    const model = fakeJudge(supportAll);
    const judge = judgeWith(async () => model);
    const state: ThreadState = {
      threadId: THREAD,
      checkpointId: "c1",
      values: { messages: [] },
      next: ["tools"],
      createdAt: "t0",
      awaitingInput: true,
      interrupts: [
        {
          id: "approval-1",
          value: {
            actionRequests: [
              { name: "mcp:mail:send", args: args("Two free swaps.") },
              { name: "mcp:mail:send", args: { body: "Nothing cited." } },
            ],
            reviewConfigs: [{ allowedDecisions: ["approve"] }],
          },
        },
      ],
    };

    const audits = await judge.auditInterrupt(THREAD, state, "approval-1");
    expect(audits?.map((audit) => audit.spans.map((s) => s.tier))).toEqual([["verifiable"], []]);
    expect(await judge.auditInterrupt(THREAD, state, "approval-gone")).toBeUndefined();
  });
});
