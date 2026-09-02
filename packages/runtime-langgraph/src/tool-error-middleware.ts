/** Converts thrown tool failures into model-visible error ToolMessages. */
import { createMiddleware, ToolInvocationError } from "langchain";
import { ToolMessage } from "@langchain/core/messages";
import { isGraphInterrupt } from "@langchain/langgraph";
import { classifyError } from "@pizza-bot/core";

const RATE_LIMIT_GUIDANCE =
  "The tool's source is rate-limited. Retry this tool at most once. If it is " +
  "still unavailable, stop using this source for this run and return verified " +
  "partial results with a clear coverage disclaimer.";

/**
 * Deliberately does not blame the arguments: a tool fails just as often on
 * credentials or configuration, and telling the model to fix arguments that were
 * already correct sends it into identical retries.
 */
const FAILURE_GUIDANCE =
  "If the error names something to fix — arguments, credentials, or configuration " +
  "— apply it and try again. Otherwise stop calling this tool for this run and " +
  "tell the user what failed and what would unblock it.";

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
        const guidance =
          toolErrorCode(err) === "RATE_LIMIT" ? RATE_LIMIT_GUIDANCE : FAILURE_GUIDANCE;
        return new ToolMessage({
          status: "error",
          content: `Error running tool "${name}": ${detail}\n${guidance}`,
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

function toolErrorCode(error: unknown) {
  let current = error;
  const seen = new Set<unknown>();
  while (current && typeof current === "object" && !seen.has(current)) {
    seen.add(current);
    if (classifyError(current) === "RATE_LIMIT" || httpStatusOf(current) === 429) {
      return "RATE_LIMIT";
    }
    current =
      current instanceof ToolInvocationError
        ? current.toolError
        : (current as { cause?: unknown }).cause;
  }
  return classifyError(toolErrorDetail(error));
}

function httpStatusOf(error: object): number | undefined {
  const value = error as { status?: unknown; statusCode?: unknown };
  const status = value.status ?? value.statusCode;
  return typeof status === "number" ? status : undefined;
}
