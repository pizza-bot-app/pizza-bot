/** Two policies for a model reply that stops at the output-token limit: a notice the agent reads (subagents), a state flag the human sees (orchestrator). */
import { AIMessage, type BaseMessage } from "@langchain/core/messages";
import { createMiddleware } from "langchain";
import { z } from "zod";
import { TRUNCATED_TURN_CHANNEL } from "@pizza-bot/core";

export const OUTPUT_TRUNCATION_NOTICE =
  "\n\n[OUTPUT_TRUNCATED: This task result is incomplete because the worker " +
  "reached its output-token limit. Continue with another task call.]";

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

export function outputTruncationMiddleware() {
  return createMiddleware({
    name: "outputTruncation",
    wrapModelCall: async (request, handler) => {
      const response = await handler(request);
      if (!reachedOutputLimit(response) || response.tool_calls?.length) {
        return response;
      }
      return markTruncated(response);
    },
  });
}

const truncatedTurnState = z.object({
  [TRUNCATED_TURN_CHANNEL]: z.boolean().optional(),
});

/**
 * Graph state rather than a synthesized protocol frame: the next `values`
 * snapshot replaces the whole client state, erasing anything that is not
 * state. Reset at run start so a run that never completes a model call
 * (stopped, or the model-call ceiling already spent) cannot inherit the flag.
 */
export function truncatedTurnMiddleware() {
  return createMiddleware({
    name: "truncatedTurn",
    stateSchema: truncatedTurnState,
    beforeAgent: () => ({ [TRUNCATED_TURN_CHANNEL]: false }),
    afterModel: (state) => ({
      [TRUNCATED_TURN_CHANNEL]: isTruncatedTurn(state.messages.at(-1)),
    }),
  });
}

export function isTruncatedTurn(message: BaseMessage | undefined): boolean {
  if (!message || !AIMessage.isInstance(message)) return false;
  // A length-limited tool call still routes to the tool; only a turn with no
  // visible reply and nothing to execute leaves the user with a blank turn.
  if (message.tool_calls?.length) return false;
  return reachedOutputLimit(message) && !hasVisibleText(message);
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
