import { describe, expect, it } from "vitest";
import type { Todo, TodoEvent } from "@pizza-bot/core";
import {
  checkInChoice,
  nextCheckInLabel,
  todoTimeline,
  todosAwaitingUser,
} from "./todo-ownership.js";

const names: Record<string, string> = { researcher: "Researcher", writer: "Writer" };
const nameOf = (id: string) => names[id] ?? id;

function event(fields: Partial<TodoEvent> & Pick<TodoEvent, "kind">): TodoEvent {
  return { id: fields.kind, at: "2026-11-26T09:00:00.000Z", actor: "researcher", ...fields };
}

describe("checkInChoice", () => {
  it("matches presets, tolerating spacing, and flags anything else as custom", () => {
    expect(checkInChoice(undefined)).toBeNull();
    expect(checkInChoice("0 9 * * *")).toBe("0 9 * * *");
    expect(checkInChoice(" 0  9 * * 1-5 ")).toBe("0 9 * * 1-5");
    expect(checkInChoice("30 7 * * *")).toBe("custom");
  });
});

describe("todoTimeline", () => {
  it("writes one sentence per kind, newest first", () => {
    const history: TodoEvent[] = [
      event({ id: "1", kind: "assigned", actor: "user", agentId: "researcher" }),
      event({ id: "2", kind: "check-in", reason: "cron", threadId: "bg" }),
      event({ id: "3", kind: "progress", note: "Found two offices" }),
      event({ id: "4", kind: "asked", threadId: "bg" }),
      event({ id: "5", kind: "notified", threadId: "home" }),
      event({ id: "6", kind: "assigned", agentId: "writer", note: "Needs a letter" }),
      event({ id: "7", kind: "completed", actor: "writer" }),
      event({ id: "8", kind: "reopened", actor: "user" }),
      event({ id: "9", kind: "unassigned", actor: "user" }),
    ];
    expect(todoTimeline(history, nameOf).map((entry) => entry.text)).toEqual([
      "You took this back",
      "You reopened this",
      "Writer completed this",
      "Researcher handed this to Writer: Needs a letter",
      "Researcher sent you an update",
      "Researcher asked you a question",
      "Researcher noted: Found two offices",
      "Researcher checked in (scheduled)",
      "You assigned this to Researcher",
    ]);
  });

  it("describes a failed check-in and links its work thread", () => {
    const [entry] = todoTimeline(
      [event({ id: "1", kind: "failed", threadId: "bg", note: "The model is unavailable." })],
      nameOf,
    );
    expect(entry).toMatchObject({
      text: "Researcher's check-in failed: The model is unavailable.",
      threadId: "bg",
      workAgentId: "researcher",
    });
    expect(todoTimeline([event({ id: "2", kind: "failed" })], nameOf)[0]?.text).toBe("Researcher's check-in failed");
  });

  it("marks only check-in, question, and failure threads as the agent's work thread", () => {
    const entries = todoTimeline(
      [
        event({ id: "1", kind: "check-in", reason: "handoff", threadId: "bg" }),
        event({ id: "2", kind: "notified", threadId: "home" }),
      ],
      nameOf,
    );
    expect(entries[1]).toMatchObject({ text: "Researcher checked in (handed off)", workAgentId: "researcher" });
    expect(entries[0]).toMatchObject({ threadId: "home" });
    expect(entries[0]!.workAgentId).toBeUndefined();
  });
});

describe("todosAwaitingUser", () => {
  it("finds todos whose work thread is paused on the user", () => {
    const todos = [
      { id: "a", backgroundThreadId: "bg-a" },
      { id: "b", backgroundThreadId: "bg-b" },
      { id: "c" },
    ] as Todo[];
    expect([...todosAwaitingUser(todos, new Set(["bg-b", "other"]))]).toEqual(["b"]);
  });
});

describe("nextCheckInLabel", () => {
  const now = Date.parse("2026-11-26T08:00:00.000Z");
  it("counts down within a day and is empty when unknown or past", () => {
    expect(nextCheckInLabel(undefined, now)).toBe("");
    expect(nextCheckInLabel("2026-11-26T07:00:00.000Z", now)).toBe("");
    expect(nextCheckInLabel("2026-11-26T08:40:00.000Z", now)).toBe("in 40m");
    expect(nextCheckInLabel("2026-11-26T13:00:00.000Z", now)).toBe("in 5h");
    expect(nextCheckInLabel("2026-11-28T09:00:00.000Z", now)).not.toBe("");
  });
});
