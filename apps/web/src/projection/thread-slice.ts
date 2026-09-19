/** Framework-free per-thread render state. */
import type { UIMessageLike } from "./adapter.js";
import type { UsageInfo } from "./messages.js";

export type StreamStatus = "idle" | "streaming" | "error" | "interrupted";

/**
 * The run completes with `success`, not `error` — this is informational, not
 * a failure — so it rides its own field rather than `errorText`.
 */
export const TRUNCATED_NOTICE = "Response was cut off (hit the token limit) — send a follow-up to continue.";

export interface DelegationInfo {
  delegationId: string;
  subagent: string;
  title?: string;
  status: "running" | "awaiting-input" | "completed" | "error";
  output?: unknown;
  errorText?: string;
  startedAt?: number;
  completedAt?: number;
  parentId?: string | null;
  depth?: number;
  /**
   * Delegations sharing a batch ID were dispatched in one turn. Timing is
   * batch-level, so the UI reports one group duration.
   */
  batchId?: string;
}

export interface ThreadSlice {
  messages: UIMessageLike[];
  delegations: Record<string, DelegationInfo>;
  status: StreamStatus;
  /**
   * Explicit undefined permits clearing under exactOptionalPropertyTypes.
   */
  runId?: string | undefined;
  /**
   * Human-readable text for the last failed run or hydration, surfaced to the
   * user. Explicit undefined permits clearing under exactOptionalPropertyTypes.
   */
  errorText?: string | undefined;
  /**
   * Coarse `ErrorCode` for the current error, used to pick actionable guidance
   * (e.g. AUTH_EXPIRED → check credentials). Undefined when there is no error.
   */
  errorCode?: string | undefined;
  attached: boolean;
  /**
   * Mid-run steering messages, oldest first. The store combines them into the
   * next user turn when the current run settles.
   */
  queued: string[];
  /**
   * Latest model-call context occupancy. Explicit undefined permits clearing
   * under exactOptionalPropertyTypes.
   */
  usage?: UsageInfo | undefined;
  /**
   * Set to {@link TRUNCATED_NOTICE} when the orchestrator's own turn ended at
   * the token limit with no visible text. Explicit undefined permits clearing
   * under exactOptionalPropertyTypes.
   */
  truncatedNotice?: string | undefined;
}
