/** Reserves a worker's last model call for a useful, tool-free response. */
import {
  AIMessage,
  HumanMessage,
  ToolMessage,
  type BaseMessage,
} from "@langchain/core/messages";
import { createMiddleware } from "langchain";
import { z } from "zod";

export const SUBAGENT_FINALIZATION_INSTRUCTION =
  "This is the final model call available for this delegated task. " +
  "Do not call tools. Return the most useful answer supported by results already " +
  "in the conversation. Clearly disclose unavailable sources, failed searches, " +
  "uncertainty, and incomplete coverage. Do not return only a call-limit notice.";

export const SUBAGENT_MODEL_CALL_COUNT = "runSubagentModelCallCount";

const stateSchema = z.object({
  [SUBAGENT_MODEL_CALL_COUNT]: z.number().default(0),
});

export function subagentFinalizationMiddleware(runLimit: number) {
  if (!Number.isInteger(runLimit) || runLimit < 1) {
    throw new Error("Subagent finalization requires a positive integer run limit.");
  }

  return createMiddleware({
    name: "subagentFinalization",
    stateSchema,
    wrapModelCall: async (request, handler) => {
      if (request.state[SUBAGENT_MODEL_CALL_COUNT] !== runLimit - 1) {
        return handler(request);
      }
      return handler({
        ...request,
        messages: toolHistoryAsText(request.messages),
        tools: [],
        systemMessage: request.systemMessage.concat(SUBAGENT_FINALIZATION_INSTRUCTION),
      });
    },
    afterModel: (state) => ({
      [SUBAGENT_MODEL_CALL_COUNT]: state[SUBAGENT_MODEL_CALL_COUNT] + 1,
    }),
    afterAgent: () => ({
      [SUBAGENT_MODEL_CALL_COUNT]: 0,
    }),
  });
}

function toolHistoryAsText(messages: BaseMessage[]): BaseMessage[] {
  const converted: BaseMessage[] = [];
  let toolResults: string[] = [];

  const flushToolResults = () => {
    if (toolResults.length === 0) return;
    converted.push(new HumanMessage(toolResults.join("\n\n")));
    toolResults = [];
  };

  for (const message of messages) {
    if (ToolMessage.isInstance(message)) {
      const content = message.text.trim() || JSON.stringify(message.content);
      toolResults.push(`Tool result from "${message.name ?? "unknown"}":\n${content}`);
      continue;
    }

    flushToolResults();
    if (AIMessage.isInstance(message) && hasToolProtocol(message)) {
      converted.push(new AIMessage(
        message.text.trim() || "Tool calls completed; results follow.",
      ));
      continue;
    }
    converted.push(message);
  }

  flushToolResults();
  return converted;
}

function hasToolProtocol(message: AIMessage): boolean {
  if (message.tool_calls?.length) return true;
  return Array.isArray(message.content) && message.content.some(
    (block) =>
      typeof block === "object" &&
      block !== null &&
      "type" in block &&
      (block.type === "tool_call" || block.type === "tool_use"),
  );
}
