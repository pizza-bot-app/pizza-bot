/**
 * Records the tool outputs a grounded skill may cite and hands the model each one as
 * numbered lines under its evidence id — the only way it learns what to cite. The ledger
 * stores that numbered text, so a cited line means the same bytes to model and reviewer.
 */
import { ToolMessage } from "@langchain/core/messages";
import { createMiddleware } from "langchain";
import {
  clipEvidenceBody,
  numberEvidenceLines,
  MAX_EVIDENCE_BODY_BYTES,
  type EvidenceRecorder,
  type Logger,
} from "@pizza-bot/core";

export interface EvidenceLedgerOptions {
  recorder: EvidenceRecorder;
  /** Executable tool name (`<server>__<tool>`) to its qualified `mcp:` ref. */
  refsByToolName: ReadonlyMap<string, string>;
  /**
   * Executable names of the tools an approval gates. Those are the actions under
   * review; everything else the skill calls is the research behind them.
   */
  gatedToolNames: ReadonlySet<string>;
  maxBodyBytes?: number;
  logger?: Logger;
}

export function evidenceMarker(
  id: string,
  clip: { bytes: number; truncated: boolean },
): string {
  return clip.truncated
    ? `[evidence ${id} — clipped to ${MAX_EVIDENCE_BODY_BYTES} of ${clip.bytes} bytes]`
    : `[evidence ${id}]`;
}

const MAX_BREADCRUMB_VALUE_CHARS = 60;

/** Names the call a reviewer is looking at, not its whole argument object. */
export function evidenceBreadcrumb(toolRef: string, args: unknown): string {
  if (typeof args !== "object" || args === null) return toolRef;
  const parts: string[] = [];
  for (const [key, value] of Object.entries(args)) {
    if (parts.length === 2) break;
    if (typeof value !== "string" && typeof value !== "number") continue;
    const rendered = String(value);
    parts.push(
      `${key}: ${
        rendered.length > MAX_BREADCRUMB_VALUE_CHARS
          ? `${rendered.slice(0, MAX_BREADCRUMB_VALUE_CHARS - 1)}…`
          : rendered
      }`,
    );
  }
  return parts.length > 0 ? `${toolRef} (${parts.join(", ")})` : toolRef;
}

/** The numbered text replaces the result's text; anything else it carried (an image) stays. */
function stampedContent(message: ToolMessage, stamped: string): ToolMessage["content"] {
  if (typeof message.content === "string") return stamped;
  const rest = message.content.filter((part) => part.type !== "text");
  return rest.length === 0 ? stamped : [{ type: "text" as const, text: stamped }, ...rest];
}

function withNumberedLines(message: ToolMessage, stamped: string): ToolMessage {
  const copy = Object.create(Object.getPrototypeOf(message)) as ToolMessage;
  return Object.assign(copy, message, { content: stampedContent(message, stamped) });
}

export function evidenceLedgerMiddleware(options: EvidenceLedgerOptions) {
  const maxBodyBytes = options.maxBodyBytes ?? MAX_EVIDENCE_BODY_BYTES;

  return createMiddleware({
    name: "evidenceLedger",
    wrapToolCall: async (request, handler) => {
      const result = await handler(request);
      const name = request.toolCall.name;
      const toolRef = options.refsByToolName.get(name);
      if (!toolRef || options.gatedToolNames.has(name)) return result;
      if (!ToolMessage.isInstance(result) || result.status === "error") return result;

      const threadId = request.runtime.configurable?.thread_id;
      if (typeof threadId !== "string" || !threadId) return result;
      const runId = request.runtime.configurable?.run_id;

      const text = result.text.trim() || JSON.stringify(result.content);
      if (!text) return result;
      const clip = clipEvidenceBody(text, maxBodyBytes);
      const numbered = numberEvidenceLines(clip.body);
      if (!numbered) return result;

      try {
        const entry = await options.recorder({
          threadId,
          runId: typeof runId === "string" ? runId : "",
          toolRef,
          breadcrumb: evidenceBreadcrumb(toolRef, request.toolCall.args),
          body: numbered,
          bytes: clip.bytes,
          truncated: clip.truncated,
        });
        // A full ledger leaves the result uncitable rather than citable-but-unrecorded.
        if (!entry) return result;
        return withNumberedLines(result, `${evidenceMarker(entry.id, clip)}\n${numbered}`);
      } catch (err) {
        options.logger?.warn(
          `[evidence] failed to record ${toolRef}: ${err instanceof Error ? err.message : String(err)}`,
        );
        return result;
      }
    },
  });
}
