/** Runtime-neutral wire types and boundary-validation schemas. */
import { z } from "zod";

/**
 * Increment for breaking wire changes. Additive changes retain the current
 * version so clients can detect incompatibility before decoding responses.
 */
export const PROTOCOL_VERSION = 1 as const;

/**
 * The SDK `ThreadStream`/`StreamController` require a non-empty assistant
 * identifier. Pizza Bot serves one graph, so this is a fixed protocol constant,
 * not selectable state.
 */
export const ASSISTANT_ID = "pizza-bot" as const;

export interface NormalizedMessage {
  id: string;
  role: "user" | "assistant" | "system" | "tool";
  parts: MessagePart[];
  metadata?: Record<string, unknown>;
}

export type MessagePart =
  | { type: "text"; text: string }
  | { type: "reasoning"; text: string }
  | { type: "tool-call"; toolCallId: string; name: string; args: unknown }
  | {
      type: "tool-result";
      toolCallId: string;
      name: string;
      result: unknown;
      isError?: boolean;
    }
  | {
      type: "file";
      mediaType: string;
      /**
       * Uploaded files use checkpoint-safe `attachment://<id>` references; bytes
       * are resolved only at the model boundary. Foreign HTTP URLs are also valid.
       */
      url: string;
      name?: string;
      attachmentId?: string;
      sizeBytes?: number;
    }
  | { type: "source"; url: string; title?: string };

/**
 * Checkpoints may contain live LangChain-style messages or serialized `kwargs`
 * forms. Consumers narrow this permissive shape when hydrating.
 */
export interface SerializedMessage {
  id?: string | string[];
  getType?: () => string;
  content?: unknown;
  tool_calls?: unknown;
  tool_call_id?: string;
  status?: string;
  additional_kwargs?: Record<string, unknown>;
  kwargs?: Record<string, unknown>;
  [k: string]: unknown;
}

export interface ThreadStateValues {
  messages?: SerializedMessage[];
  [channel: string]: unknown;
}

export type HitlDecision = "approve" | "edit" | "reject" | "respond";

export interface InterruptPayload {
  interruptId: string;
  toolName: string;
  args: unknown;
  allowedDecisions: HitlDecision[];
  context?: Record<string, unknown>;
}

export interface ResumeCommand {
  interruptId: string;
  decisions: Array<{
    decision: HitlDecision;
    editedArgs?: unknown;
    /** Must match the interrupted tool name for `edit` decisions. */
    editedName?: string;
    message?: string;
  }>;
}

/**
 * Named codes drive standard recovery actions. The open string branch permits
 * runtime-specific codes without blocking protocol decoding.
 */
export type ErrorCode =
  | "AUTH_EXPIRED"
  | "TIMEOUT"
  | "RATE_LIMIT"
  | "CONTEXT_LENGTH"
  | "MODEL_UNAVAILABLE"
  | "STREAM_ERROR"
  | "GENERAL"
  | (string & {});

export const ERROR_CODES = [
  "AUTH_EXPIRED",
  "TIMEOUT",
  "RATE_LIMIT",
  "CONTEXT_LENGTH",
  "MODEL_UNAVAILABLE",
  "STREAM_ERROR",
  "GENERAL",
] as const;

export const runStatusSchema = z.enum([
  "pending",
  "running",
  "error",
  "success",
  "timeout",
  "interrupted",
  "cancelled",
]);
export type RunStatus = z.infer<typeof runStatusSchema>;

/** Narrow server response schema; boundary validation exposes contract drift. */
export const threadStateWireSchema = z.object({
  values: z.unknown(),
  next: z.array(z.string()),
  checkpoint_id: z.string(),
  thread_id: z.string(),
  created_at: z.string(),
  /** Optional for compatibility with servers that predate durable HITL state. */
  awaiting_input: z.boolean().optional(),
});
export type ThreadStateWire = z.infer<typeof threadStateWireSchema>;

export const updateStateWireSchema = z.object({
  checkpoint_id: z.string(),
  thread_id: z.string(),
});
export type UpdateStateWire = z.infer<typeof updateStateWireSchema>;
