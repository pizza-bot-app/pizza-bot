import { describe, expect, it } from "vitest";
import { inboxThreads } from "./inbox-views.js";

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
