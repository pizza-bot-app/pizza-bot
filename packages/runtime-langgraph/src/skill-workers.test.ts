import { describe, expect, it } from "vitest";
import {
  BUILTIN_EVAL_TOOL_REF,
  type SkillCatalog,
  type SkillCatalogEntry,
  type SkillInterruptOn,
} from "@pizza-bot/core";
import {
  codeInterpreterOptions,
  evalFilesystemWritable,
  resolveSkillSubagents,
} from "./index.js";

function folder(readOnly: boolean) {
  return {
    id: readOnly ? "docs" : "scratch",
    label: "grant",
    path: "/host/grant",
    virtualPath: "/local/grant",
    readOnly,
    createdAt: "2026-01-01T00:00:00.000Z",
  };
}

function skill(
  id: string,
  declaredTools: string[] = [],
  interruptOn: SkillInterruptOn = {},
): SkillCatalogEntry {
  return {
    id,
    name: id,
    description: `${id} description`,
    source: "user",
    declaredTools,
    interruptOn,
    files: [{
      path: `/skills/${id}/SKILL.md`,
      content: `---\nname: ${id}\ndescription: ${id} description\n---\n\nFollow ${id}.`,
    }],
  };
}

function catalog(...entries: SkillCatalogEntry[]): SkillCatalog {
  return new Map(entries.map((entry) => [entry.id, entry]));
}

describe("resolveSkillSubagents", () => {
  it("creates one explicitly tool-scoped worker per skill", async () => {
    const send = { name: "outlook__send" };
    const resolved = await resolveSkillSubagents(
      catalog(skill("mailer", ["mcp:outlook:send"]), skill("plain")),
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
    });
    expect(resolved![1]).toMatchObject({ name: "plain", tools: [] });
    expect(resolved![0]!.middleware?.map((middleware) => middleware.name)).toEqual([
      "ModelCallLimitMiddleware",
      "ToolCallLimitMiddleware",
      "subagentFinalization",
      "toolErrorRecovery",
      "outputTruncation",
      "DynamicSystemPromptMiddleware",
    ]);
  });

  it("requalifies skill-owned HITL policy to executable tool names", async () => {
    const resolved = await resolveSkillSubagents(
      catalog(skill(
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
    const resolved = await resolveSkillSubagents(
      catalog(skill(
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

  it("adds eval only to a skill that declares it", async () => {
    const resolved = await resolveSkillSubagents(
      catalog(skill("analyst", [BUILTIN_EVAL_TOOL_REF])),
      {},
    );
    expect(resolved![0]!.tools).toEqual([]);
    expect(resolved![0]!.middleware?.map((middleware) => middleware.name)).toEqual([
      "ModelCallLimitMiddleware",
      "ToolCallLimitMiddleware",
      "subagentFinalization",
      "toolErrorRecovery",
      "outputTruncation",
      "DynamicSystemPromptMiddleware",
      "CodeInterpreterMiddleware",
    ]);
  });

  it("never compiles a tool-dependent worker with missing or partial tools", async () => {
    const warnings: string[] = [];
    const resolved = await resolveSkillSubagents(
      catalog(
        skill("missing", ["mcp:outlook:archive"]),
        skill("partial", ["mcp:outlook:send", "mcp:outlook:delete"]),
        skill("plain"),
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

  it("returns no workers without skills", async () => {
    await expect(resolveSkillSubagents(undefined, {})).resolves.toBeUndefined();
  });
});

describe("eval capability", () => {
  it("enables task fan-out only for Pizza Bot", () => {
    expect(codeInterpreterOptions(false, false)).toMatchObject({ subagents: false });
    expect(codeInterpreterOptions(true, false)).toMatchObject({
      executionTimeoutMs: 120_000,
      subagents: true,
    });
  });

  it("bridges read-only filesystem tools until a writable target exists", () => {
    expect(codeInterpreterOptions(false, false).ptc).toEqual([
      "ls",
      "read_file",
      "glob",
      "grep",
    ]);
    expect(codeInterpreterOptions(false, true).ptc).toContain("write_file");
    expect(codeInterpreterOptions(false, true).ptc).toContain("edit_file");
  });

  it("never bridges MCP tools, which would escape a skill's interruptOn", () => {
    expect(codeInterpreterOptions(true, true).ptc.every((ref) => !ref.includes(":")))
      .toBe(true);
  });

  it("reads writability from live settings", () => {
    expect(evalFilesystemWritable({})).toBe(false);
    expect(evalFilesystemWritable({ localFolders: () => [folder(true)] })).toBe(false);
    expect(evalFilesystemWritable({ localFolders: () => [folder(true), folder(false)] }))
      .toBe(true);
    expect(evalFilesystemWritable({ memoriesDir: "/data/memories" })).toBe(true);
    expect(
      evalFilesystemWritable({ memoriesDir: "/data/memories", memoryEnabled: () => false }),
    ).toBe(false);
  });
});
