/** Marks terminal model responses that stop at an output-token limit. */
import { AIMessage } from "@langchain/core/messages";
import { createMiddleware } from "langchain";

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
