import { useState, type KeyboardEvent } from "react";
import { CheckCircle2, ChevronDown, ChevronRight, Clock, Loader2, X, XCircle } from "lucide-react";
import type { DelegationInfo, UIMessageLike, UIPartLike } from "@/projection";
import { Avatar } from "./Avatar.js";
import { useSubagentTranscript } from "../use-thread-slice.js";

export function ActivityRail({
  delegations,
  isRunning,
  threadId,
  onClose,
}: {
  delegations?: Record<string, DelegationInfo>;
  isRunning: boolean;
  threadId?: string | null;
  onClose?: () => void;
}) {
  const groups = Object.values(delegations ?? {});
  const batches = groupIntoBatches(groups);
  const baseDepth = groups.reduce((m, g) => Math.min(m, g.depth ?? 0), Infinity);

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

      {groups.length > 0 ? (
        <div className="activity-rail-body">
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
        </div>
      ) : (
        <div className="activity-rail-empty">No delegated work yet.</div>
      )}
    </div>
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
