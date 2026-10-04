import { describe, expect, it } from "vitest";
import { numberEvidenceLines } from "./evidence-lines.js";
import {
  MAX_CITED_LINES,
  auditGroundingSpans,
  groundingSpans,
  judgeKey,
  pendingJudgements,
  segmentAuditedText,
  type JudgeOutcome,
  type JudgeResults,
} from "./grounding.js";

/** Bodies as the ledger stores them: the numbered lines the model read. */
const bodies = (entries: Record<string, string>) =>
  new Map(Object.entries(entries).map(([id, text]) => [id, { text: numberEvidenceLines(text) }]));

const span = (text: string, lines: number[] = [1], evidenceId = "ev_1", arg = "body") => ({
  arg,
  text,
  evidenceId,
  lines,
});

const judged = (outcomes: Array<[ReturnType<typeof span>, JudgeOutcome]>): JudgeResults => ({
  judge: "test:judge",
  outcomes: new Map(outcomes.map(([s, outcome]) => [judgeKey(s), outcome])),
});

/** [1] plan  [2] renewal_date  [3] annual_amount  [4] swap_fee  [5] outage alert */
const ACCOUNT = JSON.stringify({
  plan: "Standard",
  renewal_date: "2027-03-04",
  annual_amount: "1200.00",
  swap_fee: { amount: "12.00", waived: false },
  alert: "processor returned 503 for 37 minutes",
});
const sources = () => bodies({ ev_1: ACCOUNT });

describe("groundingSpans", () => {
  it("normalizes cited lines, and keeps a span whose lines are unusable so the failure shows", () => {
    expect(
      groundingSpans({
        body: "x",
        _grounding: [
          { arg: "body", text: "a", evidenceId: "ev_1", lines: [3, 1, 3] },
          { arg: "body", text: "b", evidenceId: "ev_1", lines: ["2"] },
          { arg: "body", text: "c", evidenceId: "ev_1" },
          { arg: "body", text: "", evidenceId: "ev_1", lines: [1] },
        ],
      }),
    ).toEqual([span("a", [1, 3]), span("b", []), span("c", [])]);
  });
});

describe("auditGroundingSpans without a judge", () => {
  it("leaves every claim it cannot fault unsettled, in declaration order", () => {
    const renews = span("Renews on March 4, 2027", [2]);
    const fee = span("Your fee is $12.00", [4]);
    const args = { body: "Renews on March 4, 2027. Your fee is $12.00.", _grounding: [renews, fee] };
    expect(auditGroundingSpans(args, sources())).toEqual([
      { ...renews, tier: "inconclusive", gap: { reason: "unjudged" } },
      { ...fee, tier: "inconclusive", gap: { reason: "unjudged" } },
    ]);
  });

  it("asserts a figure the cited lines do not state, even when another line does", () => {
    const amount = span("Your annual amount is $1,200.00", [1, 2]);
    const [audited] = auditGroundingSpans({ body: `${amount.text}.`, _grounding: [amount] }, sources());
    expect(audited).toMatchObject({ tier: "asserted", gap: { reason: "figures", tokens: ["$1,200.00"] } });
  });

  it("reads grouping, currency and trailing zeros as formatting, not as a different figure", () => {
    const amount = span("Your annual amount is $1,200", [3]);
    expect(pendingJudgements({ body: `${amount.text}.`, _grounding: [amount] }, sources())).toEqual([
      {
        key: judgeKey(amount),
        claim: amount.text,
        evidenceId: "ev_1",
        lines: [{ line: 3, text: 'annual_amount: "1200.00"' }],
      },
    ]);
  });

  it("asserts a citation naming lines the entry does not have, or none at all", () => {
    const beyond = span("Renews in 2027", [2, 99]);
    const none = span("Standard plan", []);
    const audited = auditGroundingSpans(
      { body: "Renews in 2027. Standard plan.", _grounding: [beyond, none] },
      sources(),
    );
    expect(audited.map((s) => s.gap)).toEqual([{ reason: "bad-lines" }, { reason: "bad-lines" }]);
    expect(audited.every((s) => s.tier === "asserted")).toBe(true);
  });

  it("will not grade a citation that points at most of a document", () => {
    const count = MAX_CITED_LINES + 1;
    const lines = Array.from({ length: count }, (_, i) => `Line ${i + 1}.`).join("\n");
    const broad = span("Everything is fine", Array.from({ length: count }, (_, i) => i + 1));
    const [audited] = auditGroundingSpans(
      { body: "Everything is fine.", _grounding: [broad] },
      bodies({ ev_1: lines }),
    );
    expect(audited).toMatchObject({ tier: "inconclusive", gap: { reason: "broad-citation" } });
  });

  it("asserts a span whose cited entry is gone", () => {
    const missing = span("Renews on March 4", [1], "ev_missing");
    const [audited] = auditGroundingSpans({ body: "Renews on March 4.", _grounding: [missing] }, bodies({}));
    expect(audited).toMatchObject({ tier: "asserted", gap: { reason: "no-entry" } });
  });

  it("leaves a quote it cannot place unresolved rather than guessing a position", () => {
    const [audited] = auditGroundingSpans(
      { body: "Rewritten by the reviewer.", _grounding: [span("Renews on March 4, 2027", [2])] },
      sources(),
    );
    expect(audited).toEqual({ ...span("Renews on March 4, 2027", [2]), tier: "unresolved" });
  });

  it("leaves an ambiguous quote unresolved, and a quote of a non-string argument too", () => {
    const audited = auditGroundingSpans(
      {
        body: "two swaps. two swaps.",
        recipients: ["a@example.test"],
        _grounding: [span("two swaps"), span("a@example.test", [1], "ev_1", "recipients")],
      },
      sources(),
    );
    expect(audited.map((s) => s.tier)).toEqual(["unresolved", "unresolved"]);
  });

  it("finds nothing to audit when the arguments carry no citations", () => {
    expect(auditGroundingSpans({ body: "hi" }, sources())).toEqual([]);
    expect(auditGroundingSpans(undefined, sources())).toEqual([]);
  });
});

describe("auditGroundingSpans with a judge", () => {
  const renews = span("Your plan renews on March 4, 2027", [1, 2]);
  const args = { body: `${renews.text}.`, _grounding: [renews] };

  it("grants green only through cited lines the judge names, and keeps them for the reviewer", () => {
    const [audited] = auditGroundingSpans(args, sources(), judged([[renews, { verdict: "supported", lines: [2] }]]));
    expect(audited).toMatchObject({
      tier: "verifiable",
      judge: "test:judge",
      lines: [1, 2],
      support: [{ line: 2, text: 'renewal_date: "2027-03-04"' }],
    });
  });

  it("refuses support from a line the span did not cite", () => {
    const [audited] = auditGroundingSpans(args, sources(), judged([[renews, { verdict: "supported", lines: [3] }]]));
    expect(audited).toMatchObject({ tier: "inconclusive", gap: { reason: "unverified-support" } });
  });

  it("refuses support that names no line", () => {
    const [audited] = auditGroundingSpans(args, sources(), judged([[renews, { verdict: "supported", lines: [] }]]));
    expect(audited?.gap).toEqual({ reason: "unverified-support" });
  });

  it("refuses support from lines that do not state the claim's numbers", () => {
    const [audited] = auditGroundingSpans(args, sources(), judged([[renews, { verdict: "supported", lines: [1] }]]));
    expect(audited?.gap).toEqual({ reason: "unverified-support" });
  });

  it("refuses support whose line states a different small number than the claim", () => {
    const outage = span("The processor was down for 73 minutes", [5]);
    const [audited] = auditGroundingSpans(
      { body: `${outage.text}.`, _grounding: [outage] },
      sources(),
      judged([[outage, { verdict: "supported", lines: [5] }]]),
    );
    expect(audited?.gap).toEqual({ reason: "unverified-support" });
  });

  it("reads a day of the month inside an ISO date as the same number", () => {
    const arrives = span("It arrives on October 2", [1]);
    const [audited] = auditGroundingSpans(
      { body: `${arrives.text}.`, _grounding: [arrives] },
      bodies({ ev_1: '{"eta": "2026-10-02"}' }),
      judged([[arrives, { verdict: "supported", lines: [1] }]]),
    );
    expect(audited?.tier).toBe("verifiable");
  });

  it("asserts what the judge finds unsupported, the contradicted fee included", () => {
    const fee = span("Your $12.00 swap fee has been waived", [4]);
    const [audited] = auditGroundingSpans(
      { body: `${fee.text}.`, _grounding: [fee] },
      sources(),
      judged([[fee, { verdict: "unsupported", lines: [] }]]),
    );
    expect(audited).toMatchObject({ tier: "asserted", gap: { reason: "refuted" }, judge: "test:judge" });
  });

  it("reads an abstention and a failed or missing answer as unsettled", () => {
    const unclear = auditGroundingSpans(args, sources(), judged([[renews, { verdict: "unclear", lines: [] }]]));
    const failed = auditGroundingSpans(args, sources(), judged([[renews, { failed: true }]]));
    const missing = auditGroundingSpans(args, sources(), judged([]));
    expect(unclear[0]?.gap).toEqual({ reason: "unclear" });
    expect(failed[0]?.gap).toEqual({ reason: "judge-error" });
    expect(missing[0]?.gap).toEqual({ reason: "judge-error" });
  });

  it("keeps a deterministic accusation even when the judge would have agreed with the draft", () => {
    const wrong = span("Your annual amount is $1,020.00", [3]);
    const [audited] = auditGroundingSpans(
      { body: `${wrong.text}.`, _grounding: [wrong] },
      sources(),
      judged([[wrong, { verdict: "supported", lines: [3] }]]),
    );
    expect(audited).toMatchObject({ tier: "asserted", gap: { reason: "figures" } });
    expect(audited?.judge).toBeUndefined();
  });
});

describe("hostile input", () => {
  it("stays linear on long runs of punctuation in the span and the body", () => {
    const hostile = "$".repeat(200_000) + "a " + "/".repeat(200_000) + "1";
    const started = performance.now();
    const s = span(hostile, [1]);
    const args = { body: hostile, _grounding: [s] };
    pendingJudgements(args, bodies({ ev_1: hostile }));
    auditGroundingSpans(args, bodies({ ev_1: hostile }), judged([[s, { verdict: "supported", lines: [1] }]]));
    segmentAuditedText(hostile, []);
    expect(performance.now() - started).toBeLessThan(2_000);
  });
});

describe("pendingJudgements", () => {
  it("sends the judge only claims the deterministic checks left open, once each", () => {
    const open = span("Renews 2027", [2], "ev_1", "subject");
    const args = {
      body: "Renews 2027. Fee $99.00. Renews 2027. Gone.",
      subject: "Renews 2027",
      _grounding: [span("Fee $99.00", [4]), span("Gone", [1], "ev_missing"), open, span("not in the text")],
    };
    const pending = pendingJudgements(args, sources());
    expect(pending.map((p) => [p.claim, p.lines.map((l) => l.line)])).toEqual([["Renews 2027", [2]]]);
    expect(pending[0]?.key).toBe(judgeKey(open));
  });
});

describe("segmentAuditedText", () => {
  it("draws the stored tiers over the text, keeps the cited lines, and marks uncovered figures", () => {
    const text = "Renews 2027. A $45.00 fee applies.";
    const segments = segmentAuditedText(text, [{ ...span("Renews 2027", [2]), tier: "verifiable" }]);
    expect(segments.map((s) => s.text).join("")).toBe(text);
    expect(segments[0]).toMatchObject({ text: "Renews 2027", tier: "verifiable", evidenceId: "ev_1", lines: [2] });
    expect(segments.find((s) => s.unbacked)?.text).toBe("$45.00");
  });
});
