/**
 * Records the tool outputs a grounded skill may cite and stamps each result with its
 * evidence id, which is the only way the model learns an id to cite. The body cap is
 * applied to the output itself, so the bytes the model reads are the bytes a
 * reviewer verifies against.
 */
import { ToolMessage } from "@langchain/core/messages";
import { createMiddleware } from "langchain";
import {
  clipEvidenceBody,
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

function stampedContent(
  message: ToolMessage,
  marker: string,
  clipped: string | undefined,
): ToolMessage["content"] {
  if (clipped !== undefined) return `${marker}\n${clipped}`;
  if (typeof message.content === "string") return `${marker}\n${message.content}`;
  return [{ type: "text" as const, text: marker }, ...message.content];
}

function withMarker(
  message: ToolMessage,
  marker: string,
  clipped: string | undefined,
): ToolMessage {
  const stamped = Object.create(Object.getPrototypeOf(message)) as ToolMessage;
  return Object.assign(stamped, message, {
    content: stampedContent(message, marker, clipped),
  });
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

      try {
        const entry = await options.recorder({
          threadId,
          runId: typeof runId === "string" ? runId : "",
          toolRef,
          breadcrumb: evidenceBreadcrumb(toolRef, request.toolCall.args),
          body: clip.body,
          bytes: clip.bytes,
          truncated: clip.truncated,
        });
        // A full ledger leaves the result uncitable rather than citable-but-unrecorded.
        if (!entry) return result;
        return withMarker(
          result,
          evidenceMarker(entry.id, clip),
          clip.truncated ? clip.body : undefined,
        );
      } catch (err) {
        options.logger?.warn(
          `[evidence] failed to record ${toolRef}: ${err instanceof Error ? err.message : String(err)}`,
        );
        return result;
      }
    },
  });
}
