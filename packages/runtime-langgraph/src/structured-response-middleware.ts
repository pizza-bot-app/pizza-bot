/** Gets a subagent's structured response without forced tool choice, which Claude 5.5 models reject. */
import { AIMessage, HumanMessage } from "@langchain/core/messages";
import { createMiddleware } from "langchain";

export const RESPONSE_TOOL_NAME = "final_response";
const RESPONSE_SCHEMA_DESCRIPTION = "Return the final result in this shape.";
export const RESPONSE_TOOL_INSTRUCTION =
  `When your work is done, return the result by calling the \`${RESPONSE_TOOL_NAME}\` ` +
  "tool instead of replying in text.";
export const RESPONSE_TOOL_REMINDER =
  `Return that result now by calling the \`${RESPONSE_TOOL_NAME}\` tool.`;

/**
 * LangChain names the structured-output tool from a plain JSON Schema's `title`
 * and describes it from its `description` (default ""); providers reject an
 * empty description or a name with spaces, and the reminder needs a fixed name.
 */
export function asResponseFormat(schema: Record<string, unknown>): Record<string, unknown> {
  const { description } = schema;
  return {
    ...schema,
    title: RESPONSE_TOOL_NAME,
    description:
      typeof description === "string" && description.trim()
        ? description
        : RESPONSE_SCHEMA_DESCRIPTION,
  };
}

export function structuredResponseMiddleware() {
  return createMiddleware({
    name: "structuredResponse",
    wrapModelCall: async (request, handler) => {
      if (!request.responseFormat || usesNativeStructuredOutput(request.model)) {
        return handler(request);
      }
      const autoRequest = {
        ...request,
        toolChoice: "auto" as const,
        systemMessage: request.systemMessage.concat(RESPONSE_TOOL_INSTRUCTION),
      };
      const response: unknown = await handler(autoRequest);
      // A parsed response comes back as a state update, not an AIMessage; only
      // a tool-free prose answer missed the response tool. It gets one reminder,
      // which call limits don't count, and then LangChain's own handling.
      if (!AIMessage.isInstance(response) || response.tool_calls?.length) {
        return response as AIMessage;
      }
      return handler({
        ...autoRequest,
        messages: [...request.messages, response, new HumanMessage(RESPONSE_TOOL_REMINDER)],
      });
    },
  });
}

/** Mirrors LangChain's unexported `hasSupportForJsonSchemaOutput`: these models get no response tool. */
function usesNativeStructuredOutput(model: unknown): boolean {
  if (typeof model !== "object" || model === null || !("profile" in model)) return false;
  const { profile } = model as { profile?: { structuredOutput?: unknown } };
  return profile?.structuredOutput === true;
}
