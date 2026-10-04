import { describe, expect, it } from "vitest";
import { evidenceExcerpt } from "./evidence.js";
import { evidenceLines, numberEvidenceLines, parseEvidenceLines } from "./evidence-lines.js";

describe("evidenceLines", () => {
  it("keeps a JSON row's fields on one line, so its date and status stay bound together", () => {
    const lines = evidenceLines(
      JSON.stringify({
        plan: "Standard",
        swap_fee: { amount: "12.00", waived: false },
        invoices: [
          { id: "INV-1", date: "2026-03-04", status: "failed" },
          { id: "INV-2", date: "2026-04-04", status: "open" },
        ],
        tags: ["a", "b"],
      }),
    );
    expect(lines).toEqual([
      'plan: "Standard"',
      'swap_fee: {amount="12.00", waived=false}',
      'invoices[0]: {id="INV-1", date="2026-03-04", status="failed"}',
      'invoices[1]: {id="INV-2", date="2026-04-04", status="open"}',
      'tags[0]: "a"',
      'tags[1]: "b"',
    ]);
  });

  it("escapes a newline inside a JSON value rather than starting a new line", () => {
    expect(evidenceLines(JSON.stringify({ note: "one\ntwo" }))).toEqual(['note: "one\\ntwo"']);
  });

  it("splits prose into lines and sentences without breaking at an abbreviation", () => {
    const text = "Refund policy (rev. 2026-02). Duplicate charges are refunded in 5-7 days.\n\nStore credit e.g. vouchers is optional.";
    expect(evidenceLines(text)).toEqual([
      "Refund policy (rev. 2026-02).",
      "Duplicate charges are refunded in 5-7 days.",
      "Store credit e.g. vouchers is optional.",
    ]);
  });

  it("reads a clipped JSON payload as text instead of failing", () => {
    expect(evidenceLines('{"plan": "Standard", "amo')).toEqual(['{"plan": "Standard", "amo']);
  });

  it("wraps a line too long to be a useful citation", () => {
    const lines = evidenceLines("x".repeat(2_500));
    expect(lines.map((line) => line.length)).toEqual([1_000, 1_000, 500]);
  });
});

describe("numbered evidence", () => {
  it("round-trips through the numbered form the model reads and the ledger stores", () => {
    const numbered = numberEvidenceLines('{"plan": "Standard", "status": "active"}');
    expect(numbered).toBe('[1] plan: "Standard"\n[2] status: "active"');
    expect(parseEvidenceLines("[1] first\n[2] second [3] not a label")).toEqual(
      new Map([
        [1, "first"],
        [2, "second [3] not a label"],
      ]),
    );
  });

  it("keeps line numbers out of the excerpt a reviewer skims", () => {
    expect(evidenceExcerpt("[1] Plan: Standard\n[2] Status: active")).toBe("Plan: Standard Status: active");
  });
});
