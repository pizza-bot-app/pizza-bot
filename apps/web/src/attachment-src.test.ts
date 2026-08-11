import { afterEach, describe, expect, it, vi } from "vitest";
import { loadAttachmentObjectUrl } from "./attachment-src.js";

describe("authenticated attachment object URLs", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("fetches through the client and revokes the object URL on release", async () => {
    const blob = new Blob(["pizza"]);
    const fetchAttachment = vi.fn(async () => blob);
    const createObjectURL = vi.fn(() => "blob:authenticated");
    const revokeObjectURL = vi.fn();
    vi.stubGlobal("URL", { createObjectURL, revokeObjectURL });
    const onSrc = vi.fn();

    const release = loadAttachmentObjectUrl("attachment-1", { fetchAttachment }, onSrc);
    await Promise.resolve();

    expect(fetchAttachment).toHaveBeenCalledWith("attachment-1");
    expect(createObjectURL).toHaveBeenCalledWith(blob);
    expect(onSrc).toHaveBeenCalledWith("blob:authenticated");

    release();
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:authenticated");
  });

  it("does not publish or leak a URL after release", async () => {
    let resolve!: (blob: Blob) => void;
    const pending = new Promise<Blob>((done) => {
      resolve = done;
    });
    const createObjectURL = vi.fn(() => "blob:late");
    vi.stubGlobal("URL", { createObjectURL, revokeObjectURL: vi.fn() });
    const onSrc = vi.fn();
    const release = loadAttachmentObjectUrl(
      "attachment-1",
      { fetchAttachment: vi.fn(() => pending) },
      onSrc,
    );

    release();
    resolve(new Blob(["late"]));
    await Promise.resolve();

    expect(createObjectURL).not.toHaveBeenCalled();
    expect(onSrc).not.toHaveBeenCalled();
  });
});
