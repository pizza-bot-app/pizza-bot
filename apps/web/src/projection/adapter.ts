/** Framework-free structural mirror of the UI message parts the frontend renders. */
import type { HitlDecision } from "@pizza-bot/core";

export interface UIMessageLike {
  id: string;
  role: "user" | "assistant" | "system";
  parts: UIPartLike[];
  /** Durable source ID used to navigate from full-text search results. */
  sourceMessageId?: string;
}

export type UIPartLike =
  | { type: "text"; text: string }
  | { type: "reasoning"; text: string }
  | { type: "file"; mediaType: string; url: string; filename?: string }
  | { type: "source-url"; url: string; title?: string }
  | {
      type: `tool-${string}`;
      toolCallId: string;
      state:
        | "input-streaming"
        | "input-available"
        | "output-available"
        | "output-error"
        | "approval-requested"
        | "approval-responded"
        | "output-denied";
      input?: unknown;
      output?: unknown;
      errorText?: string;
      /** Durable ToolMessage ID when its result is folded into this card. */
      resultMessageId?: string;
      allowedDecisions?: HitlDecision[];
      /**
       * DeepAgents resumes batched calls atomically, so one approval card carries
       * every gated action and one decision applies to the whole batch.
       */
      batch?: Array<{ toolName: string; args: unknown }>;
    };

/**
 * Branches require a completed assistant turn with no pending tool calls.
 * The server independently validates the same boundary.
 */
export function isForkableTurn(m: UIMessageLike): boolean {
  if (m.role !== "assistant") return false;
  return m.parts.every(
    (part) =>
      !("state" in part) ||
      part.state === "output-available" ||
      part.state === "output-error" ||
      part.state === "output-denied",
  );
}
