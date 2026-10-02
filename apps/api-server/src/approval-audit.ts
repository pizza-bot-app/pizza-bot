/**
 * Recomputes the citation audit when a human approves a gated action, from the
 * interrupt's own spans and the server-owned evidence ledger. A verdict a client
 * computed would be provenance the client could choose.
 */
import {
  auditGroundingSpans,
  citedEvidenceIds,
  parseInterruptActions,
  withoutGroundingArgument,
  type ApprovalDecision,
  type ApprovalVerdictSpan,
  type CitedSource,
  type ResumeCommand,
  type ThreadState,
} from "@pizza-bot/core";
import type { ApprovalVerdictStore, EvidenceStore } from "@pizza-bot/storage";

export interface ApprovalAuditDeps {
  verdicts: ApprovalVerdictStore;
  evidence?: EvidenceStore | undefined;
}

export interface ApprovalAuditInput {
  threadId: string;
  /** The run resuming the thread, which is the one that dispatches the action. */
  runId: string;
  /** Read before the resume, while the interrupt still carries the drafted args. */
  state: ThreadState;
  resume: ResumeCommand;
}

export type ApprovalAuditor = (input: ApprovalAuditInput) => void;

const DISPATCHING: ReadonlySet<string> = new Set<ApprovalDecision>(["approve", "edit"]);

/** Reject and respond dispatch nothing, so they leave no record of what was checked. */
export function dispatchesAction(resume: unknown): resume is ResumeCommand {
  const decisions = (resume as ResumeCommand | undefined)?.decisions;
  return (
    Array.isArray(decisions) && decisions.some((d) => DISPATCHING.has(String(d?.decision)))
  );
}

export function approvalAuditor(deps: ApprovalAuditDeps): ApprovalAuditor {
  return (input) => {
    // A failed audit must never reject a decision the reviewer already made.
    try {
      recordVerdicts(deps, input);
    } catch (err) {
      console.error("[grounding] failed to record approval verdicts:", err);
    }
  };
}

function recordVerdicts(deps: ApprovalAuditDeps, input: ApprovalAuditInput): void {
  const interrupt = input.state.interrupts?.find((i) => i.id === input.resume.interruptId);
  if (!interrupt) return;
  const { actions } = parseInterruptActions(interrupt.value);

  actions.forEach((action, index) => {
    const decision = input.resume.decisions[index]?.decision;
    if (decision !== "approve" && decision !== "edit") return;
    const edit = decision === "edit" ? input.resume.decisions[index]! : undefined;
    // An edit invalidates quotes of the draft it replaced, so audit what ships.
    const args = edit ? edit.editedArgs : action.args;
    deps.verdicts.append({
      verdictId: `${input.resume.interruptId}#${index}`,
      threadId: input.threadId,
      runId: input.runId,
      interruptId: input.resume.interruptId,
      toolName: edit?.editedName ?? action.toolName,
      decision,
      // Citations are provenance, not content, and the spans already carry them.
      args: withoutGroundingArgument(args),
      spans: auditedSpans(deps, input.threadId, args),
    });
  });
}

function auditedSpans(
  deps: ApprovalAuditDeps,
  threadId: string,
  args: unknown,
): ApprovalVerdictSpan[] {
  const sources = new Map<string, CitedSource>();
  const identities = new Map<string, { breadcrumb: string; bytes: number; truncated: boolean }>();
  for (const id of citedEvidenceIds(args)) {
    // A citation naming another thread's entry is not this thread's evidence.
    const entry = deps.evidence?.get(id);
    if (!entry || entry.threadId !== threadId) continue;
    identities.set(id, {
      breadcrumb: entry.breadcrumb,
      bytes: entry.bytes,
      truncated: entry.truncated,
    });
    const text = deps.evidence?.readBody(id);
    if (text !== undefined) sources.set(id, { text, truncated: entry.truncated });
  }
  return auditGroundingSpans(args, sources).map((span) => {
    const identity = identities.get(span.evidenceId);
    return { ...span, ...(identity ?? {}) };
  });
}
