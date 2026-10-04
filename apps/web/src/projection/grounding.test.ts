import { describe, expect, it } from "vitest";
import type { AuditedSpan } from "@pizza-bot/core";
import {
  citedEvidenceIds,
  countGroundedSegments,
  groundingSpans,
  segmentAuditedText,
  withoutGroundingArgument,
} from "./grounding.js";

const span = (text: string, evidenceId = "ev_1", arg = "body") => ({ arg, text, evidenceId });

const audited = (text: string, tier: AuditedSpan["tier"], evidenceId = "ev_1"): AuditedSpan => ({
  ...span(text, evidenceId),
  tier,
});

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

describe("segmentAuditedText", () => {
  it("replays the stored tier and its verified support rather than grading the text again", () => {
    const segments = segmentAuditedText("We renew in 2027.", [
      { ...audited("renew in 2027", "verifiable"), judge: "test:judge", support: ["renewal: 2027"] },
    ]);
    expect(segments).toEqual([
      { text: "We ", tier: "uncited" },
      { text: "renew in 2027", tier: "verifiable", evidenceId: "ev_1", support: ["renewal: 2027"] },
      { text: ".", tier: "uncited" },
    ]);
  });

  it("reproduces the text exactly when segments are concatenated", () => {
    const text = "Hello.\n\nThe renewal date is March 4th. Let me know.";
    const segments = segmentAuditedText(text, [audited("The renewal date is March 4th.", "inconclusive")]);
    expect(segments.map((segment) => segment.text).join("")).toBe(text);
  });

  it("places no mark for a quote that does not address the text that was sent", () => {
    const segments = segmentAuditedText("Rewritten by the reviewer.", [
      audited("Renews on March 4, 2027", "unresolved"),
    ]);
    expect(segments).toEqual([{ text: "Rewritten by the reviewer.", tier: "uncited" }]);
  });

  it("keeps the first of two overlapping spans", () => {
    const segments = segmentAuditedText("two free swaps and a waived fee", [
      audited("two free swaps and", "verifiable", "ev_1"),
      audited("swaps and a waived", "asserted", "ev_2"),
    ]);
    expect(segments.map((segment) => segment.evidenceId)).toEqual(["ev_1", undefined]);
  });

  it("counts what checked out for a reviewer's summary", () => {
    const segments = segmentAuditedText("March 4th and a $12 fee", [
      audited("March 4th", "verifiable", "ev_1"),
      audited("$12 fee", "asserted", "ev_2"),
    ]);
    expect(countGroundedSegments(segments)).toEqual({ verifiable: 1, inconclusive: 0, asserted: 1 });
  });

  it("returns nothing for empty text", () => {
    expect(segmentAuditedText("", [audited("x", "verifiable")])).toEqual([]);
  });

  it("marks a figure no citation covers, since the audit grades only what was cited", () => {
    const text = "Your renewal is March 4th. That works out to $100.00 monthly.";
    const segments = segmentAuditedText(text, [audited("renewal is March 4th", "verifiable")]);
    expect(segments.filter((segment) => segment.unbacked).map((segment) => segment.text)).toEqual(["$100.00"]);
    expect(segments.map((segment) => segment.text).join("")).toBe(text);
  });

  it("leaves uncited wording alone: only a figure claims something a source could hold", () => {
    expect(segmentAuditedText("Thanks for writing in.", [])).toEqual([
      { text: "Thanks for writing in.", tier: "uncited" },
    ]);
  });

  it("passes over a bare count, where marking every digit would spend attention for nothing", () => {
    const text = "We will follow up within 2 business days about the $45.00 charge on 4 March 2027.";
    const segments = segmentAuditedText(text, []);
    expect(segments.filter((segment) => segment.unbacked).map((segment) => segment.text)).toEqual([
      "$45.00",
      "2027",
    ]);
    expect(segments.map((segment) => segment.text).join("")).toBe(text);
  });
});
