import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { Todo } from "@pizza-bot/core";
import type { AgentCatalogEntryInfo } from "@/api-client";
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
    history: [],
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
        agents={[]}
        automationsEnabled
        onUpdate={vi.fn()}
        onDelete={vi.fn()}
        onUnlinkThread={vi.fn()}
        onCheckIn={vi.fn()}
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

describe("agent-owned todos", () => {
  const researcher = {
    id: "researcher",
    name: "Researcher",
    description: "Finds sources.",
    source: "user",
    declaredTools: [],
    skills: [],
    interruptOn: {},
    enabled: true,
    status: "ready",
  } as unknown as AgentCatalogEntryInfo;
  const writer = { ...researcher, id: "writer", name: "Writer" } as AgentCatalogEntryInfo;
  const owned = todo("Renew passport", {
    owner: "researcher",
    checkIn: { cron: "0 9 * * 1-5", timezone: "UTC" },
    backgroundThreadId: "bg-1",
    history: [
      { id: "e1", at: "2026-11-20T09:00:00.000Z", kind: "assigned", actor: "user", agentId: "writer" },
      {
        id: "e2",
        at: "2026-11-21T09:00:00.000Z",
        kind: "assigned",
        actor: "writer",
        agentId: "researcher",
        note: "Needs office hours research",
      },
      { id: "e3", at: "2026-11-22T09:00:00.000Z", kind: "asked", actor: "researcher", threadId: "bg-1" },
    ],
  });

  function detail(fields: Partial<React.ComponentProps<typeof TodoDetail>> = {}): string {
    return wrap(
      <TodoDetail
        todo={owned}
        today={TODAY}
        threadTitles={new Map()}
        agents={[researcher, writer]}
        automationsEnabled
        onUpdate={vi.fn()}
        onDelete={vi.fn()}
        onUnlinkThread={vi.fn()}
        onCheckIn={vi.fn()}
        onOpenThread={vi.fn()}
        {...fields}
      />,
    );
  }

  it("shows the owner, its check-in preset, and the work-thread actions", () => {
    const html = detail();
    expect(html).toMatch(/<option value="researcher" selected="">Researcher<\/option>/);
    expect(html).toMatch(/<option value="0 9 \* \* 1-5" selected="">Weekday mornings<\/option>/);
    expect(html).toContain("Check in now");
    expect(html).toContain("Open work thread");
    expect(html).not.toContain("Check-ins are paused");
  });

  it("tells the user check-ins wait for Automations", () => {
    const html = detail({ automationsEnabled: false });
    expect(html).toContain("Check-ins are paused until Automations is turned on in Settings.");
    expect(html).toMatch(/<button type="button" class="btn-secondary" disabled="">.*Check in now/);
  });

  it("renders the timeline newest first, naming handoffs", () => {
    const html = detail();
    const asked = html.indexOf("Researcher asked you a question");
    const handoff = html.indexOf("Writer handed this to Researcher: Needs office hours research");
    const assigned = html.indexOf("You assigned this to Writer");
    expect(asked).toBeGreaterThan(-1);
    expect(asked).toBeLessThan(handoff);
    expect(handoff).toBeLessThan(assigned);
  });

  it("hides scheduling for the user's own todo", () => {
    const html = detail({ todo: todo("Mine") });
    expect(html).toMatch(/<option value="" selected="">Me<\/option>/);
    expect(html).not.toContain("Check in now");
    expect(html).not.toContain("Timeline");
  });

  it("marks an owned row with its agent and a waiting todo", () => {
    const html = wrap(
      <TodosModule
        todos={[owned, todo("Plain")]}
        threadTitles={new Map()}
        today={TODAY}
        agents={[researcher]}
        awaitingThreadIds={new Set(["bg-1"])}
        onCreate={vi.fn()}
        onUpdate={vi.fn()}
        onDelete={vi.fn()}
        onUnlinkThread={vi.fn()}
        onOpenThread={vi.fn()}
      />,
    );
    expect(html).toContain('title="Assigned to Researcher"');
    expect(html.match(/Waiting for you/g)).toHaveLength(1);
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
