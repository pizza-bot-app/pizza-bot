/** Two policies for a model reply that stops at the output-token limit: a notice the agent reads (subagents), and for the orchestrator a silent retry of a cut-off tool call plus a state flag the human sees. */
import { AIMessage, RemoveMessage, type BaseMessage } from "@langchain/core/messages";
import { createMiddleware } from "langchain";
import { z } from "zod";
import { TRUNCATED_TURN_CHANNEL } from "@pizza-bot/core";

export const OUTPUT_TRUNCATION_NOTICE =
  "\n\n[OUTPUT_TRUNCATED: This task result is incomplete because the worker " +
  "reached its output-token limit. Continue with another task call.]";

export const MAX_CUT_OFF_RETRIES = 2;

export function toolCallCutOffInstruction(toolNames: readonly string[]): string {
  const calls = toolNames.map((name) => `\`${name}\``).join(", ");
  return (
    `Your previous reply was cut off at the output-token limit while writing a ${calls} ` +
    "call, so that call was discarded and did not run. Make the same change with " +
    "smaller tool calls, for example by splitting it across several calls. Do not " +
    "mention the interruption to the user."
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
const REASON_KEYS = [
  "finish_reason",
  "finishReason",
  "stop_reason",
  "stopReason",
] as const;

function reachedOutputLimit(message: AIMessage): boolean {
  for (const key of REASON_KEYS) {
    const value = message.response_metadata[key];
    if (typeof value !== "string") continue;
    const normalized = value.trim().toLowerCase().replaceAll("-", "_");
    if (OUTPUT_LIMIT_REASONS.has(normalized)) return true;
  }
  return false;
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

const truncatedTurnState = z.object({
  [TRUNCATED_TURN_CHANNEL]: z.boolean().optional(),
  cutOffRetries: z.number().optional(),
  cutOffToolCalls: z.array(z.string()).optional(),
});

/**
 * Graph state rather than a synthesized protocol frame: the next `values`
 * snapshot replaces the whole client state, erasing anything that is not
 * state. Reset at run start so a run that never completes a model call
 * (stopped, or the model-call ceiling already spent) cannot inherit the flag.
 * A cut-off tool call never ran, so the turn is removed and the model asked
 * again with a hidden instruction; only past the retry cap does the human see it.
 */
export function truncatedTurnMiddleware() {
  return createMiddleware({
    name: "truncatedTurn",
    stateSchema: truncatedTurnState,
    beforeAgent: () => ({ [TRUNCATED_TURN_CHANNEL]: false, cutOffRetries: 0, cutOffToolCalls: [] }),
    wrapModelCall: (request, handler) => {
      const names = request.state.cutOffToolCalls;
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
            cutOffToolCalls: cutOffToolCallNames(last),
            [TRUNCATED_TURN_CHANNEL]: false,
            jumpTo: "model",
          };
        }
        return { [TRUNCATED_TURN_CHANNEL]: isTruncatedTurn(last), cutOffToolCalls: [] };
      },
    },
  });
}

export function isTruncatedTurn(message: BaseMessage | undefined): boolean {
  if (!message || !AIMessage.isInstance(message)) return false;
  // A length-limited tool call still routes to the tool. The user needs the
  // banner when nothing visible arrived, or when the cut-off call never ran.
  if (message.tool_calls?.length) return false;
  return reachedOutputLimit(message) && (!hasVisibleText(message) || hasCutOffToolCall(message));
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
