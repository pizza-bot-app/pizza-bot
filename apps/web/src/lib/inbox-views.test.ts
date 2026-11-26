import { describe, expect, it } from "vitest";
import { inboxThreads, mergeThreadRows } from "./inbox-views.js";
import type { ThreadInfo } from "@/api-client";

const rows = [
  { threadId: "chat", awaitingAction: false, unread: true },
  { threadId: "filed", awaitingAction: true, unread: false, folderId: "work" },
  { threadId: "work-thread", awaitingAction: true, unread: true, background: true as const, folderId: "work" },
];
const isUnread = (row: (typeof rows)[number]) => row.unread;
const ids = (filter: Parameters<typeof inboxThreads>[1]) =>
  inboxThreads(rows, filter, isUnread).map((row) => row.threadId);

describe("inboxThreads", () => {
  it("shows an agent's work thread only in the Action view", () => {
    expect(ids("action")).toEqual(["filed", "work-thread"]);
    expect(ids("all")).toEqual(["chat", "filed"]);
    expect(ids("unread")).toEqual(["chat"]);
    expect(ids("unfiled")).toEqual(["chat"]);
    expect(ids("folder:work")).toEqual(["filed"]);
  });
});

describe("mergeThreadRows", () => {
  const listed = [
    { threadId: "chat", title: "Chat", source: "user", pinned: false, unread: false, awaitingAction: false, createdAt: "", lastActivityAt: "" },
  ] as ThreadInfo[];

  it("keeps an answered work thread out of All after the server stops listing it", () => {
    const merged = mergeThreadRows(listed, ["chat", "work", "draft"], new Map([["work", "Compare flights"]]), new Set(["work"]));
    expect(merged.find((row) => row.threadId === "work")).toMatchObject({ title: "Compare flights", background: true });
    expect(merged.find((row) => row.threadId === "draft")?.background).toBeUndefined();
    expect(inboxThreads(merged, "all", () => false).map((row) => row.threadId)).toEqual(["chat", "draft"]);
    expect(inboxThreads(merged, "action", () => false)).toEqual([]);
  });

  it("prefers a locally known title over the server's", () => {
    const merged = mergeThreadRows(listed, [], new Map([["chat", "Renamed"]]), undefined);
    expect(merged[0]?.title).toBe("Renamed");
  });
});

