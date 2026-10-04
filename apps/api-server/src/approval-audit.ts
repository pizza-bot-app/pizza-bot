/**
 * Records the citation audit when a human approves a gated action, graded by the server's
 * judge over the arguments that ship. A verdict a client computed would be provenance the
 * client could choose.
 */
import {
  parseInterruptActions,
  withoutGroundingArgument,
  type ApprovalDecision,
  type ResumeCommand,
  type ThreadState,
} from "@pizza-bot/core";
import type { ApprovalVerdictStore } from "@pizza-bot/storage";
import type { GroundingJudge } from "./grounding-judge.js";

export interface ApprovalAuditDeps {
  verdicts: ApprovalVerdictStore;
  judge: GroundingJudge;
}

export interface ApprovalAuditInput {
  threadId: string;
  /** The run resuming the thread, which is the one that dispatches the action. */
  runId: string;
  /** Read before the resume, while the interrupt still carries the drafted args. */
  state: ThreadState;
  resume: ResumeCommand;
}

/** Settles once the verdicts are stored; the resume it describes never waits on it. */
export type ApprovalAuditor = (input: ApprovalAuditInput) => Promise<void>;

const DISPATCHING: ReadonlySet<string> = new Set<ApprovalDecision>(["approve", "edit"]);

/** Reject and respond dispatch nothing, so they leave no record of what was checked. */
export function dispatchesAction(resume: unknown): resume is ResumeCommand {
  const decisions = (resume as ResumeCommand | undefined)?.decisions;
  return (
    Array.isArray(decisions) && decisions.some((d) => DISPATCHING.has(String(d?.decision)))
  );
}

export function approvalAuditor(deps: ApprovalAuditDeps): ApprovalAuditor {
  return async (input) => {
    // A failed audit must never reject a decision the reviewer already made.
    try {
      await recordVerdicts(deps, input);
    } catch (err) {
      console.error("[grounding] failed to record approval verdicts:", err);
    }
  };
}

async function recordVerdicts(deps: ApprovalAuditDeps, input: ApprovalAuditInput): Promise<void> {
  const interrupt = input.state.interrupts?.find((i) => i.id === input.resume.interruptId);
  if (!interrupt) return;
  const { actions } = parseInterruptActions(interrupt.value);

  await Promise.all(
    actions.map(async (action, index) => {
      const decision = input.resume.decisions[index]?.decision;
      if (decision !== "approve" && decision !== "edit") return;
      const edit = decision === "edit" ? input.resume.decisions[index]! : undefined;
      // An edit invalidates quotes of the draft it replaced, so audit what ships.
      const args = edit ? edit.editedArgs : action.args;
      const { spans } = await deps.judge.audit(input.threadId, args);
      deps.verdicts.append({
        verdictId: `${input.resume.interruptId}#${index}`,
        threadId: input.threadId,
        runId: input.runId,
        interruptId: input.resume.interruptId,
        toolName: edit?.editedName ?? action.toolName,
        decision,
        // Citations are provenance, not content, and the spans already carry them.
        args: withoutGroundingArgument(args),
        spans,
      });
    }),
  );
}
