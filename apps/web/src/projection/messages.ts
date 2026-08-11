/** Pure checkpoint and stream projections into UI message parts. */
import type { HitlDecision, ResumeCommand } from "@pizza-bot/core";
import type { UIMessageLike, UIPartLike } from "./adapter.js";

export function buildResumeCommand(
  interruptId: string,
  decision: HitlDecision,
  editedArgs?: unknown,
  editedName?: string,
  message?: string,
): ResumeCommand {
  return {
    interruptId,
    decisions: [
      decision === "edit"
        ? {
            decision,
            editedArgs,
            ...(editedName !== undefined ? { editedName } : {}),
          }
        : // Reject reasons and stand-in responses are returned to the model.
          { decision, ...(message ? { message } : {}) },
    ],
  };
}

export interface InterruptAction {
  toolName: string;
  args: unknown;
}

/**
 * Normalizes DeepAgents' batched `actionRequests` shape. Batched actions share
 * the first review config and resume atomically.
 */
export function parseInterruptActions(value: unknown): {
  actions: InterruptAction[];
  allowedDecisions: HitlDecision[];
} {
  const v = (value ?? {}) as Record<string, unknown>;
  const rawActions = Array.isArray(v.actionRequests) ? v.actionRequests : [];
  const reviewConfigs = Array.isArray(v.reviewConfigs) ? v.reviewConfigs : [];
  const review = (reviewConfigs[0] ?? {}) as { allowedDecisions?: unknown };
  const fallback = (v.action ?? v) as Record<string, unknown>;

  const actions: InterruptAction[] =
    rawActions.length > 0
      ? rawActions.map((a) => {
          const action = (a ?? {}) as { name?: string; args?: unknown };
          return { toolName: String(action.name ?? "unknown"), args: action.args ?? {} };
        })
      : // Also accept a direct single-action interrupt payload.
        [
          {
            toolName: String(fallback.name ?? fallback.tool ?? "unknown"),
            args: fallback.args ?? fallback.input ?? {},
          },
        ];

  const allowedDecisions: HitlDecision[] = Array.isArray(review.allowedDecisions)
    ? (review.allowedDecisions as HitlDecision[])
    : Array.isArray(v.allowedDecisions)
      ? (v.allowedDecisions as HitlDecision[])
      : ["approve", "edit", "reject"];

  return { actions, allowedDecisions };
}

/**
 * Emits one identical decision per gated call. DeepAgents rejects resume
 * commands whose decision count differs from `actionRequests.length`.
 */
export function buildBatchResumeCommand(
  interruptId: string,
  decision: HitlDecision,
  count: number,
  editedArgs?: unknown,
  editedName?: string,
  message?: string,
): ResumeCommand {
  const one = buildResumeCommand(interruptId, decision, editedArgs, editedName, message).decisions[0]!;
  return { interruptId, decisions: Array.from({ length: Math.max(1, count) }, () => ({ ...one })) };
}

interface RawToolCall {
  id?: string;
  name?: string;
  args?: unknown;
}

/**
 * Supports both LangChain reasoning block formats: `reasoning_content` and
 * `reasoning`.
 */
interface RawReasoningBlock {
  type: "reasoning_content" | "reasoning";
  reasoningText?: { text?: string; signature?: string };
  reasoning?: string;
}

export interface RawMessage {
  id?: string | string[];
  getType?: () => string;
  content?: string | Array<{ type?: string; text?: string; reasoningText?: { text?: string } }>;
  tool_calls?: RawToolCall[];
  tool_call_id?: string;
  name?: string;
  status?: string;
  additional_kwargs?: { usage?: RawUsage };
  /**
   * The latest AI message's input tokens represent current prompt occupancy,
   * because each call includes the full context.
   */
  usage_metadata?: RawUsage;
  kwargs?: {
    content?: unknown;
    id?: unknown;
    tool_calls?: RawToolCall[];
    tool_call_id?: string;
    name?: string;
    status?: string;
    additional_kwargs?: { usage?: RawUsage };
    usage_metadata?: RawUsage;
  };
}

interface RawUsage {
  input_tokens?: number;
  output_tokens?: number;
  total_tokens?: number;
}

function rawText(m: RawMessage): string {
  const content = m.content ?? (m.kwargs?.content as RawMessage["content"]);
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((c) => (c && typeof c === "object" && "text" in c ? String(c.text ?? "") : "")).join("");
}

/**
 * Extracts visible reasoning without mixing it into answer text. Signature-only
 * blocks and unknown formats contribute no text.
 */
function rawReasoning(m: RawMessage): string {
  const content = m.content ?? (m.kwargs?.content as RawMessage["content"]);
  if (!Array.isArray(content)) return "";
  return content
    .map((c) => {
      if (!c || typeof c !== "object") return "";
      const b = c as RawReasoningBlock;
      if (b.type === "reasoning_content") return String(b.reasoningText?.text ?? "");
      if (b.type === "reasoning") return String(b.reasoning ?? "");
      return "";
    })
    .join("");
}

interface RawFileBlock {
  type?: string;
  url?: string;
  mimeType?: string;
  mime_type?: string;
  name?: string;
  filename?: string;
}

/**
 * Emits only checkpoint-safe file references. Model-boundary base64 blocks are
 * never persisted and therefore cannot be hydrated.
 */
function rawFileParts(m: RawMessage): UIPartLike[] {
  const content = m.content ?? (m.kwargs?.content as RawMessage["content"]);
  if (!Array.isArray(content)) return [];
  const parts: UIPartLike[] = [];
  for (const c of content as RawFileBlock[]) {
    if (c && typeof c === "object" && c.type === "file" && typeof c.url === "string") {
      parts.push({
        type: "file",
        url: c.url,
        mediaType: c.mimeType ?? c.mime_type ?? "application/octet-stream",
        ...(c.name || c.filename ? { filename: c.name ?? c.filename } : {}),
      });
    }
  }
  return parts;
}

function rawType(m: RawMessage): string {
  if (typeof m.getType === "function") return m.getType();
  // Serialized messages store the class name at the end of the ID path.
  return Array.isArray(m.id) ? (m.id[m.id.length - 1] ?? "") : "";
}

function rawRole(m: RawMessage): "user" | "assistant" {
  const t = rawType(m);
  return t === "human" || t === "HumanMessage" ? "user" : "assistant";
}

function rawToolCalls(m: RawMessage): RawToolCall[] {
  return m.tool_calls ?? m.kwargs?.tool_calls ?? [];
}

function rawToolCallId(m: RawMessage): string | undefined {
  return m.tool_call_id ?? m.kwargs?.tool_call_id;
}

function rawMessageId(m: RawMessage, fallback?: string): string | undefined {
  if (typeof m.id === "string") return m.id;
  if (typeof m.kwargs?.id === "string") return m.kwargs.id;
  return fallback;
}

function rawIsError(m: RawMessage): boolean {
  return (m.status ?? m.kwargs?.status) === "error";
}

/**
 * Hydrated IDs encode raw history indices because tool results and empty turns
 * collapse out of the feed. Fork boundaries must use the raw index.
 */
export function hydratedMessageId(rawIndex: number): string {
  return `h_${rawIndex}`;
}

export function rawIndexOf(messageId: string): number | null {
  const m = /^h_(\d+)$/.exec(messageId);
  return m ? Number(m[1]) : null;
}

export function messagesToUI(raw: RawMessage[], fallbackIdPrefix?: string): UIMessageLike[] {
  const out: UIMessageLike[] = [];
  // Tool results update their originating cards even across intervening messages.
  const toolParts = new Map<string, ToolUIPart>();

  raw.forEach((m, i) => {
    const sourceMessageId = rawMessageId(
      m,
      fallbackIdPrefix ? `${fallbackIdPrefix}:${i}` : undefined,
    );
    const toolCallId = rawToolCallId(m);
    if (toolCallId) {
      // Orphan results are dropped instead of rendered as raw text.
      const part = toolParts.get(toolCallId);
      if (part) {
        const result = rawText(m);
        const isError = rawIsError(m);
        part.state = isError ? "output-error" : "output-available";
        part.output = result;
        if (isError) part.errorText = result;
        if (sourceMessageId) part.resultMessageId = sourceMessageId;
      }
      return;
    }

    const parts: UIPartLike[] = [];
    const reasoning = rawReasoning(m).trim();
    if (reasoning.length > 0) parts.push({ type: "reasoning", text: reasoning });
    const text = rawText(m).trim();
    if (text.length > 0) parts.push({ type: "text", text });
    parts.push(...rawFileParts(m));

    for (const tc of rawToolCalls(m)) {
      if (!tc.id || !tc.name) continue;
      const part: ToolUIPart = {
        type: `tool-${tc.name}`,
        toolCallId: tc.id,
        state: "input-available",
        input: tc.args ?? {},
      };
      toolParts.set(tc.id, part);
      parts.push(part);
    }

    if (parts.length > 0) {
      out.push({
        id: hydratedMessageId(i),
        role: rawRole(m),
        parts,
        ...(sourceMessageId ? { sourceMessageId } : {}),
      });
    }
  });
  return out;
}

function isOpenToolPart(p: UIPartLike): p is ToolUIPart {
  return isToolPart(p) && (p.state === "input-available" || p.state === "input-streaming");
}

/**
 * Marks unfinished tool calls as failed after a run ends. HITL approval cards
 * remain pending. Returns the original array when no card changes.
 */
export function sealOpenToolCalls(
  messages: UIMessageLike[],
  errorText = "Run ended before this tool finished.",
): UIMessageLike[] {
  let changed = false;
  const next = messages.map((m) => {
    if (!m.parts.some(isOpenToolPart)) return m;
    changed = true;
    return {
      ...m,
      parts: m.parts.map((p) =>
        isOpenToolPart(p) ? { ...p, state: "output-error" as const, errorText } : p,
      ),
    };
  });
  return changed ? next : messages;
}

export interface UsageInfo {
  input: number;
  output: number;
}

// A live-streamed assistant message carries token counts under
// `additional_kwargs.usage` (the SDK never populates `usage_metadata` mid-stream);
// only a hydrated-from-checkpoint message uses `usage_metadata`. Read both so the
// gauge survives both paths.
function rawUsage(m: RawMessage): RawUsage | undefined {
  return (
    m.usage_metadata ??
    m.kwargs?.usage_metadata ??
    m.additional_kwargs?.usage ??
    m.kwargs?.additional_kwargs?.usage
  );
}

/**
 * Uses the latest reported usage because each input count already includes the
 * full prompt history. Summing calls would overcount context occupancy.
 */
export function usageFromMessages(raw: RawMessage[]): UsageInfo | undefined {
  for (let i = raw.length - 1; i >= 0; i--) {
    const u = rawUsage(raw[i]!);
    if (u && (typeof u.input_tokens === "number" || typeof u.output_tokens === "number")) {
      return { input: u.input_tokens ?? 0, output: u.output_tokens ?? 0 };
    }
  }
  return undefined;
}

type ToolUIPart = Extract<UIPartLike, { type: `tool-${string}` }>;
const isToolPart = (p: UIPartLike): p is ToolUIPart => p.type.startsWith("tool-") && "toolCallId" in p;

/**
 * Replaces open tool cards with one approval card because DeepAgents resumes a
 * batch atomically. If no open card exists, appends a synthetic assistant turn.
 */
export function overlayInterrupt(
  messages: UIMessageLike[],
  interruptId: string,
  actions: InterruptAction[],
  allowedDecisions: HitlDecision[],
): UIMessageLike[] {
  if (actions.length === 0) return messages;
  const isBatch = actions.length > 1;
  const first = actions[0]!;
  const card: UIPartLike = {
    type: `tool-${first.toolName}`,
    toolCallId: interruptId,
    state: "approval-requested",
    input: first.args,
    allowedDecisions,
    ...(isBatch ? { batch: actions.map((a) => ({ toolName: a.toolName, args: a.args })) } : {}),
  };

  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    if (m.role !== "assistant") continue;
    if (!m.parts.some((p) => isToolPart(p) && (p.state === "input-available" || p.state === "input-streaming"))) {
      // A trailing text-only turn must not absorb an earlier interrupt.
      continue;
    }
    let placed = false;
    const nextParts: UIPartLike[] = [];
    for (const p of m.parts) {
      const open = isToolPart(p) && (p.state === "input-available" || p.state === "input-streaming");
      if (!open) {
        nextParts.push(p);
        continue;
      }
      if (!placed) {
        nextParts.push(card);
        placed = true;
      }
    }
    const next = messages.slice();
    next[i] = { ...m, parts: nextParts };
    return next;
  }
  return [...messages, { id: "a_interrupt", role: "assistant", parts: [card] }];
}
