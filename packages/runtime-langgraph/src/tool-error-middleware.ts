/** Converts thrown tool failures into model-visible error ToolMessages. */
import { createMiddleware, ToolInvocationError } from "langchain";
import { ToolMessage } from "@langchain/core/messages";
import { isGraphInterrupt } from "@langchain/langgraph";

/**
 * In langchain@1.5.2/deepagents@1.12.1, inner wrappers turn tool failures into
 * `MiddlewareError`, which @langchain/langgraph@1.4.7 rethrows instead of handing
 * to the model. This outer wrapper preserves tool-result parity and self-recovery.
 * GraphInterrupt remains control flow and must escape. Revalidate on upgrades
 * because LangGraph's error path has changed upstream.
 */
export function toolErrorRecoveryMiddleware() {
  return createMiddleware({
    name: "toolErrorRecovery",
    wrapToolCall: async (request, handler) => {
      try {
        return await handler(request);
      } catch (err) {
        // Swallowing GraphInterrupt would prevent HITL from pausing the run.
        if (isGraphInterrupt(err)) throw err;
        const { id, name } = request.toolCall;
        const detail = toolErrorDetail(err);
        return new ToolMessage({
          status: "error",
          content: `Error running tool "${name}": ${detail}\nPlease fix the arguments and try again.`,
          tool_call_id: id ?? "",
          name,
        });
      }
    },
  });
}

function toolErrorDetail(error: unknown): string {
  let current = error;
  const seen = new Set<unknown>();
  while (current instanceof Error && !seen.has(current)) {
    if (current instanceof ToolInvocationError) return current.toolError.message;
    seen.add(current);
    current = current.cause;
  }
  return error instanceof Error ? error.message : String(error);
}
