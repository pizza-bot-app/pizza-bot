import { describe, expect, it } from "vitest";
import type { Todo, TodoEvent } from "@pizza-bot/core";
import {
  activeSnooze,
  checkInChoice,
  graphIdOf,
  knownWorkThreads,
  localDateTimeToIso,
  nextCheckInLabel,
  ownerValue,
  parseCheckInLimit,
  snoozePresets,
  todoTimeline,
  todosAwaitingUser,
  whenLabel,
  workOwnerOf,
} from "./todo-ownership.js";

const names: Record<string, string> = {
  researcher: "Researcher",
  writer: "Writer",
  booker: "Booker",
  "graph:triage": "Triage",
};
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
      workOwner: "researcher",
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
    expect(entries[1]).toMatchObject({ text: "Researcher checked in (handed off)", workOwner: "researcher" });
    expect(entries[0]).toMatchObject({ threadId: "home" });
    expect(entries[0]!.workOwner).toBeUndefined();
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

describe("owners", () => {
  it("reads agent and graph owners as picker values and work-thread owners", () => {
    expect(ownerValue({ owner: "researcher" })).toBe("researcher");
    expect(ownerValue({ ownerGraph: "triage" })).toBe("graph:triage");
    expect(ownerValue({})).toBeUndefined();
    expect(graphIdOf("graph:triage")).toBe("triage");
    expect(graphIdOf("researcher")).toBeUndefined();
    expect(workOwnerOf("graph:triage")).toEqual({ graphId: "triage" });
    expect(workOwnerOf("researcher")).toEqual({ agentId: "researcher" });
  });
});

describe("refinement timeline sentences", () => {
  it("describes snoozes, subtasks, pauses, and handoffs to a workflow", () => {
    const until = "2026-12-01T09:00:00.000Z";
    const history: TodoEvent[] = [
      event({ id: "1", kind: "snoozed", note: `until ${until}: Fares update Monday` }),
      event({ id: "2", kind: "snoozed", actor: "user", note: "snooze lifted" }),
      event({ id: "3", kind: "subtask", agentId: "booker", todoId: "child", note: "requested: Book hotel" }),
      event({ id: "4", kind: "subtask", agentId: "booker", todoId: "child", note: "finished: Book hotel" }),
      event({ id: "5", kind: "paused", actor: "user", note: "Check-in budget used up (10 of 10)." }),
      event({ id: "6", kind: "assigned", agentId: "graph:triage", note: "Routine" }),
      event({ id: "7", kind: "completed", actor: "graph:triage" }),
      event({ id: "8", kind: "check-in", reason: "subtask", threadId: "bg" }),
    ];
    const entries = todoTimeline(history, nameOf);
    expect(entries.map((entry) => entry.text)).toEqual([
      "Researcher checked in (a subtask finished)",
      "Triage completed this",
      "Researcher handed this to the Triage workflow: Routine",
      "Check-ins paused: Check-in budget used up (10 of 10).",
      "Booker finished: Book hotel",
      "Researcher asked Booker to: Book hotel",
      "You lifted the snooze",
      `Researcher snoozed check-ins until ${whenLabel(until)} — Fares update Monday`,
    ]);
    expect(entries.find((entry) => entry.id === "3")?.todoId).toBe("child");
  });

  it("marks a graph's work thread with its graph owner", () => {
    const [entry] = todoTimeline([event({ kind: "failed", actor: "graph:triage", threadId: "run-1" })], nameOf);
    expect(entry).toMatchObject({ text: "Triage's check-in failed", workOwner: "graph:triage" });
  });
});

describe("snooze helpers", () => {
  it("offers later today, tomorrow 9 am, and next Monday 9 am in local time", () => {
    const thursday = new Date(2026, 10, 26, 14, 30);
    const [later, tomorrow, monday] = snoozePresets(thursday).map((preset) => new Date(preset.until));
    expect(later!.getTime() - thursday.getTime()).toBe(3 * 60 * 60 * 1000);
    expect([tomorrow!.getDate(), tomorrow!.getHours(), tomorrow!.getMinutes()]).toEqual([27, 9, 0]);
    expect([monday!.getDay(), monday!.getDate(), monday!.getHours()]).toEqual([1, 30, 9]);
  });

  it("moves next Monday a week out when today is Monday", () => {
    const mondayMorning = new Date(2026, 10, 30, 8, 0);
    const monday = new Date(snoozePresets(mondayMorning)[2]!.until);
    expect([monday.getDay(), monday.getDate()]).toEqual([1, 7]);
  });

  it("keeps only a snooze still in effect", () => {
    const now = Date.parse("2026-11-26T12:00:00.000Z");
    expect(activeSnooze("2026-11-27T09:00:00.000Z", now)).toBe("2026-11-27T09:00:00.000Z");
    expect(activeSnooze("2026-11-25T09:00:00.000Z", now)).toBeUndefined();
    expect(activeSnooze(undefined, now)).toBeUndefined();
  });

  it("turns a local date-time into an instant", () => {
    expect(localDateTimeToIso("2026-12-01T09:00")).toBe(new Date(2026, 11, 1, 9, 0).toISOString());
    expect(localDateTimeToIso("")).toBeUndefined();
    expect(localDateTimeToIso("not a date")).toBeUndefined();
  });
});

describe("parseCheckInLimit", () => {
  it("clears on blank, accepts 1-1000, and rejects anything else", () => {
    expect(parseCheckInLimit("  ")).toBeNull();
    expect(parseCheckInLimit("10")).toBe(10);
    expect(parseCheckInLimit("0")).toBeUndefined();
    expect(parseCheckInLimit("1001")).toBeUndefined();
    expect(parseCheckInLimit("2.5")).toBeUndefined();
    expect(parseCheckInLimit("ten")).toBeUndefined();
  });
});

describe("whenLabel dates", () => {
  it("adds the date when the time is more than six days away", () => {
    const now = Date.parse("2026-11-26T12:00:00.000Z");
    const soon = whenLabel("2026-11-28T09:00:00.000Z", now);
    const far = whenLabel("2026-12-17T09:00:00.000Z", now);
    expect(soon).not.toMatch(/Dec|Nov/);
    expect(far).toMatch(/Dec/);
    expect(far).toMatch(/17/);
  });
});

describe("knownWorkThreads", () => {
  it("collects current and earlier work threads with their agent or graph", () => {
    const base = { notes: "", importance: "normal", steps: [], completed: false, threadIds: [], notify: "immediate", createdAt: "", updatedAt: "" } as const;
    const todos = [
      {
        ...base,
        id: "a",
        title: "Flights",
        owner: "booker",
        backgroundThreadId: "bg-2",
        history: [
          { id: "1", at: "", kind: "check-in", actor: "researcher", threadId: "bg-1", reason: "cron" },
          { id: "2", at: "", kind: "notified", actor: "researcher", threadId: "home" },
          { id: "3", at: "", kind: "check-in", actor: "booker", threadId: "bg-2", reason: "handoff" },
        ],
      },
      {
        ...base,
        id: "b",
        title: "Expenses",
        ownerGraph: "filer",
        backgroundThreadId: "run-1",
        history: [{ id: "4", at: "", kind: "check-in", actor: "graph:filer", threadId: "run-1", reason: "manual" }],
      },
    ] as unknown as Todo[];
    const known = knownWorkThreads(todos);
    expect(known.agents).toEqual([
      { threadId: "bg-1", agentId: "researcher" },
      { threadId: "bg-2", agentId: "booker" },
    ]);
    expect(known.graphs).toEqual([{ threadId: "run-1", graphId: "filer" }]);
  });
});

