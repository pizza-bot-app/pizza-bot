/** Two policies for a model reply that stops at the output-token limit: a notice the agent reads (subagents), and for the orchestrator a silent retry of a cut-off tool call plus a state flag the human sees, which also covers a reply the content filter blanked. */
import { AIMessage, RemoveMessage, type BaseMessage } from "@langchain/core/messages";
import { createMiddleware } from "langchain";
import { z } from "zod";
import { BLANK_TURN_CHANNEL, CUT_OFF_TOOL_CALLS_CHANNEL, type BlankTurnReason } from "@pizza-bot/core";

export const OUTPUT_TRUNCATION_NOTICE =
  "\n\n[OUTPUT_TRUNCATED: This task result is incomplete because the worker " +
  "reached its output-token limit. Continue with another task call.]";

export const MAX_CUT_OFF_RETRIES = 2;

export function toolCallCutOffInstruction(toolNames: readonly string[]): string {
  const calls = [...new Set(toolNames)].map((name) => `\`${name}\``).join(", ");
  return (
    `Your previous reply was cut off at the output-token limit while writing a ${calls} ` +
    "call, so that call was discarded and did not run. Make the same change with " +
    "smaller tool calls, for example by splitting it across several calls."
  );
}

const OUTPUT_LIMIT_REASONS = new Set([
  "length",
  "max_token",
  "max_tokens",
  "max_output_token",
  "max_output_tokens",
  "token_limit",
]);
// Spellings across providers: Bedrock `content_filtered`/`guardrail_intervened`,
// Anthropic `refusal`, OpenAI `content_filter`, Google `SAFETY`.
const CONTENT_FILTER_REASONS = new Set([
  "content_filter",
  "content_filtered",
  "guardrail_intervened",
  "refusal",
  "safety",
]);
const REASON_KEYS = [
  "finish_reason",
  "finishReason",
  "stop_reason",
  "stopReason",
] as const;

function stopReasons(message: AIMessage): string[] {
  return REASON_KEYS.flatMap((key) => {
    const value = message.response_metadata[key];
    return typeof value === "string" ? [value.trim().toLowerCase().replaceAll("-", "_")] : [];
  });
}

function reachedOutputLimit(message: AIMessage): boolean {
  return stopReasons(message).some((reason) => OUTPUT_LIMIT_REASONS.has(reason));
}

function contentFiltered(message: AIMessage): boolean {
  return stopReasons(message).some((reason) => CONTENT_FILTER_REASONS.has(reason));
}

function markTruncated(message: AIMessage): AIMessage {
  const content =
    typeof message.content === "string"
      ? message.content + OUTPUT_TRUNCATION_NOTICE
      : [
          ...message.content,
          { type: "text" as const, text: OUTPUT_TRUNCATION_NOTICE },
        ];
  const marked = Object.create(Object.getPrototypeOf(message)) as AIMessage;
  return Object.assign(marked, message, { content });
}

/** Names of tool calls whose arguments were cut off, from content blocks or the message field. */
function cutOffToolCallNames(message: AIMessage): string[] {
  const fromContent = Array.isArray(message.content)
    ? message.content.filter(
        (block) => typeof block === "object" && block !== null && block.type === "invalid_tool_call",
      )
    : [];
  const calls = [...fromContent, ...(message.invalid_tool_calls ?? [])] as Array<{ id?: unknown; name?: unknown }>;
  const named = calls.filter(
    (call, index) => calls.findIndex((other) => other.id === call.id && other.name === call.name) === index,
  );
  return named.map((call) => (typeof call.name === "string" && call.name ? call.name : "tool"));
}

function hasCutOffToolCall(message: AIMessage): boolean {
  return reachedOutputLimit(message) && !message.tool_calls?.length && cutOffToolCallNames(message).length > 0;
}

export function outputTruncationMiddleware() {
  return createMiddleware({
    name: "outputTruncation",
    wrapModelCall: async (request, handler) => {
      const response: unknown = await handler(request);
      // Under a response format the handler can also return a parsed
      // `{ structuredResponse, messages }` update, which has nothing to truncate.
      if (!AIMessage.isInstance(response)) return response as AIMessage;
      if (!reachedOutputLimit(response) || response.tool_calls?.length) {
        return response;
      }
      return markTruncated(response);
    },
  });
}

const blankTurnState = z.object({
  [BLANK_TURN_CHANNEL]: z.enum(["length", "content_filter"]).nullable().optional(),
  cutOffRetries: z.number().optional(),
  [CUT_OFF_TOOL_CALLS_CHANNEL]: z.array(z.string()).optional(),
});

/**
 * Graph state rather than a synthesized protocol frame: the next `values`
 * snapshot replaces the whole client state, erasing anything that is not
 * state. Reset at run start so a run that never completes a model call
 * (stopped, or the model-call ceiling already spent) cannot inherit the flag.
 * A cut-off tool call never ran, so the turn is removed and the model asked
 * again with a hidden instruction; the web shows a retry status meanwhile, and
 * only past the retry cap does the human get the banner.
 */
export function blankTurnMiddleware() {
  return createMiddleware({
    name: "blankTurn",
    stateSchema: blankTurnState,
    beforeAgent: () => ({ [BLANK_TURN_CHANNEL]: null, cutOffRetries: 0, [CUT_OFF_TOOL_CALLS_CHANNEL]: [] }),
    wrapModelCall: (request, handler) => {
      const names = request.state[CUT_OFF_TOOL_CALLS_CHANNEL];
      if (!names?.length) return handler(request);
      return handler({
        ...request,
        systemMessage: request.systemMessage.concat(toolCallCutOffInstruction(names)),
      });
    },
    afterModel: {
      canJumpTo: ["model"],
      hook: (state) => {
        const last = state.messages.at(-1);
        const retries = state.cutOffRetries ?? 0;
        if (AIMessage.isInstance(last) && last.id && hasCutOffToolCall(last) && retries < MAX_CUT_OFF_RETRIES) {
          return {
            messages: [new RemoveMessage({ id: last.id })],
            cutOffRetries: retries + 1,
            [CUT_OFF_TOOL_CALLS_CHANNEL]: cutOffToolCallNames(last),
            [BLANK_TURN_CHANNEL]: null,
            jumpTo: "model",
          };
        }
        return { [BLANK_TURN_CHANNEL]: blankTurnReason(last), [CUT_OFF_TOOL_CALLS_CHANNEL]: [] };
      },
    },
  });
}

export function blankTurnReason(message: BaseMessage | undefined): BlankTurnReason | null {
  if (!message || !AIMessage.isInstance(message)) return null;
  // A stopped tool call still routes to the tool. The user needs the banner
  // when nothing visible arrived, or when a cut-off call never ran.
  if (message.tool_calls?.length) return null;
  if (reachedOutputLimit(message) && (!hasVisibleText(message) || hasCutOffToolCall(message))) return "length";
  if (contentFiltered(message) && !hasVisibleText(message)) return "content_filter";
  return null;
}

function hasVisibleText(message: AIMessage): boolean {
  if (typeof message.content === "string") return message.content.trim().length > 0;
  return message.content.some(
    (block) =>
      typeof block === "object" &&
      block !== null &&
      block.type === "text" &&
      typeof block.text === "string" &&
      block.text.trim().length > 0,
  );
}
