import { describe, it, expect } from "vitest";
import {
  clipEvidenceBody,
  evidenceExcerpt,
  MAX_EVIDENCE_BODY_BYTES,
  MAX_EVIDENCE_EXCERPT_CHARS,
} from "./evidence.js";

describe("clipEvidenceBody", () => {
  it("passes a body under the cap through untouched", () => {
    const clip = clipEvidenceBody("a quoted sentence");
    expect(clip).toEqual({ body: "a quoted sentence", bytes: 17, truncated: false });
  });

  it("reports the pre-clip byte count so a reviewer sees the source was partial", () => {
    const clip = clipEvidenceBody("abcdefghij", 4);
    expect(clip.body).toBe("abcd");
    expect(clip.bytes).toBe(10);
    expect(clip.truncated).toBe(true);
  });

  it("counts bytes, not characters", () => {
    // Four bytes of UTF-8, one code point: it fits a 4-byte cap whole or not at all.
    expect(clipEvidenceBody("😀", 4)).toEqual({ body: "😀", bytes: 4, truncated: false });
    expect(clipEvidenceBody("😀", 3)).toEqual({ body: "", bytes: 4, truncated: true });
  });

  it("never splits a code point, since half of one is a quote that cannot resolve", () => {
    const clip = clipEvidenceBody("aé😀", 4);
    expect(clip.body).toBe("aé");
    expect(clip.truncated).toBe(true);
    expect([...clip.body]).toHaveLength(2);
  });

  it("drops a surrogate pair that only partly fits", () => {
    expect(clipEvidenceBody("x😀x", 4).body).toBe("x");
  });

  it("defaults to the shared cap", () => {
    const big = "x".repeat(MAX_EVIDENCE_BODY_BYTES + 10);
    const clip = clipEvidenceBody(big);
    expect(clip.body).toHaveLength(MAX_EVIDENCE_BODY_BYTES);
    expect(clip.bytes).toBe(MAX_EVIDENCE_BODY_BYTES + 10);
  });
});

describe("evidenceExcerpt", () => {
  it("collapses whitespace into a single display line", () => {
    expect(evidenceExcerpt("  two\n\nlines\there ")).toBe("two lines here");
  });

  it("elides past the cap", () => {
    const excerpt = evidenceExcerpt("y".repeat(MAX_EVIDENCE_EXCERPT_CHARS + 50));
    expect(excerpt).toHaveLength(MAX_EVIDENCE_EXCERPT_CHARS);
    expect(excerpt.endsWith("…")).toBe(true);
  });
});
