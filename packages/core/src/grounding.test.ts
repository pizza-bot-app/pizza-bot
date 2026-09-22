import { describe, expect, it } from "vitest";
import { auditGroundingSpans, segmentGroundedText } from "./grounding.js";

const bodies = (entries: Record<string, string>) =>
  new Map(Object.entries(entries).map(([id, text]) => [id, { text }]));

/** A source the ledger kept only the head of, as the byte cap leaves it. */
const clippedBodies = (entries: Record<string, string>) =>
  new Map(Object.entries(entries).map(([id, text]) => [id, { text, truncated: true }]));

const span = (text: string, evidenceId = "ev_1", arg = "body") => ({ arg, text, evidenceId });

describe("auditGroundingSpans", () => {
  it("keeps one entry per declared span, in declaration order", () => {
    const args = {
      body: "Renews on March 4, 2027. Two free swaps are included.",
      _grounding: [span("Renews on March 4, 2027", "ev_1"), span("Two free swaps", "ev_2")],
    };
    const audited = auditGroundingSpans(
      args,
      bodies({
        ev_1: "The contract renews on March 4, 2027.",
        ev_2: "Plan entitlements: two free swaps per year.",
      }),
    );
    expect(audited.map((s) => [s.text, s.tier])).toEqual([
      ["Renews on March 4, 2027", "verifiable"],
      ["Two free swaps", "verifiable"],
    ]);
  });

  it("marks a span asserted when its cited body never stated the specific", () => {
    const audited = auditGroundingSpans(
      { body: "The waived fee was $12.00.", _grounding: [span("waived fee was $12.00")] },
      bodies({ ev_1: "The swap fee is $40.00 and is not waived." }),
    );
    expect(audited[0]?.tier).toBe("asserted");
    expect(audited[0]?.gap).toEqual({ reason: "tokens", tokens: ["$12.00"] });
  });

  it("records a span its cited body contradicts as inconclusive, never verifiable", () => {
    const audited = auditGroundingSpans(
      { body: "I've waived the $12 fee.", _grounding: [span("I've waived the $12 fee.")] },
      bodies({ ev_1: "The $12 fee is not waived." }),
    );
    expect(audited[0]).toMatchObject({ tier: "inconclusive", gap: { reason: "polarity" } });
  });

  it("does not let a distant word drag an unrelated negated clause into the passage", () => {
    const audited = auditGroundingSpans(
      { body: "Renewal date: March 4, 2027", _grounding: [span("Renewal date: March 4, 2027")] },
      bodies({
        // "dated", 90 characters away, is the only occurrence of the span's word "date".
        ev_1:
          "Renewal: 4 March 2027, billed $1,200.00 for the year. " +
          "Late-fee waiver request: NOT approved. The $45.00 fee dated 12 January 2027 remains due.",
      }),
    );
    expect(audited[0]?.tier).toBe("verifiable");
  });

  it("flags a draft that adds a negation its cited body does not carry", () => {
    const audited = auditGroundingSpans(
      {
        body: "The $12 swap fee will not be charged.",
        _grounding: [span("The $12 swap fee will not be charged")],
      },
      bodies({ ev_1: "The $12 swap fee is waived for this account." }),
    );
    expect(audited[0]).toMatchObject({ tier: "inconclusive", gap: { reason: "polarity" } });
  });

  it("still verifies the honest clauses of a record that denies something else", () => {
    const record =
      "Account A-4471, Standard plan. Swap fee schedule: the $12 swap fee is not waived " +
      "on this plan. Plan renewal date: April 9, 2028. Annual amount 2,400.00 USD.";
    const body =
      "Confirming that your plan renewal date is April 9, 2028 and your annual amount " +
      "is 2,400.00 USD.";
    const audited = auditGroundingSpans(
      {
        body,
        _grounding: [
          span("your plan renewal date is April 9, 2028"),
          span("your annual amount is 2,400.00 USD"),
        ],
      },
      bodies({ ev_1: record }),
    );
    expect(audited.map((s) => s.tier)).toEqual(["verifiable", "verifiable"]);
  });

  it("marks a span asserted when the cited entry is gone", () => {
    const audited = auditGroundingSpans(
      { body: "Renews on March 4.", _grounding: [span("Renews on March 4", "ev_missing")] },
      bodies({}),
    );
    expect(audited[0]).toMatchObject({
      tier: "asserted",
      evidenceId: "ev_missing",
      gap: { reason: "no-entry" },
    });
  });

  it("will not call a claim invented when the ledger kept only part of its source", () => {
    const audited = auditGroundingSpans(
      { body: "The waived fee was $12.00.", _grounding: [span("waived fee was $12.00")] },
      clippedBodies({ ev_1: "The swap fee is $40.00 and was waived." }),
    );
    expect(audited[0]).toMatchObject({ tier: "inconclusive", gap: { reason: "clipped" } });
  });

  it("still reports a contradiction a clipped source does state", () => {
    const audited = auditGroundingSpans(
      { body: "I've waived the $12 fee.", _grounding: [span("I've waived the $12 fee.")] },
      clippedBodies({ ev_1: "The $12 fee is not waived." }),
    );
    expect(audited[0]).toMatchObject({ tier: "inconclusive", gap: { reason: "polarity" } });
  });

  it("holds a span with nothing checkable to account even against a clipped source", () => {
    const audited = auditGroundingSpans(
      { body: "they will", _grounding: [span("they will")] },
      clippedBodies({ ev_1: "they will" }),
    );
    expect(audited[0]).toMatchObject({ tier: "asserted", gap: { reason: "tokens", tokens: [] } });
  });

  it("leaves a quote it cannot place unresolved rather than guessing a position", () => {
    const audited = auditGroundingSpans(
      { body: "Rewritten by the reviewer.", _grounding: [span("Renews on March 4, 2027")] },
      bodies({ ev_1: "Contract renewal date: March 4, 2027." }),
    );
    expect(audited).toEqual([
      { arg: "body", text: "Renews on March 4, 2027", evidenceId: "ev_1", tier: "unresolved" },
    ]);
  });

  it("leaves an ambiguous quote unresolved, since either position may be the claim", () => {
    const audited = auditGroundingSpans(
      { body: "two swaps. two swaps.", _grounding: [span("two swaps")] },
      bodies({ ev_1: "Plan includes two swaps." }),
    );
    expect(audited[0]?.tier).toBe("unresolved");
  });

  it("audits each argument against its own text", () => {
    const args = {
      subject: "Renewal on March 4",
      body: "Two free swaps are included.",
      _grounding: [
        span("Renewal on March 4", "ev_1", "subject"),
        span("Two free swaps", "ev_1", "body"),
      ],
    };
    const audited = auditGroundingSpans(args, bodies({ ev_1: "Renewal March 4: two free swaps." }));
    expect(audited.map((s) => [s.arg, s.tier])).toEqual([
      ["subject", "verifiable"],
      ["body", "verifiable"],
    ]);
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

  it("stays linear on a long run of trailing punctuation", () => {
    const hostile = "$".repeat(200_000) + "a " + "/".repeat(200_000) + "1";
    const started = performance.now();
    auditGroundingSpans({ body: hostile, _grounding: [span(hostile)] }, bodies({ ev_1: "x" }));
    segmentGroundedText(hostile, [], bodies({}));
    expect(performance.now() - started).toBeLessThan(2_000);
  });

});
