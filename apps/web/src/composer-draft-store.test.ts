import { describe, expect, it } from "vitest";
import { ComposerDraftStore } from "./composer-draft-store.js";

const attachment = {
  id: "a1",
  url: "attachment://a1",
  mediaType: "text/plain",
  filename: "notes.txt",
  sizeBytes: 5,
};

describe("ComposerDraftStore", () => {
  it("keeps independent text, model, and attachments per thread", () => {
    const store = new ComposerDraftStore();
    store.set("one", { text: "first", model: "p:a", attachments: [attachment] });
    store.set("two", { text: "second", model: "", attachments: [] });

    expect(store.get("one")).toEqual({
      text: "first",
      model: "p:a",
      attachments: [attachment],
      uploading: 0,
    });
    expect(store.get("two").text).toBe("second");
  });

  it("retains a late upload and clears submitted drafts", () => {
    const store = new ComposerDraftStore();
    store.set("one", { text: "draft", model: "", attachments: [] });
    store.addAttachment("one", attachment);
    expect(store.get("one").attachments).toEqual([attachment]);

    store.clear("one");
    expect(store.get("one")).toEqual({ text: "", model: "", attachments: [], uploading: 0 });
  });

  it("rejects uploads that finish after their thread was discarded", () => {
    const store = new ComposerDraftStore();
    store.set("deleted", { text: "draft", model: "", attachments: [] });
    store.discard("deleted");

    expect(store.addAttachment("deleted", attachment)).toBe(false);
    expect(store.get("deleted").attachments).toEqual([]);
  });

  it("notifies a remounted composer about pending and completed uploads", () => {
    const store = new ComposerDraftStore();
    const snapshots: Array<{ uploading: number; attachmentIds: string[] }> = [];
    const unsubscribe = store.subscribe("one", () => {
      const draft = store.get("one");
      snapshots.push({
        uploading: draft.uploading,
        attachmentIds: draft.attachments.map((item) => item.id),
      });
    });

    expect(store.beginUploads("one", 1)).toBe(true);
    store.addAttachment("one", attachment);
    store.finishUpload("one");
    unsubscribe();

    expect(snapshots).toEqual([
      { uploading: 1, attachmentIds: [] },
      { uploading: 1, attachmentIds: ["a1"] },
      { uploading: 0, attachmentIds: ["a1"] },
    ]);
  });

  it("publishes a successful attachment exactly once", () => {
    const store = new ComposerDraftStore();
    const snapshots: string[][] = [];
    store.beginUploads("one", 1);
    store.subscribe("one", () => {
      snapshots.push(store.get("one").attachments.map((item) => item.id));
    });

    expect(store.addAttachment("one", attachment)).toBe(true);
    expect(store.addAttachment("one", attachment)).toBe(true);

    expect(store.get("one").attachments).toEqual([attachment]);
    expect(snapshots).toEqual([["a1"]]);
  });
});
