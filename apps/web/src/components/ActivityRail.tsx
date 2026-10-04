import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { CheckCircle2, ChevronDown, ChevronRight, Clock, Loader2, X, XCircle } from "lucide-react";
import {
  MAX_EVIDENCE_BODY_BYTES,
  type ApprovalDecision,
  type ApprovalVerdict,
  type ApprovalVerdictSpan,
  type EvidenceEntry,
  type GroundingTier,
} from "@pizza-bot/core";
import {
  segmentAuditedText,
  type DelegationInfo,
  type GroundingSegment,
  type UIMessageLike,
  type UIPartLike,
} from "@/projection";
import type { ApiClient } from "@/api-client";
import { Avatar } from "./Avatar.js";
import {
  formatArgumentLabel,
  groundingTitle,
  GroundedSegments,
  type GroundingLinks,
} from "./ApprovalArguments.js";
import { useSubagentTranscript } from "../use-thread-slice.js";
import { useApprovalVerdicts } from "../use-approval-verdicts.js";
import { useEvidence, type EvidenceLedger } from "../use-evidence.js";

export function ActivityRail({
  delegations,
  isRunning,
  threadId,
  client,
  revision,
  onClose,
}: {
  delegations?: Record<string, DelegationInfo>;
  isRunning: boolean;
  threadId?: string | null;
  client?: ApiClient;
  revision?: string;
  onClose?: () => void;
}) {
  const groups = Object.values(delegations ?? {});
  const batches = groupIntoBatches(groups);
  const baseDepth = groups.reduce((m, g) => Math.min(m, g.depth ?? 0), Infinity);
  const ledger = useEvidence();
  const verdicts = useApprovalVerdicts(client, threadId, revision);

  return (
    <div className="activity-rail">
      <div className="activity-rail-head">
        <span className="activity-rail-title">Activity</span>
        {isRunning && (
          <span className="activity-rail-running">
            <span className="pulse">
              <span className="pulse-ping" />
              <span className="pulse-dot" />
            </span>
            running
          </span>
        )}
        <span className="rail-head-spacer" />
        {onClose && (
          <button className="rail-close" title="Hide activity" aria-label="Hide activity" onClick={onClose}>
            <X size={14} />
          </button>
        )}
      </div>

      {groups.length > 0 || ledger.entries.length > 0 || verdicts.length > 0 ? (
        <div className="activity-rail-body">
          {groups.length > 0 && (
            <section className="rail-section">
              <div className="rail-section-head">Delegations</div>
              <ul className="delegation-groups">
                {batches.map((b) =>
                  b.items.length > 1 ? (
                    <DelegationBatch
                      key={b.key}
                      batch={b}
                      threadId={threadId}
                      baseDepth={baseDepth}
                      runSettled={!isRunning}
                    />
                  ) : (
                    <DelegationGroup
                      key={b.key}
                      g={b.items[0]!}
                      threadId={threadId}
                      baseDepth={baseDepth}
                      runSettled={!isRunning}
                    />
                  ),
                )}
              </ul>
            </section>
          )}
          {verdicts.length > 0 && <ApprovalsSection verdicts={verdicts} ledger={ledger} />}
          {ledger.entries.length > 0 && <EvidenceSection ledger={ledger} />}
        </div>
      ) : (
        <div className="activity-rail-empty">No delegated work yet.</div>
      )}
    </div>
  );
}

const DECISION_LABEL: Record<ApprovalDecision, string> = {
  approve: "sent as drafted",
  edit: "sent with edits",
};

/**
 * What a reviewer let out of the building, and how well each claim in it stood up. This
 * is the stored record rather than the live card, so it survives a reload and an edit.
 */
export function ApprovalsSection({
  verdicts,
  ledger,
}: {
  verdicts: readonly ApprovalVerdict[];
  ledger: EvidenceLedger;
}) {
  return (
    <section className="rail-section">
      <div className="rail-section-head">Approved actions</div>
      <ul className="verdict-cards">
        {verdicts.map((verdict) => (
          <VerdictCard key={verdict.verdictId} verdict={verdict} ledger={ledger} />
        ))}
      </ul>
    </section>
  );
}

/** A stored verdict is never redrawn by what this browser can load, so nothing is pending. */

function VerdictCard({
  verdict,
  ledger,
}: {
  verdict: ApprovalVerdict;
  ledger: EvidenceLedger;
}) {
  const label = formatArgumentLabel(verdict.toolName);
  const fields = sentFields(verdict);
  // Without the sent text there is nowhere to underline, so every quote stands alone; with
  // it, only the quotes that address no place in it are still left to list.
  const quotes =
    fields.length === 0
      ? verdict.spans
      : verdict.spans.filter((span) => span.tier === "unresolved");
  const links: GroundingLinks = {
    status: "ready",
    hoveredId: ledger.hoveredId,
    onHover: ledger.hover,
    onSelect: ledger.select,
  };
  return (
    <li className="verdict-card" title={verdict.createdAt}>
      <div className="verdict-head">
        <span className="verdict-tool" title={verdict.toolName}>
          {label}
        </span>
        <span className={`verdict-decision verdict-decision-${verdict.decision}`}>
          {DECISION_LABEL[verdict.decision]}
        </span>
      </div>
      {verdict.spans.length === 0 && (
        <div className="verdict-note">Nothing in it was cited, so nothing was checked.</div>
      )}
      {fields.map(({ arg, segments }) => (
        <div className="verdict-field" key={arg}>
          <span className="verdict-field-label">{formatArgumentLabel(arg)}</span>
          <span className="verdict-field-text">
            <GroundedSegments segments={segments} links={links} />
          </span>
        </div>
      ))}
      {quotes.length > 0 && fields.length > 0 && (
        <span className="verdict-field-label">Cited, but not in what was sent</span>
      )}
      {quotes.length > 0 && (
        <ul className="verdict-spans">
          {quotes.map((span, index) => (
            <li className="verdict-span" key={index}>
              <VerdictQuote span={span} links={links} />
            </li>
          ))}
        </ul>
      )}
      <VerdictSources spans={verdict.spans} />
    </li>
  );
}

/**
 * The text that went out, split at the tiers the audit reached for it. Rendering it rather
 * than the span list alone is what makes an uncited claim visible in the record at all.
 */
function sentFields(
  verdict: ApprovalVerdict,
): Array<{ arg: string; segments: GroundingSegment[] }> {
  const args = verdict.args;
  if (args === null || typeof args !== "object" || Array.isArray(args)) return [];
  return Object.entries(args).flatMap(([arg, value]) =>
    typeof value === "string" && value !== ""
      ? [{ arg, segments: segmentAuditedText(value, verdict.spans.filter((s) => s.arg === arg)) }]
      : [],
  );
}

/** The breadcrumb is stored with the verdict, so it still names the source once the
 *  ledger entry is gone. */
function sourceOf(span: ApprovalVerdictSpan | undefined): string | undefined {
  return span && (span.breadcrumb ?? span.evidenceId);
}

function VerdictSources({ spans }: { spans: readonly ApprovalVerdictSpan[] }) {
  const sources = [...new Set(spans.map((span) => sourceOf(span)!).filter(Boolean))];
  if (sources.length === 0) return null;
  return (
    <div className="verdict-sources">
      {sources.map((source) => (
        <span className="verdict-span-source" key={source} title={source}>
          {source}
        </span>
      ))}
    </div>
  );
}

/**
 * An underline is too quiet to carry "nobody checked this" at the rail's text size, so the
 * words say it. The absence of a verdict is not an accusation, so the chip stays neutral.
 */
function NotCheckedChip({ tier }: { tier: GroundingTier }) {
  if (tier !== "unresolved") return null;
  return <span className="grounding-chip">not checked</span>;
}

function VerdictQuote({ span, links }: { span: ApprovalVerdictSpan; links: GroundingLinks }) {
  const id = span.evidenceId;
  return (
    <span
      role="button"
      tabIndex={0}
      className={`grounding-span grounding-${span.tier}${
        links.hoveredId === id ? " hovered" : ""
      }`}
      title={groundingTitle(span.tier, span.gap, span.support)}
      onMouseEnter={() => links.onHover(id)}
      onMouseLeave={() => links.onHover(null)}
      onFocus={() => links.onHover(id)}
      onBlur={() => links.onHover(null)}
      onClick={() => links.onSelect(id)}
      onKeyDown={(e: KeyboardEvent) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          links.onSelect(id);
        }
      }}
    >
      <NotCheckedChip tier={span.tier} />
      {span.text}
    </span>
  );
}

export function EvidenceSection({ ledger }: { ledger: EvidenceLedger }) {
  const cited = ledger.entries.filter((entry) => ledger.citedIds.has(entry.id));
  const rest = ledger.entries.filter((entry) => !ledger.citedIds.has(entry.id));
  return (
    <section className="rail-section">
      <div className="rail-section-head">
        Evidence
        {cited.length > 0 && <span className="rail-section-count">{cited.length} cited</span>}
      </div>
      <ul className="evidence-cards">
        {[...cited, ...rest].map((entry) => (
          <EvidenceCard
            key={entry.id}
            entry={entry}
            ledger={ledger}
            cited={ledger.citedIds.has(entry.id)}
          />
        ))}
      </ul>
    </section>
  );
}

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  return kb < 1024 ? `${Math.round(kb)} KB` : `${(kb / 1024).toFixed(1)} MB`;
}

function EvidenceCard({
  entry,
  ledger,
  cited,
}: {
  entry: EvidenceEntry;
  ledger: EvidenceLedger;
  cited: boolean;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLLIElement>(null);
  const { loadBodies } = ledger;
  const selected = ledger.selectedId === entry.id;

  useEffect(() => {
    if (!selected) return;
    setOpen(true);
    loadBodies([entry.id]);
    ref.current?.scrollIntoView?.({ block: "nearest", behavior: "smooth" });
  }, [selected, entry.id, loadBodies]);

  const toggle = () => {
    if (!open) loadBodies([entry.id]);
    setOpen((v) => !v);
  };
  const body = ledger.bodies.get(entry.id);

  return (
    <li
      ref={ref}
      className={`evidence-card${selected ? " selected" : ""}${
        ledger.hoveredId === entry.id ? " hovered" : ""
      }`}
      onMouseEnter={() => ledger.hover(entry.id)}
      onMouseLeave={() => ledger.hover(null)}
    >
      <div
        className="evidence-head expandable"
        role="button"
        tabIndex={0}
        onClick={toggle}
        onKeyDown={(e: KeyboardEvent) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            toggle();
          }
        }}
      >
        {open ? (
          <ChevronDown className="delegation-caret" size={12} />
        ) : (
          <ChevronRight className="delegation-caret" size={12} />
        )}
        <span className="evidence-breadcrumb" title={entry.toolRef}>
          {entry.breadcrumb}
        </span>
        {cited && <span className="evidence-cited">cited</span>}
      </div>
      {open ? (
        <>
          <pre className="evidence-body">{body?.text ?? entry.excerpt}</pre>
          {entry.truncated && (
            <div className="evidence-note">
              Clipped — the model read {formatSize(MAX_EVIDENCE_BODY_BYTES)} of this{" "}
              {formatSize(entry.bytes)} source.
            </div>
          )}
          {ledger.unavailable.has(entry.id) && (
            <div className="evidence-note">
              The stored source could not be loaded; this is the recorded excerpt.
            </div>
          )}
        </>
      ) : (
        <div className="evidence-excerpt">{entry.excerpt}</div>
      )}
    </li>
  );
}

function inFlight(status: DelegationInfo["status"]): boolean {
  return status === "running" || status === "awaiting-input";
}

interface Batch {
  key: string;
  items: DelegationInfo[];
}

function groupIntoBatches(groups: DelegationInfo[]): Batch[] {
  const batches: Batch[] = [];
  const byKey = new Map<string, Batch>();
  for (const g of groups) {
    const key = g.batchId ?? `solo:${g.delegationId}`;
    let b = byKey.get(key);
    if (!b) {
      b = { key, items: [] };
      byKey.set(key, b);
      batches.push(b);
    }
    b.items.push(g);
  }
  return batches;
}

function DelegationBatch({
  batch,
  threadId,
  baseDepth,
  runSettled,
}: {
  batch: Batch;
  threadId?: string | null;
  baseDepth: number;
  runSettled: boolean;
}) {
  const [open, setOpen] = useState(true);
  const items = batch.items;
  const rel = (items[0]?.depth ?? 0) - baseDepth;
  const indent = rel > 0 ? { marginLeft: rel * 12 } : undefined;
  const names = [...new Set(items.map((i) => i.subagent))];
  const label = names.join(" · ");
  const showCount = items.length !== names.length;
  const awaiting = items.some((i) => i.status === "awaiting-input");
  const running = items.some((i) => i.status === "running");
  const errored = items.some((i) => i.status === "error");
  const status: DelegationInfo["status"] = awaiting
    ? "awaiting-input"
    : running
      ? "running"
      : errored
        ? "error"
        : "completed";
  const starts = items.map((i) => i.startedAt).filter((n): n is number => n !== undefined);
  const ends = items.map((i) => i.completedAt).filter((n): n is number => n !== undefined);
  // SDK completion timestamps can move until the parent run settles.
  const duration =
    !runSettled || inFlight(status) || !starts.length || ends.length < items.length
      ? undefined
      : formatDuration(Math.min(...starts), Math.max(...ends));

  return (
    <li className="delegation-batch" style={indent}>
      <div
        className="delegation-head expandable batch-head"
        role="button"
        tabIndex={0}
        onClick={() => setOpen((v) => !v)}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            setOpen((v) => !v);
          }
        }}
      >
        {open ? (
          <ChevronDown className="delegation-caret" size={12} />
        ) : (
          <ChevronRight className="delegation-caret" size={12} />
        )}
        <span className="delegation-avatars">
          {names.slice(0, 3).map((n) => (
            <Avatar key={n} label={n} size={16} />
          ))}
        </span>
        <span className="delegation-subagent" title={label}>
          {label}
        </span>
        {showCount && <span className="delegation-batch-count">· {items.length} subagents</span>}
        {duration && <span className="delegation-duration">{duration}</span>}
        <CallIndicator status={status} />
      </div>
      {open && (
        <ul className="delegation-batch-children">
          {items.map((g) => (
            <DelegationGroup key={g.delegationId} g={g} threadId={threadId} baseDepth={baseDepth} inBatch />
          ))}
        </ul>
      )}
    </li>
  );
}

function DelegationGroup({
  g,
  threadId,
  baseDepth = 0,
  inBatch = false,
  runSettled = false,
}: {
  g: DelegationInfo;
  threadId?: string | null;
  baseDepth?: number;
  inBatch?: boolean;
  runSettled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const transcript = useSubagentTranscript(threadId ?? "", g.delegationId, open && !!threadId);
  const detail = g.status === "error" ? g.errorText : outputText(g.output);
  const canExpand =
    inFlight(g.status) || (transcript?.length ?? 0) > 0 || (detail !== undefined && detail.length > 0);
  // Batch rows own their shared duration; solo timestamps settle with the run.
  const duration =
    inBatch || !runSettled || inFlight(g.status)
      ? undefined
      : formatDuration(g.startedAt, g.completedAt);
  const rel = (g.depth ?? 0) - baseDepth;
  const indent = !inBatch && rel > 0 ? { marginLeft: rel * 12 } : undefined;
  const toggle = () => setOpen((v) => !v);

  return (
    <li className="delegation-group" style={indent}>
      <div
        className={`delegation-head${canExpand ? " expandable" : ""}`}
        {...(canExpand
          ? {
              role: "button",
              tabIndex: 0,
              onClick: toggle,
              onKeyDown: (e: KeyboardEvent) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  toggle();
                }
              },
            }
          : {})}
      >
        {canExpand ? (
          open ? (
            <ChevronDown className="delegation-caret" size={12} />
          ) : (
            <ChevronRight className="delegation-caret" size={12} />
          )
        ) : (
          <span className="delegation-caret-spacer" />
        )}
        <Avatar label={g.subagent} size={16} />
        <span className="delegation-subagent">{g.subagent}</span>
        {duration && <span className="delegation-duration">{duration}</span>}
        <CallIndicator status={g.status} />
      </div>
      {g.title && (
        <div className="delegation-title" title={g.title}>
          {g.title}
        </div>
      )}
      {open &&
        (transcript && transcript.length > 0 ? (
          <SubagentTranscript messages={transcript} settled={!inFlight(g.status)} />
        ) : detail !== undefined && detail.length > 0 ? (
          <pre className={`delegation-detail${g.status === "error" ? " error" : ""}`}>{detail}</pre>
        ) : (
          <div className="delegation-detail muted">
            {g.status === "awaiting-input"
              ? "Waiting for your approval…"
              : g.status === "running"
                ? "Waiting for the subagent to report…"
                : "No transcript available."}
          </div>
        ))}
    </li>
  );
}

function SubagentTranscript({ messages, settled }: { messages: UIMessageLike[]; settled: boolean }) {
  const parts = messages.flatMap((m) => m.parts.map((p) => ({ role: m.role, part: p })));
  return (
    <div className="subagent-transcript">
      {parts.map(({ part }, i) => (
        <TranscriptPart key={i} part={part} settled={settled} />
      ))}
    </div>
  );
}

type ToolPartLike = Extract<UIPartLike, { type: `tool-${string}` }>;

function TranscriptPart({ part, settled }: { part: UIPartLike; settled: boolean }) {
  if (part.type === "text") return <p className="transcript-text">{part.text}</p>;
  if (part.type === "reasoning") return <p className="transcript-reasoning">💭 {part.text}</p>;
  if (part.type.startsWith("tool-")) {
    const tool = part as ToolPartLike;
    const name = tool.type.slice("tool-".length);
    const unresolved = tool.state !== "output-available" && tool.state !== "output-error";
    const endedWithoutResult = settled && unresolved;
    const detail = tool.state === "output-error" ? tool.errorText : outputText(tool.output);
    return (
      <div className="transcript-tool">
        <div className="transcript-tool-head">
          <ToolStatusIcon state={endedWithoutResult ? "output-error" : tool.state} />
          <span className="transcript-tool-name">{name}</span>
        </div>
        {detail !== undefined && detail.length > 0 && (
          <pre className={`transcript-tool-io${tool.state === "output-error" ? " error" : ""}`}>{detail}</pre>
        )}
      </div>
    );
  }
  return null;
}

function ToolStatusIcon({ state }: { state?: string }) {
  if (state === "output-available") return <CheckCircle2 className="activity-icon activity-icon-done" size={12} />;
  if (state === "output-error") return <XCircle className="activity-icon activity-icon-error" size={12} />;
  return <Loader2 className="activity-icon activity-icon-active spin" size={12} />;
}

function outputText(output: unknown): string | undefined {
  if (output === undefined || output === null) return undefined;
  if (typeof output === "string") return output;
  const content = messageContent(output);
  if (content !== undefined) return content;
  try {
    return JSON.stringify(output, null, 2);
  } catch {
    return String(output);
  }
}

function messageContent(v: unknown): string | undefined {
  if (typeof v !== "object" || v === null) return undefined;
  const rec = v as Record<string, unknown>;
  // Serialized LangChain messages wrap content in kwargs; live objects do not.
  const content = (rec.kwargs as Record<string, unknown> | undefined)?.content ?? rec.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const text = content
      .map((p) => (typeof p === "object" && p && "text" in p ? String((p as { text: unknown }).text) : ""))
      .filter(Boolean)
      .join("\n\n");
    return text || undefined;
  }
  return undefined;
}

function formatDuration(startedAt?: number, completedAt?: number): string | undefined {
  if (startedAt === undefined || completedAt === undefined) return undefined;
  const ms = completedAt - startedAt;
  if (ms < 0) return undefined;
  if (ms < 1000) return `${ms}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  const m = Math.floor(s / 60);
  return `${m}m ${Math.round(s % 60)}s`;
}

function CallIndicator({ status }: { status: DelegationInfo["status"] }) {
  if (status === "completed") {
    return <CheckCircle2 className="activity-icon activity-icon-done" size={13} />;
  }
  if (status === "error") {
    return <XCircle className="activity-icon activity-icon-error" size={13} />;
  }
  if (status === "awaiting-input") {
    return (
      <Clock className="activity-icon activity-icon-await" size={13} aria-label="Awaiting approval">
        <title>Awaiting approval</title>
      </Clock>
    );
  }
  return <Loader2 className="activity-icon activity-icon-active spin" size={13} />;
}
