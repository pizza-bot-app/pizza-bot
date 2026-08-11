import { describe, it, expect } from "vitest";
import { HumanMessage, AIMessage } from "@langchain/core/messages";
import { attachmentInlineMiddleware } from "./attachment-inline-middleware.js";
import { attachmentUrl, type AttachmentResolver } from "@pizza-bot/core";

function wrap(resolver: AttachmentResolver) {
  const mw = attachmentInlineMiddleware(resolver) as unknown as {
    wrapModelCall: (
      req: { messages: unknown[] },
      handler: (req: { messages: unknown[] }) => Promise<unknown>,
    ) => Promise<unknown>;
  };
  return mw.wrapModelCall;
}

const resolverFor = (table: Record<string, { data: string; mediaType: string; name?: string }>): AttachmentResolver =>
  async (id) => table[id];

async function inlined(messages: unknown[], resolver: AttachmentResolver): Promise<any[]> {
  let seen: any[] = [];
  await wrap(resolver)({ messages }, async (req) => {
    seen = req.messages as any[];
    return new AIMessage("ok");
  });
  return seen;
}

describe("attachmentInlineMiddleware", () => {
  it("rewrites an image reference into a base64 source_type image block", async () => {
    const msg = new HumanMessage({
      content: [
        { type: "text", text: "what is this?" },
        { type: "file", url: attachmentUrl("img1"), mimeType: "image/png", name: "shot.png" },
      ],
    });
    const out = await inlined([msg], resolverFor({ img1: { data: "QUJD", mediaType: "image/png", name: "shot.png" } }));
    expect(out[0].content).toEqual([
      { type: "text", text: "what is this?" },
      { type: "image", source_type: "base64", mime_type: "image/png", data: "QUJD" },
    ]);
  });

  it("rewrites a document reference into a base64 source_type file block with a name", async () => {
    const msg = new HumanMessage({
      content: [{ type: "file", url: attachmentUrl("doc1"), mimeType: "application/pdf", name: "report.pdf" }],
    });
    const out = await inlined([msg], resolverFor({ doc1: { data: "JVBERi0=", mediaType: "application/pdf", name: "report.pdf" } }));
    expect(out[0].content).toEqual([
      { type: "text", text: "(see attached document)" },
      { type: "file", source_type: "base64", mime_type: "application/pdf", data: "JVBERi0=", metadata: { name: "report.pdf" } },
    ]);
  });

  it("replaces an unresolvable reference with a text placeholder, not a rejected block", async () => {
    const msg = new HumanMessage({
      content: [{ type: "file", url: attachmentUrl("gone"), mimeType: "image/png", name: "missing.png" }],
    });
    const out = await inlined([msg], resolverFor({}));
    expect(out[0].content).toEqual([{ type: "text", text: "[attachment missing.png unavailable]" }]);
  });

  it("leaves a plain-text human message untouched (same reference)", async () => {
    const msg = new HumanMessage("hello");
    const out = await inlined([msg], resolverFor({}));
    expect(out[0]).toBe(msg);
    expect(out[0].content).toBe("hello");
  });

  it("does not rewrite non-human messages even if they carry a file-shaped block", async () => {
    const ai = new AIMessage({ content: [{ type: "file", url: attachmentUrl("img1"), mimeType: "image/png" }] as any });
    const out = await inlined([ai], resolverFor({ img1: { data: "QUJD", mediaType: "image/png" } }));
    expect(out[0]).toBe(ai);
  });

  it("passes the request through unchanged when no attachment references exist", async () => {
    const msg = new HumanMessage({ content: [{ type: "text", text: "no files here" }] });
    const out = await inlined([msg], resolverFor({}));
    expect(out[0]).toBe(msg);
  });
});
