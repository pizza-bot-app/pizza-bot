/** Message rewrites applied to every Bedrock Converse request. */
import type { BaseMessage } from "@langchain/core/messages";

function withContent(msg: BaseMessage, content: unknown): BaseMessage {
  const clone = Object.assign(Object.create(Object.getPrototypeOf(msg)) as BaseMessage, msg);
  (clone as { content: unknown }).content = content;
  return clone;
}

function isReasoningBlock(block: unknown): boolean {
  if (typeof block !== "object" || block === null) return false;
  const t = (block as { type?: unknown }).type;
  return t === "reasoning_content" || t === "reasoning";
}

function toolCallsOf(msg: BaseMessage): Array<{
  id?: string;
  name: string;
  args: Record<string, unknown>;
}> {
  const toolCalls = (msg as { tool_calls?: unknown }).tool_calls;
  return Array.isArray(toolCalls)
    ? toolCalls.filter(
        (call): call is { id?: string; name: string; args: Record<string, unknown> } =>
          typeof call === "object" &&
          call !== null &&
          "name" in call &&
          typeof call.name === "string" &&
          "args" in call &&
          typeof call.args === "object" &&
          call.args !== null &&
          !Array.isArray(call.args),
      )
    : [];
}

/**
 * @langchain/aws@1.4.2 drops reasoning signatures while converting native v3
 * streams to v1 history, so Bedrock rejects replayed `reasoning` and
 * `reasoning_content` blocks. Strip them only from provider input, preserving
 * checkpoint display and tool calls. Remove when native-v3 conversion and replay
 * preserve signatures (langchainjs#11164 and #11246).
 */
export function stripReasoningForBedrock(messages: BaseMessage[]): BaseMessage[] {
  let rewritten: BaseMessage[] | undefined;
  for (let index = 0; index < messages.length; index += 1) {
    const msg = messages[index]!;
    if (!Array.isArray(msg.content) || !msg.content.some(isReasoningBlock)) {
      rewritten?.push(msg);
      continue;
    }

    rewritten ??= messages.slice(0, index);
    let content = msg.content.filter((block) => !isReasoningBlock(block));
    const type = typeof msg.getType === "function" ? msg.getType() : "";
    const toolCalls = type === "ai" ? toolCallsOf(msg) : [];
    if (
      content.length === 0 &&
      toolCalls.length > 0 &&
      msg.response_metadata?.output_version === "v1"
    ) {
      // V1 replay reads tool calls from content blocks, not `AIMessage.tool_calls`.
      content = toolCalls.map((call) => ({
        type: "tool_call" as const,
        ...(call.id ? { id: call.id } : {}),
        name: call.name,
        args: call.args,
      }));
    }
    if (type !== "ai" || content.length > 0 || toolCalls.length > 0) {
      rewritten.push(withContent(msg, content));
    }
  }
  return rewritten ?? messages;
}

const DOCUMENT_NAME_MAX_LENGTH = 200;
const DOCUMENT_NAME_DISALLOWED = /[^A-Za-z0-9_\s()[\]-]/g;
const WHITESPACE_RUN = /\s+/g;

/**
 * Bedrock accepts a cache point after PDFs but rejects one after text documents.
 * Unknown document formats stay uncached until their adjacency is verified.
 */
export function endsWithCacheIncompatibleDocument(messages: BaseMessage[]): boolean {
  const last = messages[messages.length - 1];
  if (!last || !Array.isArray(last.content)) return false;
  const block = last.content[last.content.length - 1] as
    | { type?: unknown; mime_type?: unknown; mimeType?: unknown }
    | undefined;
  if (typeof block !== "object" || block === null || block.type !== "file") return false;
  const rawMimeType =
    typeof block.mime_type === "string"
      ? block.mime_type
      : typeof block.mimeType === "string"
        ? block.mimeType
        : "";
  const mimeType = rawMimeType.split(";", 1)[0]!.trim().toLowerCase();
  return mimeType !== "application/pdf";
}

/**
 * Bedrock Converse's DocumentBlock.name allows `[A-Za-z0-9_\s()[\]-]`, rejects
 * consecutive whitespace and blank names, and caps at 200 chars. The original
 * filename is preserved in storage, checkpoint state, and download headers;
 * this projection is only for the model-facing label.
 */
export function sanitizeBedrockDocumentName(name: string): string {
  const replaced = name.replace(DOCUMENT_NAME_DISALLOWED, " ");
  const collapsed = replaced.replace(WHITESPACE_RUN, " ").trim();
  const bounded = collapsed.slice(0, DOCUMENT_NAME_MAX_LENGTH).trimEnd();
  return bounded.length > 0 ? bounded : "attachment";
}

interface FileBlockMetadata {
  name?: unknown;
  [k: string]: unknown;
}

function isFileBlockWithName(
  block: unknown,
): block is { type: "file"; metadata: FileBlockMetadata; [k: string]: unknown } {
  if (typeof block !== "object" || block === null) return false;
  const b = block as { type?: unknown; metadata?: unknown };
  if (b.type !== "file") return false;
  if (typeof b.metadata !== "object" || b.metadata === null) return false;
  return typeof (b.metadata as FileBlockMetadata).name === "string";
}

/**
 * Rewrites `metadata.name` on file content blocks so Bedrock accepts the
 * request. Non-file blocks and non-array contents pass through unchanged.
 */
export function sanitizeDocumentNamesForBedrock(messages: BaseMessage[]): BaseMessage[] {
  let rewritten: BaseMessage[] | undefined;
  for (let index = 0; index < messages.length; index += 1) {
    const msg = messages[index]!;
    if (!Array.isArray(msg.content) || !msg.content.some(isFileBlockWithName)) {
      rewritten?.push(msg);
      continue;
    }
    let changed = false;
    const content = msg.content.map((block) => {
      if (!isFileBlockWithName(block)) return block;
      const original = (block.metadata as FileBlockMetadata).name as string;
      const projected = sanitizeBedrockDocumentName(original);
      if (projected === original) return block;
      changed = true;
      return { ...block, metadata: { ...block.metadata, name: projected } };
    });
    if (!changed) {
      rewritten?.push(msg);
      continue;
    }
    rewritten ??= messages.slice(0, index);
    rewritten.push(withContent(msg, content));
  }
  return rewritten ?? messages;
}
