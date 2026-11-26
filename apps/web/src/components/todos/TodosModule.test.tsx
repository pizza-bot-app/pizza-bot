import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { Todo } from "@pizza-bot/core";
import { AppToastProvider } from "../AppToast.js";
import { HotkeyProvider } from "../../hotkeys/index.js";
import { TodosModule } from "./TodosModule.js";
import { TodoDetail } from "./TodoDetail.js";
import { FlagThreadButton } from "./FlagThreadButton.js";

const TODAY = "2026-11-26";

function todo(id: string, fields: Partial<Todo> = {}): Todo {
  return {
    id,
    title: id,
    notes: "",
    importance: "normal",
    steps: [],
    completed: false,
    threadIds: [],
    createdAt: "2026-11-01T00:00:00.000Z",
    updatedAt: "2026-11-01T00:00:00.000Z",
    ...fields,
  };
}

function wrap(node: React.ReactNode): string {
  return renderToStaticMarkup(
    <HotkeyProvider>
      <AppToastProvider>{node}</AppToastProvider>
    </HotkeyProvider>,
  );
}

const handlers = {
  onCreate: vi.fn(),
  onUpdate: vi.fn(),
  onDelete: vi.fn(),
  onUnlinkThread: vi.fn(),
  onOpenThread: vi.fn(),
};

describe("TodosModule", () => {
  const todos = [
    todo("Send the deck", {
      dueDate: "2026-11-20",
      importance: "high",
      threadIds: ["t1"],
      steps: [
        { id: "s1", title: "Draft", completed: true },
        { id: "s2", title: "Review", completed: false },
      ],
    }),
    todo("Book flights", { createdAt: "2026-11-02T00:00:00.000Z" }),
    todo("Filed taxes", { completed: true, completedAt: "2026-11-10T00:00:00.000Z" }),
  ];

  it("lists incomplete todos with their due date, steps, links, and importance", () => {
    const html = wrap(
      <TodosModule todos={todos} threadTitles={new Map()} today={TODAY} {...handlers} />,
    );
    expect(html).toContain("Book flights");
    expect(html).toContain("Send the deck");
    expect(html).not.toContain("Filed taxes");
    expect(html).toContain(`class="todo-due overdue"`);
    expect(html).toContain("1 of 2");
    expect(html).toContain('title="1 linked conversation"');
    expect(html).toContain('aria-label="Remove importance from “Send the deck”"');
    expect(html).toContain('placeholder="Add a todo"');
  });

  it("counts each smart view except Completed", () => {
    const html = wrap(
      <TodosModule todos={todos} threadTitles={new Map()} today={TODAY} {...handlers} />,
    );
    expect(html).toMatch(/Today<span class="segmented-count">1<\/span>/);
    expect(html).toMatch(/All<span class="segmented-count">2<\/span>/);
    expect(html).toMatch(/>Completed<\/button>/);
  });

  it("opens on a focused todo", () => {
    const html = wrap(
      <TodosModule
        todos={todos}
        threadTitles={new Map([["t1", "Q4 planning"]])}
        today={TODAY}
        focusId="Send the deck"
        {...handlers}
      />,
    );
    expect(html).toContain('aria-label="Title" maxLength="200" value="Send the deck"');
    expect(html).toContain("Q4 planning");
  });
});

describe("TodoDetail", () => {
  it("shows steps, the due date, and linked conversations by title", () => {
    const html = wrap(
      <TodoDetail
        todo={todo("Reply to Dana", {
          dueDate: TODAY,
          notes: "Mention the budget",
          threadIds: ["t1", "gone"],
          steps: [{ id: "s1", title: "Check numbers", completed: true }],
        })}
        today={TODAY}
        threadTitles={new Map([["t1", "Budget thread"]])}
        onUpdate={vi.fn()}
        onDelete={vi.fn()}
        onUnlinkThread={vi.fn()}
        onOpenThread={vi.fn()}
      />,
    );
    expect(html).toContain('value="Check numbers"');
    expect(html).toContain('aria-checked="true" aria-label="Mark step “Check numbers” not done"');
    expect(html).toContain('value="2026-11-26"');
    expect(html).toMatch(/class="todo-due">Today</);
    expect(html).toContain("Budget thread");
    expect(html).toContain('aria-label="Unlink “Budget thread”"');
    expect(html).toContain(">Conversation</button>");
    expect(html).toContain("Mention the budget");
  });
});

describe("FlagThreadButton", () => {
  it("offers to flag an unlinked thread", () => {
    const html = wrap(
      <FlagThreadButton todo={undefined} onFlag={vi.fn()} onOpenTodo={vi.fn()} />,
    );
    expect(html).toContain('aria-pressed="false"');
    expect(html).toContain("Add to Todos</button>");
  });

  it("points a flagged thread at its todo", () => {
    const html = wrap(
      <FlagThreadButton todo={todo("Reply to Dana")} compact onFlag={vi.fn()} onOpenTodo={vi.fn()} />,
    );
    expect(html).toContain('aria-pressed="true"');
    expect(html).toContain('aria-label="In Todos: open “Reply to Dana”"');
    expect(html).not.toContain("In Todos</button>");
  });
});
