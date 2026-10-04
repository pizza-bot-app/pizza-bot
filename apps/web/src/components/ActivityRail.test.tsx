import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  MAX_EVIDENCE_BODY_BYTES,
  type ApprovalVerdict,
  type EvidenceEntry,
} from "@pizza-bot/core";
import type { DelegationInfo } from "@/projection";
import { ActivityRail, ApprovalsSection, EvidenceSection, formatSize } from "./ActivityRail.js";
import type { EvidenceLedger } from "../use-evidence.js";

function delegation(overrides: Partial<DelegationInfo> = {}): DelegationInfo {
  return {
    delegationId: "task-1",
    subagent: "mail-assistant",
    title: "send the note",
    status: "running",
    depth: 0,
    parentId: null,
    ...overrides,
  };
}

function render(delegations: DelegationInfo[], isRunning = false): string {
  return renderToStaticMarkup(
    <ActivityRail
      delegations={Object.fromEntries(delegations.map((d) => [d.delegationId, d]))}
      isRunning={isRunning}
    />,
  );
}

describe("ActivityRail delegation status", () => {
  it("shows a delegation waiting on approval as awaiting input, not failed", () => {
    const html = render([delegation({ status: "awaiting-input" })]);

    expect(html).toContain("activity-icon-await");
    expect(html).toContain("Awaiting approval");
    expect(html).not.toContain("activity-icon-error");
  });

  it("still marks a genuinely failed delegation with the error icon", () => {
    const html = render([delegation({ status: "error", errorText: "worker crashed" })]);

    expect(html).toContain("activity-icon-error");
    expect(html).not.toContain("activity-icon-await");
  });

  it("reports a batch as awaiting input when any member waits on approval", () => {
    const html = render([
      delegation({ delegationId: "task-1", status: "awaiting-input", batchId: "b1" }),
      delegation({ delegationId: "task-2", subagent: "sfdc-assistant", status: "running", batchId: "b1" }),
    ]);

    expect(html).toContain("activity-icon-await");
    expect(html).not.toContain("activity-icon-error");
  });

  it("keeps an errored batch member from turning the batch into a failure while one waits", () => {
    const awaiting = render([
      delegation({ delegationId: "task-1", status: "awaiting-input", batchId: "b1" }),
      delegation({ delegationId: "task-2", status: "error", errorText: "boom", batchId: "b1" }),
    ]);

    // The batch head reads awaiting; only the failed child keeps its error icon.
    expect(awaiting.indexOf("activity-icon-await")).toBeLessThan(awaiting.indexOf("activity-icon-error"));
  });
});

function entry(overrides: Partial<EvidenceEntry> = {}): EvidenceEntry {
  return {
    id: "ev_1",
    threadId: "t1",
    runId: "r1",
    toolRef: "mcp:outlook:mail_search",
    breadcrumb: "mail_search",
    excerpt: "Subscription renews March 4, 2027.",
    bytes: 40,
    truncated: false,
    createdAt: "2026-09-21T00:00:00.000Z",
    ...overrides,
  };
}

function ledger(
  entries: EvidenceEntry[],
  citedIds: string[] = [],
  unavailable: string[] = [],
): EvidenceLedger {
  return {
    threadId: "t1",
    entries,
    loaded: true,
    bodies: new Map(),
    unavailable: new Set(unavailable),
    citedIds: new Set(citedIds),
    hoveredId: null,
    selectedId: null,
    cite: () => undefined,
    loadBodies: () => undefined,
    hover: () => undefined,
    select: () => undefined,
  };
}

describe("ActivityRail evidence", () => {
  it("lists cited sources before the rest and labels them", () => {
    const html = renderToStaticMarkup(
      <EvidenceSection
        ledger={ledger(
          [entry({ id: "ev_1", breadcrumb: "calendar_list" }), entry({ id: "ev_2", breadcrumb: "mail_search" })],
          ["ev_2"],
        )}
      />,
    );

    expect(html.indexOf("mail_search")).toBeLessThan(html.indexOf("calendar_list"));
    expect(html).toContain(">cited<");
    expect(html).toContain("1 cited");
  });

  it("shows each source collapsed, as an excerpt rather than a body", () => {
    const html = renderToStaticMarkup(<EvidenceSection ledger={ledger([entry()])} />);

    expect(html).toContain("evidence-excerpt");
    expect(html).toContain("Subscription renews March 4, 2027.");
    expect(html).not.toContain("evidence-body");
  });

  it("stays silent about clipping until the source is opened", () => {
    const html = renderToStaticMarkup(<EvidenceSection ledger={ledger([entry({ truncated: true })])} />);

    expect(html).not.toContain("evidence-note");
  });

  it("sizes a clipped source so the reviewer sees how much went unread", () => {
    expect(formatSize(MAX_EVIDENCE_BODY_BYTES)).toBe("256 KB");
    expect(formatSize(490_417)).toBe("479 KB");
    expect(formatSize(40)).toBe("40 B");
    expect(formatSize(3_500_000)).toBe("3.3 MB");
  });
});

function verdict(overrides: Partial<ApprovalVerdict> = {}): ApprovalVerdict {
  return {
    seq: 1,
    verdictId: "vd_1",
    threadId: "t1",
    runId: "r1",
    interruptId: "call_1",
    toolName: "billing__send_reply",
    decision: "approve",
    spans: [
      {
        arg: "body",
        text: "Renewal: 4 March 2027",
        evidenceId: "ev_1",
        tier: "verifiable",
        breadcrumb: "lookup_account",
      },
    ],
    createdAt: "2026-09-21T00:00:00.000Z",
    ...overrides,
  };
}

describe("ActivityRail approved actions", () => {
  const render = (verdicts: ApprovalVerdict[]) =>
    renderToStaticMarkup(<ApprovalsSection verdicts={verdicts} ledger={ledger([entry()])} />);

  it("keeps each shipped claim at the tier the audit stored, not a recomputed one", () => {
    const html = render([
      verdict({
        decision: "edit",
        spans: [
          { arg: "body", text: "Renewal: 4 March 2027", evidenceId: "ev_1", tier: "verifiable" },
          {
            arg: "body",
            text: "Annual cost: $1,200.00",
            evidenceId: "ev_1",
            tier: "asserted",
            gap: { reason: "figures", tokens: ["$1,200.00"] },
          },
          { arg: "body", text: "Plan: Trattoria Pro", evidenceId: "ev_1", tier: "unresolved" },
        ],
      }),
    ]);

    expect(html).toContain("grounding-verifiable");
    expect(html).toContain("grounding-asserted");
    expect(html).toContain("grounding-unresolved");
    expect(html).toContain("Not in the cited source: $1,200.00");
    expect(html).toContain("sent with edits");
  });

  it("spells out that an unplaced span was never checked, rather than only underlining it", () => {
    const html = render([
      verdict({
        spans: [
          { arg: "body", text: "Renewal date: March 4, 2027", evidenceId: "ev_1", tier: "verifiable" },
          { arg: "body", text: "Plan: Trattoria Pro", evidenceId: "ev_1", tier: "unresolved" },
        ],
      }),
    ]);

    expect(html.match(/grounding-chip/g)).toHaveLength(1);
    expect(html).toContain("not checked");
    // The chip precedes the text it qualifies, so the reviewer reads it first.
    expect(html.indexOf("not checked")).toBeLessThan(html.indexOf("Plan: Trattoria Pro"));
  });

  it("names the source a span quoted even when its ledger entry is gone", () => {
    const html = renderToStaticMarkup(
      <ApprovalsSection verdicts={[verdict()]} ledger={ledger([])} />,
    );

    expect(html).toContain("lookup_account");
  });

  it("says plainly that an uncited action was never checked", () => {
    const html = render([verdict({ spans: [] })]);

    expect(html).toContain("Nothing in it was cited");
    expect(html).not.toContain("grounding-span");
  });

  it("marks the tiers inside the text that went out, not only in a list of quotes", () => {
    const html = render([
      verdict({
        args: { to: "someone@example.test", body: "Renewal: 4 March 2027. Fee: $12.00." },
      }),
    ]);

    expect(html).toContain("Renewal: 4 March 2027");
    expect(html).toContain("grounding-verifiable");
    expect(html).toContain("verdict-field-text");
    expect(html).toContain("Body");
    // With the text on the page there is nowhere left for a bare quote to stand.
    expect(html).not.toContain("verdict-spans");
  });

  it("marks a figure the citations never covered, since that is where a fabrication hides", () => {
    const html = render([
      verdict({ args: { body: "Renewal: 4 March 2027. Fee: $12.00." } }),
    ]);

    expect(html).toContain("grounding-unbacked");
    expect(html).toContain("No citation covers this figure");
  });

  it("still lists a quote that addresses no place in the text that shipped", () => {
    const html = render([
      verdict({
        args: { body: "Rewritten by the reviewer." },
        spans: [
          { arg: "body", text: "Renewal: 4 March 2027", evidenceId: "ev_1", tier: "unresolved" },
        ],
      }),
    ]);

    expect(html).toContain("verdict-spans");
    expect(html).toContain("not checked");
    expect(html).toContain("Rewritten by the reviewer.");
  });
});
