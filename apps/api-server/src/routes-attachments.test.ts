import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildApp } from "./index.js";
import { AgentHost } from "./agent-host.js";
import type { AttachmentMeta } from "@pizza-bot/core";
import { MAX_ATTACHMENT_BYTES } from "@pizza-bot/core";
import { multipartRequestLimit } from "./request-limits.js";

describe("attachment routes: POST /attachments, GET /attachments/:id", () => {
  let dataRoot: string;
  let pluginsDir: string;
  let host: AgentHost;
  let app: ReturnType<typeof buildApp>;

  beforeEach(async () => {
    dataRoot = mkdtempSync(join(tmpdir(), "route-attach-data-"));
    pluginsDir = mkdtempSync(join(tmpdir(), "route-attach-plugins-"));
    host = await AgentHost.create({ dataRoot, pluginsDir });
    app = buildApp(host);
  });

  afterEach(async () => {
    await host.close();
    for (const d of [dataRoot, pluginsDir]) rmSync(d, { recursive: true, force: true });
  });

  const upload = (file: File) => {
    const form = new FormData();
    form.set("file", file);
    return app.request("/attachments", { method: "POST", body: form });
  };

  it("uploads a supported image: stores a blob + returns an attachment:// ref", async () => {
    const res = await upload(new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], "shot.png", { type: "image/png" }));
    expect(res.status).toBe(201);
    const meta = (await res.json()) as AttachmentMeta;
    expect(meta.url).toMatch(/^attachment:\/\//);
    expect(meta.mediaType).toBe("image/png");
    expect(meta.filename).toBe("shot.png");
    expect(meta.sizeBytes).toBe(4);
    expect(existsSync(join(dataRoot, "attachments", meta.id))).toBe(true);
  });

  it("serves the stored bytes back with the right content-type", async () => {
    const meta = (await (await upload(new File(["hello"], "note.txt", { type: "text/plain" }))).json()) as AttachmentMeta;
    const got = await app.request(`/attachments/${meta.id}`);
    expect(got.status).toBe(200);
    expect(got.headers.get("content-type")).toBe("text/plain");
    expect(await got.text()).toBe("hello");
  });

  it("serves previews whose filenames contain non-ASCII characters", async () => {
    const filename = "Screenshot 2026-08-03 at 4.06.57\u202fPM.png";
    const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
    const meta = (await (await upload(new File([bytes], filename, { type: "image/png" }))).json()) as AttachmentMeta;

    const got = await app.request(`/attachments/${meta.id}`);

    expect(got.status).toBe(200);
    expect(new Uint8Array(await got.arrayBuffer())).toEqual(bytes);
    expect(got.headers.get("content-disposition")).toBe(
      `inline; filename="Screenshot 2026-08-03 at 4.06.57 PM.png"; filename*=UTF-8''Screenshot%202026-08-03%20at%204.06.57%E2%80%AFPM.png`,
    );
  });

  it("deletes a discarded draft attachment", async () => {
    const meta = (await (await upload(new File(["draft"], "draft.txt", { type: "text/plain" }))).json()) as AttachmentMeta;
    const deleted = await app.request(`/attachments/${meta.id}`, { method: "DELETE" });
    expect(deleted.status).toBe(200);
    expect(await deleted.json()).toEqual({ deleted: true });
    expect(existsSync(join(dataRoot, "attachments", meta.id))).toBe(false);
    expect((await app.request(`/attachments/${meta.id}`)).status).toBe(404);
  });

  it("accepts an empty-MIME .json via extension inference, normalized to text/plain", async () => {
    const res = await upload(new File(["{}"], "data.json", { type: "" }));
    expect(res.status).toBe(201);
    const meta = (await res.json()) as AttachmentMeta;
    expect(meta.mediaType).toBe("text/plain");
    expect(meta.filename).toBe("data.json");
  });

  it("rejects an unsupported type with a 400", async () => {
    const res = await upload(new File(["MZ"], "virus.exe", { type: "application/x-msdownload" }));
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe("unsupported_type");
  });

  it("400s a POST with no file field", async () => {
    const res = await app.request("/attachments", { method: "POST", body: new FormData() });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe("missing_file");
  });

  it("rejects oversized requests before parsing multipart data", async () => {
    const res = await app.request("/attachments", {
      method: "POST",
      headers: {
        "content-length": String(multipartRequestLimit(MAX_ATTACHMENT_BYTES) + 1),
        "content-type": "multipart/form-data; boundary=test",
      },
      body: "--test--",
    });
    expect(res.status).toBe(413);
    expect(await res.json()).toMatchObject({ error: "request_too_large" });
  });

  it("404s an unknown attachment id", async () => {
    expect((await app.request("/attachments/does-not-exist")).status).toBe(404);
  });
});
