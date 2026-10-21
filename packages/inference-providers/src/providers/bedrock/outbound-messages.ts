/** Message rewrites applied to every Bedrock Converse request. */
import type { BaseMessage } from "@langchain/core/messages";

function withContent(msg: BaseMessage, content: unknown): BaseMessage {
  const clone = Object.assign(Object.create(Object.getPrototypeOf(msg)) as BaseMessage, msg);
  (clone as { content: unknown }).content = content;
  return clone;
}

function isUnreplayableBlock(block: unknown): boolean {
  if (typeof block !== "object" || block === null) return false;
  const t = (block as { type?: unknown }).type;
  return t === "reasoning_content" || t === "reasoning" || t === "invalid_tool_call";
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

function isEmptyContent(content: BaseMessage["content"]): boolean {
  return Array.isArray(content) ? content.length === 0 : content === "";
}

/** Returns `msg` itself when nothing changes, and `undefined` to drop it. */
function forReplay(msg: BaseMessage): BaseMessage | undefined {
  const content =
    Array.isArray(msg.content) && msg.content.some(isUnreplayableBlock)
      ? msg.content.filter((block) => !isUnreplayableBlock(block))
      : msg.content;
  const type = typeof msg.getType === "function" ? msg.getType() : "";
  if (type !== "ai") return content === msg.content ? msg : withContent(msg, content);

  const toolCalls = toolCallsOf(msg);
  if (isEmptyContent(content)) {
    if (toolCalls.length === 0) return undefined;
    if (Array.isArray(content) && msg.response_metadata?.output_version === "v1") {
      // V1 replay reads tool calls from content blocks, not `AIMessage.tool_calls`.
      return withContent(msg, toolCalls.map((call) => ({
        type: "tool_call" as const,
        ...(call.id ? { id: call.id } : {}),
        name: call.name,
        args: call.args,
      })));
    }
  }
  return content === msg.content ? msg : withContent(msg, content);
}

/**
 * Projects history into what Converse can replay; checkpoints keep the original.
 * Reasoning blocks go because @langchain/aws@1.4.2 drops their signatures on the
 * native v3 path and Bedrock rejects them; remove that part once
 * langchainjs#11164 and #11246 land. Invalid tool calls go because Converse
 * discards them, and assistant turns left with neither content nor tool calls go
 * because Bedrock rejects empty content.
 */
export function stripUnreplayableBlocksForBedrock(messages: BaseMessage[]): BaseMessage[] {
  let rewritten: BaseMessage[] | undefined;
  for (let index = 0; index < messages.length; index += 1) {
    const msg = messages[index]!;
    const replayed = forReplay(msg);
    if (replayed === msg) {
      rewritten?.push(msg);
      continue;
    }
    rewritten ??= messages.slice(0, index);
    if (replayed) rewritten.push(replayed);
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
