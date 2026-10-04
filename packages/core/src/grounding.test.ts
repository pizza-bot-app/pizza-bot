import { describe, expect, it } from "vitest";
import {
  auditGroundingSpans,
  judgeKey,
  pendingJudgements,
  segmentAuditedText,
  type JudgeOutcome,
  type JudgeResults,
} from "./grounding.js";

const bodies = (entries: Record<string, string>) =>
  new Map(Object.entries(entries).map(([id, text]) => [id, { text }]));

/** A source the ledger kept only the head of, as the byte cap leaves it. */
const clippedBodies = (entries: Record<string, string>) =>
  new Map(Object.entries(entries).map(([id, text]) => [id, { text, truncated: true }]));

const span = (text: string, evidenceId = "ev_1", arg = "body") => ({ arg, text, evidenceId });

const judged = (
  outcomes: Array<[text: string, outcome: JudgeOutcome, evidenceId?: string]>,
): JudgeResults => ({
  judge: "test:judge",
  outcomes: new Map(outcomes.map(([text, outcome, evidenceId = "ev_1"]) => [judgeKey({ text, evidenceId }), outcome])),
});

const ACCOUNT = JSON.stringify({
  plan: "Standard",
  renewal_date: "2027-03-04",
  annual_amount: "1200.00",
  swap_fee: { amount: "12.00", waived: false },
});

describe("auditGroundingSpans without a judge", () => {
  it("leaves every claim it cannot fault unsettled, in declaration order", () => {
    const args = {
      body: "Renews on March 4, 2027. Your fee is $12.00.",
      _grounding: [span("Renews on March 4, 2027"), span("Your fee is $12.00")],
    };
    expect(auditGroundingSpans(args, bodies({ ev_1: ACCOUNT }))).toEqual([
      { ...span("Renews on March 4, 2027"), tier: "inconclusive", gap: { reason: "unjudged" } },
      { ...span("Your fee is $12.00"), tier: "inconclusive", gap: { reason: "unjudged" } },
    ]);
  });

  it("never marks a contradicted claim green just because its words co-occur", () => {
    const args = {
      body: "Your $12.00 swap fee has been waived.",
      _grounding: [span("Your $12.00 swap fee has been waived.")],
    };
    expect(auditGroundingSpans(args, bodies({ ev_1: ACCOUNT }))[0]?.tier).toBe("inconclusive");
  });

  it("asserts a claim whose exact figure the cited body never states", () => {
    const audited = auditGroundingSpans(
      { body: "The waived fee was $12.50.", _grounding: [span("waived fee was $12.50")] },
      bodies({ ev_1: "The swap fee is $40.00 and is not waived." }),
    );
    expect(audited[0]).toMatchObject({ tier: "asserted", gap: { reason: "figures", tokens: ["$12.50"] } });
  });

  it("reads grouping, currency and trailing zeros as formatting, not as a different figure", () => {
    const pending = pendingJudgements(
      {
        body: "Your annual amount is $1,200. It renews in 2027.",
        _grounding: [span("Your annual amount is $1,200"), span("It renews in 2027")],
      },
      bodies({ ev_1: ACCOUNT }),
    );
    expect(pending.map((p) => p.claim)).toEqual(["Your annual amount is $1,200", "It renews in 2027"]);
  });

  it("does not let a shorter number match inside a longer one", () => {
    const audited = auditGroundingSpans(
      { body: "The fee is $120.", _grounding: [span("The fee is $120")] },
      bodies({ ev_1: "Fee: 1200" }),
    );
    expect(audited[0]?.gap).toEqual({ reason: "figures", tokens: ["$120"] });
  });

  it("asserts a span whose cited entry is gone", () => {
    const audited = auditGroundingSpans(
      { body: "Renews on March 4.", _grounding: [span("Renews on March 4", "ev_missing")] },
      bodies({}),
    );
    expect(audited[0]).toMatchObject({ tier: "asserted", gap: { reason: "no-entry" } });
  });

  it("will not call a figure invented when the ledger kept only part of its source", () => {
    const audited = auditGroundingSpans(
      { body: "The waived fee was $12.50.", _grounding: [span("waived fee was $12.50")] },
      clippedBodies({ ev_1: "The swap fee is $40.00 and was waived." }),
    );
    expect(audited[0]).toMatchObject({ tier: "inconclusive", gap: { reason: "clipped" } });
  });

  it("leaves a quote it cannot place unresolved rather than guessing a position", () => {
    const audited = auditGroundingSpans(
      { body: "Rewritten by the reviewer.", _grounding: [span("Renews on March 4, 2027")] },
      bodies({ ev_1: ACCOUNT }),
    );
    expect(audited).toEqual([{ ...span("Renews on March 4, 2027"), tier: "unresolved" }]);
  });

  it("leaves an ambiguous quote unresolved, since either position may be the claim", () => {
    const audited = auditGroundingSpans(
      { body: "two swaps. two swaps.", _grounding: [span("two swaps")] },
      bodies({ ev_1: "Plan includes two swaps." }),
    );
    expect(audited[0]?.tier).toBe("unresolved");
  });

  it("cannot resolve a quote of a non-string argument", () => {
    const audited = auditGroundingSpans(
      { recipients: ["a@example.test"], _grounding: [span("a@example.test", "ev_1", "recipients")] },
      bodies({ ev_1: "Contact: a@example.test" }),
    );
    expect(audited[0]?.tier).toBe("unresolved");
  });

  it("finds nothing to audit when the arguments carry no citations", () => {
    expect(auditGroundingSpans({ body: "hi" }, bodies({}))).toEqual([]);
    expect(auditGroundingSpans(undefined, bodies({}))).toEqual([]);
  });
});

describe("auditGroundingSpans with a judge", () => {
  const args = {
    body: "Your plan renews on March 4, 2027.",
    _grounding: [span("Your plan renews on March 4, 2027")],
  };
  const claim = "Your plan renews on March 4, 2027";

  it("grants green only for support it can find in the cited body, and keeps the passage", () => {
    const [audited] = auditGroundingSpans(
      args,
      bodies({ ev_1: ACCOUNT }),
      judged([[claim, { verdict: "supported", quotes: ['"renewal_date":"2027-03-04"'] }]]),
    );
    expect(audited).toMatchObject({
      tier: "verifiable",
      judge: "test:judge",
      support: ['"renewal_date":"2027-03-04"'],
    });
  });

  it("matches a quote regardless of case and spacing", () => {
    const [audited] = auditGroundingSpans(
      args,
      bodies({ ev_1: "Renewal  Date:\n2027-03-04" }),
      judged([[claim, { verdict: "supported", quotes: ["renewal date: 2027-03-04"] }]]),
    );
    expect(audited?.tier).toBe("verifiable");
  });

  it("refuses a supported verdict whose quote is not in the cited body", () => {
    const [audited] = auditGroundingSpans(
      args,
      bodies({ ev_1: ACCOUNT }),
      judged([[claim, { verdict: "supported", quotes: ["The plan renews on March 4, 2027."] }]]),
    );
    expect(audited).toMatchObject({ tier: "inconclusive", gap: { reason: "unverified-quote" } });
  });

  it("refuses support whose quotes do not hold the claim's figures", () => {
    const [audited] = auditGroundingSpans(
      args,
      bodies({ ev_1: ACCOUNT }),
      judged([[claim, { verdict: "supported", quotes: ['"plan":"Standard"'] }]]),
    );
    expect(audited?.gap).toEqual({ reason: "unverified-quote" });
  });

  it("refuses support whose quote states a different small number than the claim", () => {
    const outage = "The processor was down for 73 minutes";
    const [audited] = auditGroundingSpans(
      { body: `${outage}.`, _grounding: [span(outage)] },
      bodies({ ev_1: "ALERT: payment processor returned 503 for 37 minutes." }),
      judged([[outage, { verdict: "supported", quotes: ["payment processor returned 503 for 37 minutes"] }]]),
    );
    expect(audited?.gap).toEqual({ reason: "unverified-quote" });
  });

  it("reads a day of the month inside an ISO date as the same number", () => {
    const [audited] = auditGroundingSpans(
      { body: "It arrives on October 2.", _grounding: [span("It arrives on October 2")] },
      bodies({ ev_1: '{"eta": "2026-10-02"}' }),
      judged([["It arrives on October 2", { verdict: "supported", quotes: ['"eta": "2026-10-02"'] }]]),
    );
    expect(audited?.tier).toBe("verifiable");
  });

  it("refuses a supported verdict that offers no quote at all", () => {
    const [audited] = auditGroundingSpans(
      args,
      bodies({ ev_1: ACCOUNT }),
      judged([[claim, { verdict: "supported", quotes: [] }]]),
    );
    expect(audited?.gap).toEqual({ reason: "unverified-quote" });
  });

  it("asserts what the judge finds unsupported, the contradicted fee included", () => {
    const fee = "Your $12.00 swap fee has been waived.";
    const [audited] = auditGroundingSpans(
      { body: fee, _grounding: [span(fee)] },
      bodies({ ev_1: ACCOUNT }),
      judged([[fee, { verdict: "unsupported", quotes: [] }]]),
    );
    expect(audited).toMatchObject({ tier: "asserted", gap: { reason: "refuted" }, judge: "test:judge" });
  });

  it("will not accuse a claim the judge could not find in a clipped source", () => {
    const [audited] = auditGroundingSpans(
      args,
      clippedBodies({ ev_1: ACCOUNT }),
      judged([[claim, { verdict: "unsupported", quotes: [] }]]),
    );
    expect(audited?.gap).toEqual({ reason: "clipped" });
  });

  it("reads an abstention and a failed or missing answer as unsettled", () => {
    const sources = bodies({ ev_1: ACCOUNT });
    const unclear = auditGroundingSpans(args, sources, judged([[claim, { verdict: "unclear", quotes: [] }]]));
    const failed = auditGroundingSpans(args, sources, judged([[claim, { failed: true }]]));
    const missing = auditGroundingSpans(args, sources, judged([]));
    expect(unclear[0]?.gap).toEqual({ reason: "unclear" });
    expect(failed[0]?.gap).toEqual({ reason: "judge-error" });
    expect(missing[0]?.gap).toEqual({ reason: "judge-error" });
  });

  it("keeps a deterministic accusation even when the judge would have agreed with the draft", () => {
    const wrong = "Your annual amount is $1,020.00";
    const [audited] = auditGroundingSpans(
      { body: `${wrong}.`, _grounding: [span(wrong)] },
      bodies({ ev_1: ACCOUNT }),
      judged([[wrong, { verdict: "supported", quotes: ['"annual_amount":"1200.00"'] }]]),
    );
    expect(audited).toMatchObject({ tier: "asserted", gap: { reason: "figures" } });
    expect(audited?.judge).toBeUndefined();
  });
});

describe("hostile input", () => {
  it("stays linear on long runs of punctuation in the span, the body and a judge's quote", () => {
    const hostile = "$".repeat(200_000) + "a " + "/".repeat(200_000) + "1";
    const started = performance.now();
    const args = { body: hostile, _grounding: [span(hostile)] };
    pendingJudgements(args, bodies({ ev_1: hostile }));
    auditGroundingSpans(args, bodies({ ev_1: hostile }), judged([[hostile, { verdict: "supported", quotes: [hostile] }]]));
    segmentAuditedText(hostile, []);
    expect(performance.now() - started).toBeLessThan(2_000);
  });
});

describe("pendingJudgements", () => {
  it("sends the judge only claims the deterministic checks left open, once each", () => {
    const args = {
      body: "Renews 2027. Fee $99.00. Renews 2027. Gone.",
      subject: "Renews 2027",
      _grounding: [
        span("Fee $99.00"),
        span("Gone", "ev_missing"),
        span("Renews 2027", "ev_1", "subject"),
        span("not in the text"),
      ],
    };
    const pending = pendingJudgements(args, bodies({ ev_1: ACCOUNT }));
    expect(pending.map((p) => [p.claim, p.evidenceId])).toEqual([["Renews 2027", "ev_1"]]);
    expect(pending[0]?.key).toBe(judgeKey(span("Renews 2027")));
  });
});

describe("segmentAuditedText", () => {
  it("draws the stored tiers over the text and marks figures no citation covers", () => {
    const text = "Renews 2027. A $45.00 fee applies.";
    const segments = segmentAuditedText(text, [
      { ...span("Renews 2027"), tier: "verifiable" },
    ]);
    expect(segments.map((s) => s.text).join("")).toBe(text);
    expect(segments[0]).toMatchObject({ text: "Renews 2027", tier: "verifiable", evidenceId: "ev_1" });
    expect(segments.find((s) => s.unbacked)?.text).toBe("$45.00");
  });
});
