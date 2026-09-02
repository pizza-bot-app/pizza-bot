import { describe, expect, it } from "vitest";
import { FakeChatModel } from "@langchain/core/utils/testing";
import {
  TASK_USAGE_NOTES,
  taskDispatchMiddleware,
  taskToolDescription,
} from "./task-dispatch-middleware.js";

const worker = { name: "mailer", description: "Sends mail." };

function toolNames(middleware: unknown): string[] {
  const tools = (middleware as { tools?: Array<{ name?: unknown }> }).tools ?? [];
  return tools.map((tool) => String(tool.name));
}

describe("taskToolDescription", () => {
  it("rosters the workers and states the routing notes", () => {
    const description = taskToolDescription([worker, { name: "notes", description: "Reads notes." }]);
    expect(description).toContain("- mailer: Sends mail.");
    expect(description).toContain("- notes: Reads notes.");
    expect(description).toContain(TASK_USAGE_NOTES);
  });

  it("offers no general-purpose worker", () => {
    expect(taskToolDescription([worker])).not.toContain("general-purpose");
  });

  // These notes are the only place the dispatch contract is stated, so they have
  // to carry it in full.
  it("routes without briefing, inventing, or summarizing", () => {
    expect(TASK_USAGE_NOTES).toContain("it does not brief the worker");
    expect(TASK_USAGE_NOTES).toContain("copy them verbatim when they stand on their own");
    expect(TASK_USAGE_NOTES).toContain(
      "Do not specify an output format, field list, length, tone, time range, or " +
        "acceptance criteria the user did not ask for",
    );
    expect(TASK_USAGE_NOTES).toContain("keep each item's original wording");
    expect(TASK_USAGE_NOTES).toContain(
      "reproduce it in your reply with its formatting intact rather than summarizing it",
    );
  });
});

describe("taskDispatchMiddleware", () => {
  it("replaces DeepAgents' own subagent middleware by name", () => {
    const middleware = taskDispatchMiddleware({
      model: new FakeChatModel({}),
      subagents: [worker as never],
    });
    expect((middleware as { name: string }).name).toBe("subAgentMiddleware");
    expect(toolNames(middleware)).toEqual(["task"]);
  });

  it("describes the task tool itself rather than editing upstream's text", () => {
    const middleware = taskDispatchMiddleware({
      model: new FakeChatModel({}),
      subagents: [worker as never],
    });
    const task = (middleware as { tools: Array<{ description?: unknown }> }).tools[0];
    expect(task?.description).toBe(taskToolDescription([worker]));
  });

  it("withholds the task tool when no worker can receive a dispatch", () => {
    expect(toolNames(taskDispatchMiddleware({ model: new FakeChatModel({}), subagents: [] })))
      .toEqual([]);
    expect(toolNames(taskDispatchMiddleware({ subagents: [worker as never] }))).toEqual([]);
  });
});
