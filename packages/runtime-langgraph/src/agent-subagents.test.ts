import { describe, expect, it } from "vitest";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import {
  BUILTIN_EVAL_TOOL_REF,
  type AgentCatalog,
  type AgentCatalogEntry,
  type InterruptOnPolicy,
  type RuntimeDeps,
  type SkillCatalog,
} from "@pizza-bot/core";
import { buildBackend } from "./backend.js";
import { codeInterpreterOptions, resolveAgentSubagents } from "./index.js";

const conversationModel = { id: "conversation" } as unknown as BaseChatModel;

function agent(
  id: string,
  declaredTools: string[] = [],
  interruptOn: InterruptOnPolicy = {},
  skills: string[] = [],
): AgentCatalogEntry {
  return {
    id,
    name: id,
    description: `${id} description`,
    systemPrompt: `Follow ${id}.`,
    source: "user",
    declaredTools,
    skills,
    interruptOn,
  };
}

function catalog(...entries: AgentCatalogEntry[]): AgentCatalog {
  return new Map(entries.map((entry) => [entry.id, entry]));
}

function resolve(agents: AgentCatalog | undefined, deps: RuntimeDeps = {}) {
  const full = { model: conversationModel, ...deps };
  return resolveAgentSubagents(agents, full, buildBackend({ ...(full.skills ? { skills: full.skills } : {}) }));
}

const calendarSkills: SkillCatalog = new Map([[
  "calendar",
  {
    id: "calendar",
    name: "calendar",
    description: "Read the calendar.",
    source: "user",
    files: [{
      path: "/skills/calendar/SKILL.md",
      content: "---\nname: calendar\ndescription: Read the calendar.\n---\n\nUse the tools.",
    }],
  },
]]);

describe("resolveAgentSubagents", () => {
  it("creates one explicitly tool-scoped worker per skill", async () => {
    const send = { name: "outlook__send" };
    const resolved = await resolve(
      catalog(agent("mailer", ["mcp:outlook:send"]), agent("plain")),
      {
        tools: { "mcp:outlook:send": send },
        catalog: { outlook: ["send"] },
      },
    );

    expect(resolved).toHaveLength(2);
    expect(resolved![0]).toMatchObject({
      name: "mailer",
      tools: [send],
      systemPrompt: "Follow mailer.",
      model: conversationModel,
    });
    expect(resolved![1]).toMatchObject({ name: "plain", tools: [] });
    expect(resolved![0]!.middleware?.map((middleware) => middleware.name)).toEqual([
      "FilesystemMiddleware",
      "ModelCallLimitMiddleware",
      "ToolCallLimitMiddleware",
      "subagentFinalization",
      "structuredResponse",
      "toolErrorRecovery",
      "outputTruncation",
      "DynamicSystemPromptMiddleware",
    ]);
  });

  it("requalifies agent-owned HITL policy to executable tool names", async () => {
    const resolved = await resolve(
      catalog(agent(
        "mailer",
        ["mcp:outlook:send"],
        { "mcp:outlook:send": { allowedDecisions: ["approve", "edit", "reject"] } },
      )),
      {
        tools: { "mcp:outlook:send": { name: "outlook__send" } },
        catalog: { outlook: ["send"] },
      },
    );

    expect(resolved![0]!.interruptOn).toEqual({
      outlook__send: { allowedDecisions: ["approve", "edit", "reject"] },
    });
  });

  it("expands wildcard HITL policy to every granted executable tool", async () => {
    const resolved = await resolve(
      catalog(agent(
        "mailer",
        ["mcp:outlook:*"],
        { "mcp:outlook:*": { allowedDecisions: ["approve", "reject"] } },
      )),
      {
        tools: {
          "mcp:outlook:send": { name: "outlook__send" },
          "mcp:outlook:delete": { name: "outlook__delete" },
        },
        catalog: { outlook: ["send", "delete"] },
      },
    );

    expect(resolved![0]!.interruptOn).toEqual({
      outlook__send: { allowedDecisions: ["approve", "reject"] },
      outlook__delete: { allowedDecisions: ["approve", "reject"] },
    });
  });

  it("asks first for a tool if any overlapping ref asks, keeping only the decisions they share", async () => {
    const resolved = await resolve(
      catalog(agent(
        "notes",
        ["mcp:notes:*", "mcp:notes:list_*", "mcp:notes:delete_note"],
        {
          "mcp:notes:*": { allowedDecisions: ["approve", "edit", "reject"] },
          "mcp:notes:list_*": false,
          "mcp:notes:delete_note": { allowedDecisions: ["approve", "reject", "respond"] },
        },
      )),
      {
        tools: {
          "mcp:notes:list_notes": { name: "notes__list_notes" },
          "mcp:notes:read_note": { name: "notes__read_note" },
          "mcp:notes:delete_note": { name: "notes__delete_note" },
        },
        catalog: { notes: ["list_notes", "read_note", "delete_note"] },
      },
    );

    expect(resolved![0]!.interruptOn).toEqual({
      notes__list_notes: { allowedDecisions: ["approve", "edit", "reject"] },
      notes__read_note: { allowedDecisions: ["approve", "edit", "reject"] },
      notes__delete_note: { allowedDecisions: ["approve", "reject"] },
    });
  });

  it("narrows true to the explicit decisions and never leaves an overlap with none", async () => {
    const resolved = await resolve(
      catalog(agent(
        "notes",
        ["mcp:notes:*"],
        {
          "mcp:notes:*": true,
          "mcp:notes:read_note": { allowedDecisions: ["edit"] },
          "mcp:notes:delete_note": { allowedDecisions: ["approve", "edit"] },
          "mcp:notes:list_*": { allowedDecisions: ["respond"] },
          "mcp:notes:list_notes": { allowedDecisions: ["edit"] },
        },
      )),
      {
        tools: {
          "mcp:notes:list_notes": { name: "notes__list_notes" },
          "mcp:notes:read_note": { name: "notes__read_note" },
          "mcp:notes:delete_note": { name: "notes__delete_note" },
        },
        catalog: { notes: ["list_notes", "read_note", "delete_note"] },
      },
    );

    expect(resolved![0]!.interruptOn).toEqual({
      notes__list_notes: { allowedDecisions: ["approve", "reject"] },
      notes__read_note: { allowedDecisions: ["edit"] },
      notes__delete_note: { allowedDecisions: ["approve", "edit"] },
    });
  });

  it("adds eval only to an agent that declares it", async () => {
    const resolved = await resolve(
      catalog(agent("analyst", [BUILTIN_EVAL_TOOL_REF])),
    );
    expect(resolved![0]!.tools).toEqual([]);
    expect(resolved![0]!.middleware?.map((middleware) => middleware.name)).toEqual([
      "FilesystemMiddleware",
      "ModelCallLimitMiddleware",
      "ToolCallLimitMiddleware",
      "subagentFinalization",
      "structuredResponse",
      "toolErrorRecovery",
      "outputTruncation",
      "DynamicSystemPromptMiddleware",
      "CodeInterpreterMiddleware",
    ]);
  });

  it("never compiles a tool-dependent worker with missing or partial tools", async () => {
    const warnings: string[] = [];
    const resolved = await resolve(
      catalog(
        agent("missing", ["mcp:outlook:archive"]),
        agent("partial", ["mcp:outlook:send", "mcp:outlook:delete"]),
        agent("plain"),
      ),
      {
        tools: { "mcp:outlook:send": { name: "outlook__send" } },
        catalog: { outlook: ["send"] },
        logger: {
          info: () => {},
          warn: (message) => warnings.push(message),
          error: () => {},
          debug: () => {},
        },
      },
    );

    expect(resolved?.map((worker) => worker.name)).toEqual(["plain"]);
    expect(warnings).toHaveLength(2);
  });

  it("returns no workers without agents", async () => {
    await expect(resolve(undefined)).resolves.toBeUndefined();
  });

  it("uses an agent's pinned model and inherits the conversation model otherwise", async () => {
    const pinned = { id: "pinned" } as unknown as BaseChatModel;
    const resolved = await resolve(catalog(agent("fast"), agent("plain")), {
      agentModels: new Map([["fast", pinned]]),
    });
    expect(resolved?.map((worker) => [worker.name, worker.model])).toEqual([
      ["fast", pinned],
      ["plain", conversationModel],
    ]);
  });

  it("mounts an agent's skills on its own skills middleware", async () => {
    const resolved = await resolve(
      catalog(agent("planner", [], {}, ["calendar"]), agent("plain")),
      { skills: calendarSkills },
    );
    const names = (index: number) =>
      resolved![index]!.middleware?.map((middleware) => middleware.name).slice(0, 2);
    expect(names(0)).toEqual(["FilesystemMiddleware", "SkillsMiddleware"]);
    expect(names(1)).toEqual(["FilesystemMiddleware", "ModelCallLimitMiddleware"]);
  });

  it("falls back to the description when the agent has no prompt body", async () => {
    const resolved = await resolve(catalog({ ...agent("terse"), systemPrompt: "" }));
    expect(resolved![0]!.systemPrompt).toBe("terse description");
  });
});

describe("eval capability", () => {
  it("enables task fan-out only for Pizza Bot", () => {
    expect(codeInterpreterOptions(false)).toMatchObject({ subagents: false });
    expect(codeInterpreterOptions(true)).toMatchObject({ subagents: true });
  });

  it("bridges the filesystem tools, reads and writes alike", () => {
    expect(codeInterpreterOptions(false).ptc).toEqual([
      "ls",
      "read_file",
      "glob",
      "grep",
      "write_file",
      "edit_file",
    ]);
  });

  it("keeps the bounds a paging loop depends on", () => {
    expect(codeInterpreterOptions(true)).toMatchObject({
      maxResultChars: 8_000,
      executionTimeoutMs: 120_000,
    });
  });
});
