import { describe, it, expect } from "vitest";
import {
  inferAttachmentMimeType,
  resolveAttachmentMediaType,
  maxBytesForMediaType,
  isSupportedAttachmentType,
  BEDROCK_ATTACHMENT_LIMITS,
} from "./attachment.js";

describe("inferAttachmentMimeType", () => {
  it("maps extensions whose canonical type is supported directly", () => {
    expect(inferAttachmentMimeType("note.txt")).toBe("text/plain");
    expect(inferAttachmentMimeType("README.md")).toBe("text/markdown");
    expect(inferAttachmentMimeType("data.csv")).toBe("text/csv");
    expect(inferAttachmentMimeType("page.HTML")).toBe("text/html");
    expect(inferAttachmentMimeType("doc.pdf")).toBe("application/pdf");
    expect(inferAttachmentMimeType("shot.JPEG")).toBe("image/jpeg");
    expect(inferAttachmentMimeType("sheet.xlsx")).toBe(
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    );
  });

  it("normalizes text/source/config extensions to text/plain", () => {
    for (const name of ["config.json", "compose.yaml", "compose.yml", "server.log", "main.ts", "script.py", "q.sql"]) {
      expect(inferAttachmentMimeType(name)).toBe("text/plain");
    }
  });

  it("returns undefined for an unrecognized or extension-less name", () => {
    expect(inferAttachmentMimeType("virus.exe")).toBeUndefined();
    expect(inferAttachmentMimeType("archive.zip")).toBeUndefined();
    expect(inferAttachmentMimeType("noextension")).toBeUndefined();
  });
});

describe("resolveAttachmentMediaType", () => {
  it("keeps a valid browser-provided type (never overridden by inference)", () => {
    expect(resolveAttachmentMediaType("image/png", "shot.jpg")).toBe("image/png");
    expect(resolveAttachmentMediaType("APPLICATION/PDF", "x.pdf")).toBe("application/pdf");
  });

  it("falls back to extension inference when the browser sends none/octet-stream", () => {
    expect(resolveAttachmentMediaType("", "config.json")).toBe("text/plain");
    expect(resolveAttachmentMediaType("application/octet-stream", "data.yaml")).toBe("text/plain");
    expect(resolveAttachmentMediaType(undefined, "server.log")).toBe("text/plain");
    expect(resolveAttachmentMediaType("application/octet-stream", "shot.png")).toBe("image/png");
  });

  it("returns undefined when neither the type nor the extension is supported", () => {
    expect(resolveAttachmentMediaType("application/octet-stream", "virus.exe")).toBeUndefined();
    expect(resolveAttachmentMediaType("application/x-msdownload", "a.exe")).toBeUndefined();
  });

  it("infers a supported type even when the browser type is unsupported", () => {
    expect(resolveAttachmentMediaType("application/x-yaml", "compose.yaml")).toBe("text/plain");
    expect(isSupportedAttachmentType(resolveAttachmentMediaType("", "config.json")!)).toBe(true);
  });
});

describe("maxBytesForMediaType", () => {
  it("uses the image ceiling for images and the document ceiling otherwise", () => {
    expect(maxBytesForMediaType("image/png", BEDROCK_ATTACHMENT_LIMITS)).toBe(BEDROCK_ATTACHMENT_LIMITS.imageBytes);
    expect(maxBytesForMediaType("text/plain", BEDROCK_ATTACHMENT_LIMITS)).toBe(
      BEDROCK_ATTACHMENT_LIMITS.documentBytes,
    );
    expect(maxBytesForMediaType("application/pdf", BEDROCK_ATTACHMENT_LIMITS)).toBe(
      BEDROCK_ATTACHMENT_LIMITS.documentBytes,
    );
  });

  it("honors a provider's own declared limits", () => {
    const custom = { imageBytes: 100, documentBytes: 200 };
    expect(maxBytesForMediaType("image/jpeg", custom)).toBe(100);
    expect(maxBytesForMediaType("text/csv", custom)).toBe(200);
  });
});
