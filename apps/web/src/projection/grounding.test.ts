import { describe, expect, it } from "vitest";
import {
  citedEvidenceIds,
  countGroundedSegments,
  groundingSpans,
  segmentAuditedText,
  segmentGroundedText,
  withoutGroundingArgument,
  type GroundingSegment,
} from "./grounding.js";

const bodies = (entries: Record<string, string>) =>
  new Map(Object.entries(entries).map(([id, text]) => [id, { text }]));

const span = (text: string, evidenceId = "ev_1", arg = "body") => ({ arg, text, evidenceId });

const tierOf = (segments: GroundingSegment[], text: string) =>
  segments.find((segment) => segment.text === text)?.tier;

describe("groundingSpans", () => {
  it("reads the citation argument off tool arguments", () => {
    expect(groundingSpans({ body: "hi", _grounding: [span("hi")] })).toEqual([span("hi")]);
  });

  it("drops malformed spans rather than trusting model-written shapes", () => {
    const spans = groundingSpans({
      _grounding: [
        span("kept"),
        { arg: "body", text: "", evidenceId: "ev_1" },
        { arg: "body", text: "no id" },
        { arg: 7, text: "bad arg", evidenceId: "ev_1" },
        "nonsense",
      ],
    });
    expect(spans).toEqual([span("kept")]);
  });

  it("treats a missing or non-array argument as no citations", () => {
    expect(groundingSpans({ body: "hi" })).toEqual([]);
    expect(groundingSpans({ _grounding: "ev_1" })).toEqual([]);
    expect(groundingSpans(null)).toEqual([]);
  });

  it("collects each cited id once", () => {
    const args = { _grounding: [span("a", "ev_1"), span("b", "ev_2"), span("c", "ev_1")] };
    expect(citedEvidenceIds(args)).toEqual(["ev_1", "ev_2"]);
  });
});

describe("withoutGroundingArgument", () => {
  it("removes only the citation key", () => {
    expect(withoutGroundingArgument({ to: "a@b.c", body: "hi", _grounding: [] })).toEqual({
      to: "a@b.c",
      body: "hi",
    });
  });

  it("passes through values that carry no citations", () => {
    const args = { body: "hi" };
    expect(withoutGroundingArgument(args)).toBe(args);
    expect(withoutGroundingArgument("plain")).toBe("plain");
  });
});

describe("segmentGroundedText", () => {
  it("reproduces the text exactly when segments are concatenated", () => {
    const text = "Hello.\n\nThe renewal date is March 4th. Let me know.";
    const segments = segmentGroundedText(
      text,
      [span("The renewal date is March 4th.")],
      bodies({ ev_1: "Contract renews March 4, 2027." }),
    );
    expect(segments.map((segment) => segment.text).join("")).toBe(text);
  });

  it("marks a span verifiable when the cited body holds its numbers and content words", () => {
    const segments = segmentGroundedText(
      "Your renewal is March 4th.",
      [span("renewal is March 4th")],
      bodies({ ev_1: "The subscription renewal falls on March 4, 2027." }),
    );
    expect(tierOf(segments, "renewal is March 4th")).toBe("verifiable");
    expect(tierOf(segments, "Your ")).toBe("uncited");
  });

  it("names the tokens a body does not contain", () => {
    const segments = segmentGroundedText(
      "We waived the $12 fee.",
      [span("waived the $12 fee")],
      bodies({ ev_1: "A $12 charge applies to the account." }),
    );
    const cited = segments.find((segment) => segment.tier === "asserted");
    expect(cited?.gap).toEqual({ reason: "tokens", tokens: ["waived"] });
  });

  it("tolerates the draft's own connective wording inside a cited span", () => {
    const quote = "renews on March 4, 2027 at a rate of $1,200.00";
    const segments = segmentGroundedText(
      `Your Pro plan ${quote}.`,
      [span(quote)],
      bodies({ ev_1: "Renewal: renews March 4, 2027 at $1,200.00" }),
    );
    expect(tierOf(segments, quote)).toBe("verifiable");
  });

  it("refuses to call a span verifiable when the cited source denies it", () => {
    const quote = "I've waived the $12 fee.";
    const segments = segmentGroundedText(
      quote,
      [span(quote)],
      bodies({ ev_1: "The $12 fee is not waived." }),
    );
    expect(segments[0]).toMatchObject({ tier: "inconclusive", gap: { reason: "polarity" } });
  });

  it("verifies a span that carries the same negation as its source", () => {
    const quote = "The $12 fee is not waived.";
    const segments = segmentGroundedText(
      quote,
      [span(quote)],
      bodies({ ev_1: "Account note: the $12 fee is not waived." }),
    );
    expect(tierOf(segments, quote)).toBe("verifiable");
  });

  it("reads the draft's inflection of a word its source spells differently", () => {
    const quote = "renews on April 9, 2028";
    const segments = segmentGroundedText(
      `Your plan ${quote}.`,
      [span(quote)],
      bodies({ ev_1: "Plan renewal date: April 9, 2028." }),
    );
    expect(tierOf(segments, quote)).toBe("verifiable");
  });

  it("refuses a span whose tokens turn up only far apart in a long source", () => {
    const quote = "renews on April 9, 2028 at $2,400.00";
    const body = `Renewal date: April 9, 2028.${" Ledger entry. ".repeat(400)}Annual amount 2400.00 USD.`;
    const segments = segmentGroundedText(
      `Your plan ${quote}.`,
      [span(quote)],
      bodies({ ev_1: body }),
    );
    expect(segments.find((segment) => segment.evidenceId === "ev_1")).toMatchObject({
      tier: "inconclusive",
      gap: { reason: "scattered" },
    });
  });

  it("asserts a span that borrows a number but not the claim around it", () => {
    const segments = segmentGroundedText(
      "We waived the $12 charge as a courtesy credit.",
      [span("waived the $12 charge as a courtesy credit")],
      bodies({ ev_1: "A $12 charge applies to the account." }),
    );
    const cited = segments.find((segment) => segment.evidenceId === "ev_1");
    expect(cited?.tier).toBe("asserted");
    expect(cited?.gap).toEqual({
      reason: "tokens",
      tokens: ["waived", "courtesy", "credit"],
    });
  });

  it("treats a name the body never mentions as a mismatch, not paraphrase", () => {
    const segments = segmentGroundedText(
      "The renewal for Wexler Roasters is confirmed.",
      [span("renewal for Wexler Roasters is confirmed")],
      bodies({ ev_1: "Renewal confirmed for the Ardmore account." }),
    );
    const cited = segments.find((segment) => segment.evidenceId === "ev_1");
    expect(cited?.tier).toBe("asserted");
    expect(cited?.gap).toEqual({ reason: "tokens", tokens: ["Wexler", "Roasters"] });
  });

  it("does not let a shorter number match inside a longer one", () => {
    const segments = segmentGroundedText(
      "a 12 dollar credit",
      [span("12")],
      bodies({ ev_1: "credit of 120 dollars" }),
    );
    expect(tierOf(segments, "12")).toBe("asserted");
  });

  it("reads 1,200.00 and 1200.00 as the same number", () => {
    const segments = segmentGroundedText(
      "refund of $1,200.00",
      [span("$1,200.00")],
      bodies({ ev_1: "refund amount 1200.00 USD" }),
    );
    expect(tierOf(segments, "$1,200.00")).toBe("verifiable");
  });

  it("asserts a span whose cited entry is gone", () => {
    const segments = segmentGroundedText("a claim", [span("a claim", "ev_missing")], bodies({}));
    expect(segments[0]?.gap).toEqual({ reason: "no-entry" });
    expect(segments[0]?.tier).toBe("asserted");
  });

  it("proves nothing from a span with no checkable tokens", () => {
    const segments = segmentGroundedText(
      "they will",
      [span("they will")],
      bodies({ ev_1: "they will" }),
    );
    expect(segments[0]).toMatchObject({ tier: "asserted", gap: { reason: "tokens", tokens: [] } });
  });

  it("leaves an ambiguous quote uncited rather than guessing an occurrence", () => {
    const segments = segmentGroundedText(
      "swap one, swap two",
      [span("swap")],
      bodies({ ev_1: "two swaps included" }),
    );
    expect(segments).toEqual([{ text: "swap one, swap two", tier: "uncited" }]);
  });

  it("leaves a quote the argument does not contain uncited", () => {
    const segments = segmentGroundedText(
      "the renewal is in March",
      [span("the renewal is in April")],
      bodies({ ev_1: "renews in April" }),
    );
    expect(segments).toEqual([{ text: "the renewal is in March", tier: "uncited" }]);
  });

  it("keeps the first of two overlapping spans", () => {
    const segments = segmentGroundedText(
      "two free swaps and a waived fee",
      [span("two free swaps and", "ev_1"), span("swaps and a waived", "ev_2")],
      bodies({ ev_1: "two free swaps and more", ev_2: "swaps and a waived fee" }),
    );
    expect(segments.map((segment) => segment.evidenceId)).toEqual(["ev_1", undefined]);
  });

  it("counts what checked out for a reviewer's summary", () => {
    const segments = segmentGroundedText(
      "March 4th and a $12 fee",
      [span("March 4th", "ev_1"), span("$12 fee", "ev_2")],
      bodies({ ev_1: "renews March 4", ev_2: "no charge recorded" }),
    );
    expect(countGroundedSegments(segments)).toEqual({
      verifiable: 1,
      inconclusive: 0,
      asserted: 1,
    });
  });

  it("returns nothing for empty text", () => {
    expect(segmentGroundedText("", [span("x")], bodies({}))).toEqual([]);
  });

  it("marks a figure no citation covers, since the audit grades only what was cited", () => {
    const text = "Your renewal is March 4th. That works out to $100.00 monthly.";
    const segments = segmentGroundedText(
      text,
      [span("renewal is March 4th")],
      bodies({ ev_1: "The subscription renewal falls on March 4, 2027." }),
    );
    expect(segments.filter((segment) => segment.unbacked).map((segment) => segment.text)).toEqual([
      "$100.00",
    ]);
    expect(segments.map((segment) => segment.text).join("")).toBe(text);
  });

  it("leaves uncited wording alone: only a figure claims something a source could hold", () => {
    const segments = segmentGroundedText("Thanks for writing in.", [], bodies({}));
    expect(segments).toEqual([{ text: "Thanks for writing in.", tier: "uncited" }]);
  });

  it("passes over a bare count, where marking every digit would spend attention for nothing", () => {
    const text = "We will follow up within 2 business days about the $45.00 charge on 4 March 2027.";
    const segments = segmentGroundedText(text, [], bodies({}));

    expect(segments.filter((segment) => segment.unbacked).map((segment) => segment.text)).toEqual([
      "$45.00",
      "2027",
    ]);
    expect(segments.map((segment) => segment.text).join("")).toBe(text);
  });
});

describe("segmentAuditedText", () => {
  it("replays the stored tier rather than grading the text again", () => {
    const segments = segmentAuditedText("We waived the $12 fee.", [
      {
        arg: "body",
        text: "waived the $12 fee",
        evidenceId: "ev_1",
        tier: "asserted",
        gap: { reason: "tokens", tokens: ["waived"] },
      },
    ]);
    expect(segments).toEqual([
      { text: "We ", tier: "uncited" },
      {
        text: "waived the $12 fee",
        tier: "asserted",
        evidenceId: "ev_1",
        gap: { reason: "tokens", tokens: ["waived"] },
      },
      { text: ".", tier: "uncited" },
    ]);
  });

  it("places no mark for a quote that does not address the text that was sent", () => {
    const segments = segmentAuditedText("Rewritten by the reviewer.", [
      { arg: "body", text: "Renews on March 4, 2027", evidenceId: "ev_1", tier: "unresolved" },
    ]);
    expect(segments).toEqual([{ text: "Rewritten by the reviewer.", tier: "uncited" }]);
  });
});
