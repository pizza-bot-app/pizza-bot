import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { AttachmentStore, AttachmentValidationError } from "./attachments.js";
import { attachmentUrl, MAX_ATTACHMENT_BYTES, BEDROCK_ATTACHMENT_LIMITS } from "@pizza-bot/core";

const tmpFiles: string[] = [];
const openHandles: Database.Database[] = [];

function openStore(): { store: AttachmentStore; dir: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pizza-attach-"));
  tmpFiles.push(root);
  const db = new Database(path.join(root, "app.sqlite"));
  db.pragma("journal_mode = WAL");
  openHandles.push(db);
  const dir = path.join(root, "attachments");
  return { store: new AttachmentStore(db, dir), dir };
}

afterEach(() => {
  for (const db of openHandles.splice(0)) db.close();
  for (const d of tmpFiles.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

describe("AttachmentStore: create + read", () => {
  it("persists bytes to disk + a metadata row, returning the attachment:// ref", () => {
    const { store, dir } = openStore();
    const bytes = Buffer.from("hello pizza", "utf8");
    const meta = store.create({ id: "a1", bytes, filename: "note.txt", mediaType: "text/plain" });

    expect(meta.id).toBe("a1");
    expect(meta.url).toBe(attachmentUrl("a1"));
    expect(meta.mediaType).toBe("text/plain");
    expect(meta.sizeBytes).toBe(bytes.byteLength);
    expect(fs.readFileSync(path.join(dir, "a1")).toString("utf8")).toBe("hello pizza");
    expect(store.get("a1")).toEqual(meta);
    expect(store.readBytes("a1")?.toString("utf8")).toBe("hello pizza");
    if (process.platform !== "win32") {
      expect(fs.statSync(dir).mode & 0o777).toBe(0o700);
      expect(fs.statSync(path.join(dir, "a1")).mode & 0o777).toBe(0o600);
    }
  });

  it("returns undefined for an unknown id", () => {
    const { store } = openStore();
    expect(store.get("nope")).toBeUndefined();
    expect(store.readBytes("nope")).toBeUndefined();
  });

  it("deletes one attachment's metadata and blob", () => {
    const { store, dir } = openStore();
    store.create({ id: "a1", bytes: Buffer.from("x"), filename: "a.txt", mediaType: "text/plain" });

    expect(store.delete("a1")).toBe(true);
    expect(store.delete("a1")).toBe(false);
    expect(store.get("a1")).toBeUndefined();
    expect(fs.existsSync(path.join(dir, "a1"))).toBe(false);
  });

  it("deletes every attachment owned by a thread and leaves others intact", () => {
    const { store } = openStore();
    store.create({ id: "a1", bytes: Buffer.from("1"), filename: "a.txt", mediaType: "text/plain", threadId: "t1" });
    store.create({ id: "a2", bytes: Buffer.from("2"), filename: "b.txt", mediaType: "text/plain", threadId: "t1" });
    store.create({ id: "a3", bytes: Buffer.from("3"), filename: "c.txt", mediaType: "text/plain", threadId: "t2" });

    expect(store.deleteByThread("t1")).toBe(2);
    expect(store.get("a1")).toBeUndefined();
    expect(store.get("a2")).toBeUndefined();
    expect(store.get("a3")).toBeDefined();
  });
});

describe("AttachmentStore: validation", () => {
  it("rejects an unsupported MIME type", () => {
    const { store } = openStore();
    expect(() =>
      store.create({ id: "x", bytes: Buffer.from("MZ"), filename: "a.exe", mediaType: "application/x-msdownload" }),
    ).toThrow(AttachmentValidationError);
  });

  it("rejects a file over the absolute transport cap", () => {
    const { store } = openStore();
    const big = Buffer.alloc(MAX_ATTACHMENT_BYTES + 1, 0);
    expect(() => store.create({ id: "x", bytes: big, filename: "big.png", mediaType: "image/png" })).toThrow(
      /too large/,
    );
  });

  it("enforces the per-category image ceiling below the transport cap", () => {
    const { store } = openStore();
    const overImage = Buffer.alloc(BEDROCK_ATTACHMENT_LIMITS.imageBytes + 1, 0);
    expect(overImage.byteLength).toBeLessThan(MAX_ATTACHMENT_BYTES);
    expect(() => store.create({ id: "x", bytes: overImage, filename: "big.png", mediaType: "image/png" })).toThrow(
      /too large.*this type/,
    );
    expect(() =>
      store.create({ id: "d", bytes: overImage, filename: "big.pdf", mediaType: "application/pdf" }),
    ).not.toThrow();
  });

  it("respects a provider's own declared limits", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pizza-attach-lim-"));
    tmpFiles.push(root);
    const db = new Database(path.join(root, "app.sqlite"));
    db.pragma("journal_mode = WAL");
    openHandles.push(db);
    const store = new AttachmentStore(db, path.join(root, "attachments"), { imageBytes: 4, documentBytes: 8 });
    expect(() =>
      store.create({ id: "img", bytes: Buffer.alloc(5), filename: "a.png", mediaType: "image/png" }),
    ).toThrow(/too large/);
    expect(() =>
      store.create({ id: "doc", bytes: Buffer.alloc(5), filename: "a.txt", mediaType: "text/plain" }),
    ).not.toThrow();
  });

  it("rejects an empty file", () => {
    const { store } = openStore();
    expect(() =>
      store.create({ id: "x", bytes: Buffer.alloc(0), filename: "empty.png", mediaType: "image/png" }),
    ).toThrow(/empty/);
  });

  it("accepts an empty-MIME .json/.yaml/.log via extension inference, normalized to text/plain", () => {
    const { store } = openStore();
    const cases: Array<[string, string]> = [
      ["j", "data.json"],
      ["y", "compose.yaml"],
      ["l", "server.log"],
    ];
    for (const [id, filename] of cases) {
      const meta = store.create({ id, bytes: Buffer.from("{}"), filename, mediaType: "" });
      expect(meta.mediaType).toBe("text/plain");
      expect(meta.filename).toBe(filename);
    }
  });

  it("does not override a valid supported browser MIME with inference", () => {
    const { store } = openStore();
    const meta = store.create({ id: "p", bytes: Buffer.from("%PDF"), filename: "report.pdf", mediaType: "application/pdf" });
    expect(meta.mediaType).toBe("application/pdf");
  });

  it("rejects a path-traversal id", () => {
    const { store } = openStore();
    expect(() =>
      store.create({ id: "../escape", bytes: Buffer.from("x"), filename: "a.txt", mediaType: "text/plain" }),
    ).toThrow(AttachmentValidationError);
  });
});

describe("AttachmentStore: resolver", () => {
  it("resolves a stored id to base64 bytes + MIME + name for the model inliner", async () => {
    const { store } = openStore();
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
    store.create({ id: "img1", bytes, filename: "shot.png", mediaType: "image/png" });

    const resolved = await store.resolver("img1");
    expect(resolved).toEqual({ data: bytes.toString("base64"), mediaType: "image/png", name: "shot.png" });
  });

  it("resolves undefined for a deleted/unknown id (inliner then drops the block)", async () => {
    const { store } = openStore();
    expect(await store.resolver("gone")).toBeUndefined();
  });
});
