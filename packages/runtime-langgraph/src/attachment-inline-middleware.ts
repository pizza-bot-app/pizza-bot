/** Resolves attachment references at model-call time without persisting bytes. */
import { createMiddleware } from "langchain";
import type { AttachmentResolver } from "@pizza-bot/core";
import { parseAttachmentUrl, isImageAttachmentType } from "@pizza-bot/core";

interface AnyBlock {
  type?: string;
  url?: string;
  mimeType?: string;
  mime_type?: string;
  name?: string;
  text?: string;
  [k: string]: unknown;
}

function attachmentIdOf(block: unknown): string | undefined {
  if (!block || typeof block !== "object") return undefined;
  const b = block as AnyBlock;
  if (b.type !== "file" || typeof b.url !== "string") return undefined;
  return parseAttachmentUrl(b.url);
}

/**
 * @langchain/aws@1.4.2 accepts `source_type: "base64"` for Bedrock attachments;
 * its camelCase multimodal shape fails. Revalidate the shape on provider upgrades.
 */
function inlinedBlock(mimeType: string, data: string, name?: string): AnyBlock {
  if (isImageAttachmentType(mimeType)) {
    return { type: "image", source_type: "base64", mime_type: mimeType, data };
  }
  return {
    type: "file",
    source_type: "base64",
    mime_type: mimeType,
    data,
    ...(name ? { metadata: { name } } : {}),
  };
}

function hasTextBlock(blocks: AnyBlock[]): boolean {
  return blocks.some((b) => b.type === "text" && typeof b.text === "string");
}

/**
 * Preserve the original array when unchanged. Missing attachments become text,
 * and Bedrock document blocks receive the required accompanying text block.
 */
async function inlineContent(content: unknown, resolve: AttachmentResolver): Promise<unknown> {
  if (!Array.isArray(content)) return content;
  if (!content.some((b) => attachmentIdOf(b) !== undefined)) return content;

  const out: AnyBlock[] = [];
  let inlinedDocument = false;
  for (const block of content as AnyBlock[]) {
    const id = attachmentIdOf(block);
    if (id === undefined) {
      out.push(block);
      continue;
    }
    const resolved = await resolve(id);
    if (!resolved) {
      out.push({ type: "text", text: `[attachment ${block.name ?? id} unavailable]` });
      continue;
    }
    if (!isImageAttachmentType(resolved.mediaType)) inlinedDocument = true;
    out.push(inlinedBlock(resolved.mediaType, resolved.data, resolved.name ?? block.name));
  }
  if (inlinedDocument && !hasTextBlock(out)) {
    out.unshift({ type: "text", text: "(see attached document)" });
  }
  return out;
}

export function attachmentInlineMiddleware(resolver: AttachmentResolver) {
  return createMiddleware({
    name: "attachmentInline",
    wrapModelCall: async (request, handler) => {
      const messages = request.messages;
      let changed = false;
      const rewritten = await Promise.all(
        messages.map(async (m) => {
          const type = typeof m.getType === "function" ? m.getType() : "";
          if (type !== "human") return m;
          const next = await inlineContent(m.content, resolver);
          if (next === m.content) return m;
          changed = true;
          // Never mutate the message instance referenced by checkpoint state.
          const clone = Object.create(Object.getPrototypeOf(m));
          Object.assign(clone, m, { content: next });
          return clone;
        }),
      );
      return handler(changed ? { ...request, messages: rewritten } : request);
    },
  });
}
