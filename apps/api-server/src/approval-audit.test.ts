import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openAppDatabase, type AppDatabase } from "@pizza-bot/storage";
import type { ThreadState } from "@pizza-bot/core";
import { approvalAuditor } from "./approval-audit.js";
import { dispatchProtocolCommand } from "./protocol-commands.js";
import type { ProtocolRunManager } from "./protocol-run-manager.js";

const THREAD = "t1";
const BODY = "Your contract renews on March 4, 2027 and includes two free swaps.";
const LEDGER = "Agreement: renews March 4, 2027. Entitlements: two free swaps per year.";

const span = (text: string, evidenceId: string) => ({ arg: "body", text, evidenceId });

describe("approval verdict trail", () => {
  let evidenceDir: string;
  let app: AppDatabase;
  let evidenceId: string;

  beforeEach(() => {
    evidenceDir = mkdtempSync(join(tmpdir(), "approval-audit-"));
    app = openAppDatabase(":memory:", undefined, evidenceDir);
    evidenceId = app.evidence!.record({
      threadId: THREAD,
      runId: "run_paused",
      toolRef: "mcp:mail:search",
      breadcrumb: "mcp:mail:search (query: renewal)",
      body: LEDGER,
      bytes: LEDGER.length,
      truncated: false,
    })!.id;
  });

  afterEach(() => {
    app.close();
    // Windows keeps directory handles briefly after the database closes.
    rmSync(evidenceDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  const interruptValue = (args: unknown, extra: unknown[] = []) => ({
    actionRequests: [{ name: "mcp:mail:send", args }, ...extra],
    reviewConfigs: [{ allowedDecisions: ["approve", "edit", "reject"] }],
  });

  const pausedState = (value: unknown): ThreadState => ({
    threadId: THREAD,
    checkpointId: "chk1",
    values: { messages: [] },
    next: ["tools"],
    createdAt: "t0",
    awaitingInput: true,
    interrupts: [{ id: "approval-1", value }],
  });

  /** Drives the real command dispatcher so the audit runs where a decision lands. */
  const respond = async (value: unknown, resume: unknown) => {
    const getState = vi.fn(async () => pausedState(value));
    const runs = {
      start: () => ({ runId: "run_resume", threadId: THREAD }),
    } as unknown as ProtocolRunManager;
    const outcome = await dispatchProtocolCommand({
      runs,
      stateReader: { getState },
      threadId: THREAD,
      command: { id: 1, method: "input.respond", params: { response: resume } },
      approvalAuditor: approvalAuditor({
        verdicts: app.approvalVerdicts,
        evidence: app.evidence,
      }),
    });
    return { outcome, getState };
  };

  it("records what the ledger proves when a reviewer approves", async () => {
    const args = {
      body: BODY,
      _grounding: [
        span("renews on March 4, 2027", evidenceId),
        span("includes two free swaps", evidenceId),
        span("waived the $12 fee", evidenceId),
      ],
    };

    const { outcome } = await respond(interruptValue(args), {
      interruptId: "approval-1",
      decisions: [{ decision: "approve" }],
    });
    expect(outcome.kind).toBe("success");

    const [verdict, ...rest] = app.approvalVerdicts.listByThread(THREAD);
    expect(rest).toEqual([]);
    expect(verdict).toMatchObject({
      threadId: THREAD,
      runId: "run_resume",
      interruptId: "approval-1",
      toolName: "mcp:mail:send",
      decision: "approve",
    });
    expect(verdict!.spans.map((s) => [s.text, s.tier])).toEqual([
      ["renews on March 4, 2027", "verifiable"],
      ["includes two free swaps", "verifiable"],
      // Quoted from the draft but absent from the source it names.
      ["waived the $12 fee", "unresolved"],
    ]);
  });

  it("keeps the evidence identity a span was audited against", async () => {
    await respond(
      interruptValue({ body: BODY, _grounding: [span("two free swaps", evidenceId)] }),
      { interruptId: "approval-1", decisions: [{ decision: "approve" }] },
    );

    expect(app.approvalVerdicts.listByThread(THREAD)[0]?.spans[0]).toEqual({
      arg: "body",
      text: "two free swaps",
      evidenceId,
      tier: "verifiable",
      breadcrumb: "mcp:mail:search (query: renewal)",
      bytes: LEDGER.length,
      truncated: false,
    });
  });

  it("reports a span asserted when its cited entry does not hold it", async () => {
    const args = {
      body: "The $12 fee is waived.",
      _grounding: [span("The $12 fee is waived", evidenceId)],
    };
    await respond(interruptValue(args), {
      interruptId: "approval-1",
      decisions: [{ decision: "approve" }],
    });

    expect(app.approvalVerdicts.listByThread(THREAD)[0]?.spans[0]).toMatchObject({
      tier: "asserted",
      gap: { reason: "tokens", tokens: ["$12", "waived"] },
    });
  });

  it("records an inconclusive verdict when the cited entry may contradict the draft", async () => {
    const denial = "Fee schedule: the $12 swap fee is not waived on this plan.";
    const denialId = app.evidence!.record({
      threadId: THREAD,
      runId: "run_paused",
      toolRef: "mcp:mail:search",
      breadcrumb: "mcp:mail:search (query: fee)",
      body: denial,
      bytes: denial.length,
      truncated: false,
    })!.id;

    await respond(
      interruptValue({
        body: "I've waived the $12 swap fee.",
        _grounding: [span("I've waived the $12 swap fee", denialId)],
      }),
      { interruptId: "approval-1", decisions: [{ decision: "approve" }] },
    );

    expect(app.approvalVerdicts.listByThread(THREAD)[0]?.spans[0]).toMatchObject({
      tier: "inconclusive",
      gap: { reason: "polarity" },
      breadcrumb: "mcp:mail:search (query: fee)",
    });
  });

  it("withholds a verdict rather than accusing a draft the clipped source cannot answer", async () => {
    const head = "Mailbox export, first page: renewal correspondence.";
    const clippedId = app.evidence!.record({
      threadId: THREAD,
      runId: "run_paused",
      toolRef: "mcp:mail:search",
      breadcrumb: "mcp:mail:search (query: renewal)",
      body: head,
      bytes: 512_000,
      truncated: true,
    })!.id;

    await respond(
      interruptValue({
        body: "The renewal amount is $1,200.00.",
        _grounding: [span("renewal amount is $1,200.00", clippedId)],
      }),
      { interruptId: "approval-1", decisions: [{ decision: "approve" }] },
    );

    expect(app.approvalVerdicts.listByThread(THREAD)[0]?.spans[0]).toMatchObject({
      tier: "inconclusive",
      gap: { reason: "clipped" },
      truncated: true,
    });
  });

  it("will not read another thread's evidence as a source", async () => {
    const foreign = app.evidence!.record({
      threadId: "t2",
      runId: "run_other",
      toolRef: "mcp:mail:search",
      breadcrumb: "other thread",
      body: LEDGER,
      bytes: LEDGER.length,
      truncated: false,
    })!.id;

    await respond(
      interruptValue({ body: BODY, _grounding: [span("two free swaps", foreign)] }),
      { interruptId: "approval-1", decisions: [{ decision: "approve" }] },
    );

    expect(app.approvalVerdicts.listByThread(THREAD)[0]?.spans[0]).toMatchObject({
      tier: "asserted",
      gap: { reason: "no-entry" },
    });
  });

  it("re-audits an edit against the text that ships, not the draft it replaced", async () => {
    const drafted = {
      body: BODY,
      _grounding: [
        span("renews on March 4, 2027", evidenceId),
        span("includes two free swaps", evidenceId),
      ],
    };
    const edited = {
      ...drafted,
      body: "Your contract renews on March 4, 2027. Swap terms are attached.",
    };

    await respond(interruptValue(drafted), {
      interruptId: "approval-1",
      decisions: [{ decision: "edit", editedArgs: edited, editedName: "mcp:mail:send" }],
    });

    const verdict = app.approvalVerdicts.listByThread(THREAD)[0];
    expect(verdict?.decision).toBe("edit");
    expect(verdict?.spans.map((s) => [s.text, s.tier])).toEqual([
      ["renews on March 4, 2027", "verifiable"],
      // The reviewer edited the clause away, so the citation addresses nothing.
      ["includes two free swaps", "unresolved"],
    ]);
  });

  it("keeps the dispatched arguments, minus the citations that are not content", async () => {
    await respond(
      interruptValue({
        to: "someone@example.test",
        body: BODY,
        _grounding: [span("two free swaps", evidenceId)],
      }),
      { interruptId: "approval-1", decisions: [{ decision: "approve" }] },
    );

    expect(app.approvalVerdicts.listByThread(THREAD)[0]?.args).toEqual({
      to: "someone@example.test",
      body: BODY,
    });
  });

  it("keeps the edited text, not the draft the reviewer replaced", async () => {
    const drafted = { body: BODY, _grounding: [span("renews on March 4, 2027", evidenceId)] };
    const shipped = "Your contract renews on March 4, 2027. Swap terms are attached.";

    await respond(interruptValue(drafted), {
      interruptId: "approval-1",
      decisions: [
        { decision: "edit", editedArgs: { ...drafted, body: shipped }, editedName: "mcp:mail:send" },
      ],
    });

    expect(app.approvalVerdicts.listByThread(THREAD)[0]?.args).toEqual({ body: shipped });
  });

  it("records nothing on a reject, and does not even read the paused state", async () => {
    const { getState } = await respond(
      interruptValue({ body: BODY, _grounding: [span("two free swaps", evidenceId)] }),
      { interruptId: "approval-1", decisions: [{ decision: "reject", message: "no" }] },
    );

    expect(getState).not.toHaveBeenCalled();
    expect(app.approvalVerdicts.listByThread(THREAD)).toEqual([]);
  });

  it("records one row per approved call in a batch", async () => {
    const args = { body: BODY, _grounding: [span("two free swaps", evidenceId)] };
    await respond(
      interruptValue(args, [{ name: "mcp:mail:send", args: { body: "No citations here." } }]),
      {
        interruptId: "approval-1",
        decisions: [{ decision: "approve" }, { decision: "approve" }],
      },
    );

    const verdicts = app.approvalVerdicts.listByThread(THREAD);
    expect(verdicts.map((v) => v.verdictId)).toEqual(["approval-1#0", "approval-1#1"]);
    expect(verdicts[1]?.spans).toEqual([]);
  });

  it("leaves no record when the resume names an interrupt the thread is not holding", async () => {
    await respond(
      interruptValue({ body: BODY, _grounding: [span("two free swaps", evidenceId)] }),
      { interruptId: "approval-stale", decisions: [{ decision: "approve" }] },
    );

    expect(app.approvalVerdicts.listByThread(THREAD)).toEqual([]);
  });
});
