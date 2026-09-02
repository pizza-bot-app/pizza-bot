import { describe, expect, it } from "vitest";
import {
  PIZZA_BOT_AGENT,
  PIZZA_BOT_MEMORY_PROMPT,
  pizzaBotSystemPrompt,
} from "./agent.js";

describe("PIZZA_BOT_AGENT", () => {
  it("is the application's static top-level identity", () => {
    expect(PIZZA_BOT_AGENT).toMatchObject({
      id: "pizza-bot",
      name: "Pizza Bot",
      avatar: "🍕",
    });
    expect(PIZZA_BOT_AGENT.systemPrompt).toContain("skill-scoped subagents");
    expect(PIZZA_BOT_AGENT.systemPrompt).toContain(
      "task({ description, subagent_type })",
    );
    expect(PIZZA_BOT_AGENT.systemPrompt).toContain(
      "names and descriptions in that tool",
    );
    expect(PIZZA_BOT_AGENT.systemPrompt).toContain(
      "delegate directly without reading its SKILL.md first",
    );
    expect(PIZZA_BOT_AGENT.systemPrompt).toContain(
      "worker already receives its full skill instructions",
    );
    expect(PIZZA_BOT_AGENT.systemPrompt).toContain(
      "task({ description, subagentType })",
    );
    expect(PIZZA_BOT_AGENT.systemPrompt).toContain(
      "only the direct tool uses snake_case `subagent_type`",
    );
    expect(PIZZA_BOT_AGENT.systemPrompt).toContain(
      "do not normalize their case, punctuation, or percent escapes",
    );
    expect(PIZZA_BOT_AGENT.systemPrompt).toContain(
      "`eval` interpreter is computation-only",
    );
    expect(PIZZA_BOT_AGENT.systemPrompt).toContain(
      "Never offer or claim an operation unless a matching tool is available",
    );
    expect(PIZZA_BOT_AGENT.systemPrompt).toContain(
      "claim completion only after its tool call succeeds",
    );
    expect(PIZZA_BOT_AGENT.systemPrompt).not.toContain("in your own words");
    expect(PIZZA_BOT_AGENT.systemPrompt).not.toContain("write_todos");
    expect(PIZZA_BOT_AGENT.systemPrompt).not.toContain(
      "when a task matches one, read its SKILL.md",
    );
  });

  // The dispatch contract belongs to the `task` tool description, and repeating
  // it here would cost tokens without reinforcing anything.
  it("leaves the routing and relay contract to the task tool description", () => {
    for (const duplicated of ["ROUTING", "RELAY", "verbatim", "output format"]) {
      expect(PIZZA_BOT_AGENT.systemPrompt).not.toContain(duplicated);
    }
  });

  it("includes durable memory instructions only when memory is enabled", () => {
    expect(pizzaBotSystemPrompt(false)).not.toContain(PIZZA_BOT_MEMORY_PROMPT);
    expect(pizzaBotSystemPrompt(false)).not.toContain("/memories/");
    expect(pizzaBotSystemPrompt(true)).toContain(PIZZA_BOT_MEMORY_PROMPT);
  });
});
