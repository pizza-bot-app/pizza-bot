import { describe, it, expect } from "vitest";
import {
  buildAgentGeneratorPrompt,
  buildSkillGeneratorPrompt,
  normalizeAgentDraft,
  normalizeSkillDraft,
  parseSkillDraftJson,
  requiresApproval,
} from "./skill-generator.js";

const tools = [
  { ref: "builtin:eval", description: "Evaluate expressions." },
  { ref: "mcp:mcp-status:*", description: "All MCP Status tools." },
  { ref: "mcp:mcp-status:get_mcp_status", description: "Get MCP server status." },
  { ref: "mcp:outlook:search_email", description: "Search email." },
  { ref: "mcp:outlook:send_email", description: "Send email." },
];

describe("parseSkillDraftJson", () => {
  it("parses a bare JSON object", () => {
    expect(parseSkillDraftJson('{"name":"x"}')).toEqual({ name: "x" });
  });

  it("unwraps a ```json fenced object", () => {
    expect(parseSkillDraftJson('```json\n{"name":"x"}\n```')).toEqual({ name: "x" });
  });

  it("scans for the object when wrapped in prose", () => {
    expect(parseSkillDraftJson('Here you go:\n{"name":"x"}\nHope that helps!')).toEqual({ name: "x" });
  });

  it("throws when no object is present", () => {
    expect(() => parseSkillDraftJson("no json here")).toThrow();
  });
});

describe("normalizeSkillDraft", () => {
  it("returns a tool-free draft with sensible defaults", () => {
    expect(normalizeSkillDraft({ tools: ["builtin:eval"] })).toEqual({
      name: "New Skill",
      description: "New Skill",
      body: "",
    });
    expect(normalizeSkillDraft({ name: "S", description: "d", body: "b" })).toEqual({
      name: "S",
      description: "d",
      body: "b",
    });
  });
});

describe("normalizeAgentDraft", () => {
  it("keeps only refs in the allowed set (plus builtin:eval) and dedupes", () => {
    const draft = normalizeAgentDraft(
      {
        name: "S",
        description: "d",
        body: "b",
        tools: [
          "mcp:mcp-status:get_mcp_status",
          "builtin:eval",
          "mcp:evil:rm",
          "mcp:mcp-status:get_mcp_status",
        ],
      },
      tools,
    );
    expect(draft.declaredTools).toEqual(["mcp:mcp-status:get_mcp_status", "builtin:eval"]);
    expect(draft.interruptOn).toEqual({});
  });

  it("falls back to sensible defaults for missing fields", () => {
    expect(normalizeAgentDraft({}, tools)).toEqual({
      name: "New Agent",
      description: "New Agent",
      body: "",
      declaredTools: [],
      interruptOn: {},
    });
  });

  it("adds the standard approval policy only to selected side-effect tools", () => {
    const draft = normalizeAgentDraft(
      { name: "Mail", tools: ["mcp:outlook:search_email", "mcp:outlook:send_email"] },
      tools,
    );
    expect(draft.interruptOn).toEqual({
      "mcp:outlook:send_email": { allowedDecisions: ["approve", "edit", "reject"] },
    });
  });
});

describe("buildSkillGeneratorPrompt", () => {
  it("asks for a playbook without tool grants", () => {
    const prompt = buildSkillGeneratorPrompt();
    expect(prompt).toContain('"body"');
    expect(prompt).not.toContain('"tools"');
  });
});

describe("buildAgentGeneratorPrompt", () => {
  it("lists available tool descriptions and directs the model not to omit relevant tools", () => {
    const prompt = buildAgentGeneratorPrompt(tools);
    expect(prompt).toContain("- mcp:mcp-status:get_mcp_status: Get MCP server status.");
    expect(prompt).toContain("do not omit a tool the workflow needs");
  });
});

describe("requiresApproval", () => {
  it.each([
    ["mcp:outlook:send_email", true],
    ["mcp:outlook:deleteMessage", true],
    ["mcp:github:merge_pull_request", true],
    ["mcp:payments:transfer_funds", true],
    ["mcp:iam:grant_access", true],
    ["mcp:builds:trigger_job", true],
    ["mcp:outlook:search_email", false],
    ["mcp:github:list_pull_requests", false],
    ["mcp:files:read_file", false],
    ["builtin:eval", false],
    ["mcp:outlook:*", true],
  ])("classifies %s", (ref, expected) => {
    expect(requiresApproval(ref)).toBe(expected);
  });
});
