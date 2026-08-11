import { Hono } from "hono";
import { randomUUID } from "node:crypto";
import { AttachmentValidationError } from "@pizza-bot/storage";
import { MAX_ATTACHMENT_BYTES } from "@pizza-bot/core";
import type { AgentHost } from "./agent-host.js";
import { limitMultipartBody } from "./request-limits.js";

function contentDisposition(filename: string): string {
  const fallback = filename
    .normalize("NFKD")
    .replace(/[^\x20-\x7e]/g, "_")
    .replace(/["\\]/g, "_");
  const encoded = encodeURIComponent(filename).replace(
    /['()*]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `inline; filename="${fallback || "attachment"}"; filename*=UTF-8''${encoded}`;
}

export function attachmentRoutes(host: AgentHost): Hono {
  const app = new Hono();

  app.post("/attachments", limitMultipartBody(MAX_ATTACHMENT_BYTES), async (c) => {
    const store = host.attachments;
    if (!store) return c.json({ error: "attachments_disabled" }, 409);

    let form: FormData;
    try {
      form = await c.req.formData();
    } catch {
      return c.json({ error: "invalid_multipart" }, 400);
    }
    const file = form.get("file");
    if (!(file instanceof File)) return c.json({ error: "missing_file" }, 400);

    const bytes = Buffer.from(await file.arrayBuffer());
    const mediaType = file.type || "application/octet-stream";
    const filename = file.name || "attachment";
    const threadId = typeof form.get("thread_id") === "string" ? (form.get("thread_id") as string) : undefined;

    try {
      const meta = store.create({ id: randomUUID(), bytes, filename, mediaType, ...(threadId ? { threadId } : {}) });
      return c.json(meta, 201);
    } catch (err) {
      if (err instanceof AttachmentValidationError) {
        const status = err.code === "too_large" ? 413 : 400;
        return c.json({ error: err.code, message: err.message }, status);
      }
      throw err;
    }
  });

  app.get("/attachments/:id", (c) => {
    const store = host.attachments;
    if (!store) return c.json({ error: "attachments_disabled" }, 409);
    const id = c.req.param("id");
    const meta = store.get(id);
    const bytes = meta ? store.readBytes(id) : undefined;
    if (!meta || !bytes) return c.json({ error: "not_found" }, 404);
    c.header("Content-Type", meta.mediaType);
    c.header("Content-Length", String(meta.sizeBytes));
    c.header("Content-Disposition", contentDisposition(meta.filename));
    c.header("Cache-Control", "private, max-age=31536000, immutable");
    return c.body(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer);
  });

  app.delete("/attachments/:id", (c) => {
    const store = host.attachments;
    if (!store) return c.json({ error: "attachments_disabled" }, 409);
    return c.json({ deleted: store.delete(c.req.param("id")) });
  });

  return app;
}

export { MAX_ATTACHMENT_BYTES };
