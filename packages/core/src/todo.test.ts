import { describe, expect, it } from "vitest";
import { isTodoDueDate, todoCreateSchema, todoPatchSchema } from "./todo.js";
import { pizzaBotSystemPrompt, PIZZA_BOT_TODO_PROMPT } from "./agent.js";

describe("isTodoDueDate", () => {
  it("accepts real calendar dates only", () => {
    expect(isTodoDueDate("2028-02-29")).toBe(true);
    expect(isTodoDueDate("2026-02-29")).toBe(false);
    expect(isTodoDueDate("2026-13-01")).toBe(false);
    expect(isTodoDueDate("2026-1-01")).toBe(false);
    expect(isTodoDueDate("2026-01-01T00:00:00Z")).toBe(false);
    expect(isTodoDueDate("0002-11-26")).toBe(false);
    expect(isTodoDueDate("3000-01-01")).toBe(false);
  });
});

describe("Todo schemas", () => {
  it("trims titles and rejects blank ones", () => {
    expect(todoCreateSchema.parse({ title: "  Call mom " }).title).toBe("Call mom");
    expect(todoCreateSchema.safeParse({ title: "   " }).success).toBe(false);
    expect(todoPatchSchema.safeParse({ title: "" }).success).toBe(false);
  });

  it("lets a patch clear the due date but not set a malformed one", () => {
    expect(todoPatchSchema.parse({ dueDate: null }).dueDate).toBeNull();
    expect(todoPatchSchema.safeParse({ dueDate: "tomorrow" }).success).toBe(false);
  });
});

describe("Todo prompt guidance", () => {
  it("appears only when the Todo tools are registered", () => {
    expect(pizzaBotSystemPrompt({ memories: false, subagents: false, todos: true })).toContain(PIZZA_BOT_TODO_PROMPT);
    expect(pizzaBotSystemPrompt({ memories: false, subagents: false })).not.toContain(PIZZA_BOT_TODO_PROMPT);
  });
});
