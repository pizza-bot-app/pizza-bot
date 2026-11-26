import { describe, expect, it } from "vitest";
import type { Todo } from "@pizza-bot/core";
import {
  dueDateCommit,
  dueLabel,
  flaggedThreadIds,
  msUntilLocalMidnight,
  isOverdue,
  localToday,
  openTodoForThread,
  stepProgress,
  todosInView,
  todoViewCounts,
} from "./todo-views.js";

const TODAY = "2026-11-26";

function todo(id: string, fields: Partial<Todo> = {}): Todo {
  return {
    id,
    title: id,
    notes: "",
    importance: "normal",
    notify: "immediate",
    steps: [],
    completed: false,
    threadIds: [],
    history: [],
    createdAt: `2026-11-0${id.length}T00:00:00.000Z`,
    updatedAt: "2026-11-01T00:00:00.000Z",
    ...fields,
  };
}

describe("todo smart views", () => {
  const overdue = todo("over", { dueDate: "2026-11-20" });
  const dueToday = todo("today", { dueDate: TODAY });
  const dueLater = todo("later", {
    dueDate: "2026-12-05",
    importance: "high",
    createdAt: "2026-11-07T00:00:00.000Z",
  });
  const undated = todo("undated", { createdAt: "2026-11-09T00:00:00.000Z" });
  const important = todo("star", { importance: "high", createdAt: "2026-11-02T00:00:00.000Z" });
  const done = todo("done", {
    completed: true,
    dueDate: "2026-11-01",
    importance: "high",
    completedAt: "2026-11-25T00:00:00.000Z",
  });
  const doneEarlier = todo("done2", { completed: true, completedAt: "2026-11-10T00:00:00.000Z" });
  const all = [undated, dueLater, done, important, dueToday, overdue, doneEarlier];

  it("puts overdue and due-today items in Today, earliest first", () => {
    expect(todosInView(all, "today", TODAY).map((t) => t.id)).toEqual(["over", "today"]);
  });

  it("lists every dated incomplete item in Planned by due date", () => {
    expect(todosInView(all, "planned", TODAY).map((t) => t.id)).toEqual(["over", "today", "later"]);
  });

  it("keeps completed items out of every view but Completed", () => {
    expect(todosInView(all, "important", TODAY).map((t) => t.id)).toEqual(["later", "star"]);
    expect(todosInView(all, "all", TODAY).map((t) => t.id)).toEqual([
      "undated",
      "later",
      "today",
      "over",
      "star",
    ]);
    expect(todosInView(all, "completed", TODAY).map((t) => t.id)).toEqual(["done", "done2"]);
  });

  it("counts each view", () => {
    expect(todoViewCounts(all, TODAY)).toEqual({
      today: 2,
      planned: 3,
      important: 2,
      all: 5,
      completed: 2,
    });
  });

  it("marks only incomplete past-due items overdue", () => {
    expect(isOverdue(overdue, TODAY)).toBe(true);
    expect(isOverdue(dueToday, TODAY)).toBe(false);
    expect(isOverdue(done, TODAY)).toBe(false);
  });
});

describe("todo labels and links", () => {
  it("formats the local calendar date", () => {
    expect(localToday(new Date(2026, 0, 5, 23, 30))).toBe("2026-01-05");
  });

  it("names nearby due dates relative to today", () => {
    expect(dueLabel(TODAY, TODAY)).toBe("Today");
    expect(dueLabel("2026-11-27", TODAY)).toBe("Tomorrow");
    expect(dueLabel("2026-11-25", TODAY)).toBe("Yesterday");
    expect(dueLabel("2027-03-01", TODAY)).toContain("2027");
    expect(dueLabel("2026-12-24", TODAY)).not.toContain("2026");
  });

  it("reports step progress only when steps exist", () => {
    expect(stepProgress(todo("a"))).toBeUndefined();
    expect(
      stepProgress(
        todo("a", {
          steps: [
            { id: "1", title: "one", completed: true },
            { id: "2", title: "two", completed: false },
          ],
        }),
      ),
    ).toEqual({ done: 1, total: 2 });
  });

  it("flags threads linked to an incomplete todo", () => {
    const todos = [
      todo("a", { threadIds: ["t1", "t2"] }),
      todo("b", { threadIds: ["t3"], completed: true }),
    ];
    expect([...flaggedThreadIds(todos)].sort()).toEqual(["t1", "t2"]);
    expect(openTodoForThread(todos, "t2")?.id).toBe("a");
    expect(openTodoForThread(todos, "t3")).toBeUndefined();
  });
});

describe("dueDateCommit", () => {
  it("saves a complete in-range date, clears an emptied one, and ignores no change", () => {
    expect(dueDateCommit("2026-12-01", undefined)).toBe("2026-12-01");
    expect(dueDateCommit("", "2026-12-01")).toBeNull();
    expect(dueDateCommit("2026-12-01", "2026-12-01")).toBe("unchanged");
    expect(dueDateCommit("", undefined)).toBe("unchanged");
  });

  it("reverts what typing a year passes through, and out-of-range years", () => {
    expect(dueDateCommit("0002-11-26", "2026-11-26")).toBe("revert");
    expect(dueDateCommit("0202-11-26", "2026-11-26")).toBe("revert");
    expect(dueDateCommit("3000-01-01", undefined)).toBe("revert");
    expect(dueDateCommit("2026-02-30", undefined)).toBe("revert");
  });
});

describe("msUntilLocalMidnight", () => {
  it("counts down to the next local midnight", () => {
    expect(msUntilLocalMidnight(new Date(2026, 10, 26, 23, 59, 0))).toBe(60_000);
    expect(msUntilLocalMidnight(new Date(2026, 10, 26, 0, 0, 0))).toBe(24 * 60 * 60 * 1000);
  });
});

