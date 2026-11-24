import { describe, expect, it } from "vitest";
import {
  BUILTIN_EVAL_TOOL_REF,
  evaluateSkillReadiness,
  parseDeclaredTools,
  projectSkillReadiness,
  type SkillCatalogEntry,
  type SkillReadinessContext,
} from "./index.js";

function skill(id: string, declaredTools: string[]): SkillCatalogEntry {
  return {
    id,
    name: id,
    description: id,
    source: "user",
    declaredTools,
    interruptOn: {},
    files: [],
  };
}

function context(overrides: Partial<SkillReadinessContext> = {}): SkillReadinessContext {
  return {
    catalog: {},
    tools: new Set(),
    mcpServers: new Map(),
    builtins: new Set([BUILTIN_EVAL_TOOL_REF]),
    ...overrides,
  };
}

describe("evaluateSkillReadiness", () => {
  it("makes dependency-free and available built-in skills ready immediately", () => {
    expect(evaluateSkillReadiness(skill("plain", []), context())).toEqual({ status: "ready" });
    expect(
      evaluateSkillReadiness(skill("analyst", [BUILTIN_EVAL_TOOL_REF]), context()),
    ).toEqual({ status: "ready" });
  });

  it("names allowed-tools entries outside the ref vocabulary as unsupported", () => {
    const declaredTools = parseDeclaredTools({ "allowed-tools": "Bash(git add:*) Read" });
    expect(evaluateSkillReadiness(skill("claude-code", declaredTools), context())).toEqual({
      status: "unavailable",
      detail: "Bash(git add:*) is a Claude Code tool Pizza Bot doesn't support",
    });
    for (const ref of ["Read", "WebFetch"]) {
      expect(evaluateSkillReadiness(skill("reader", [ref]), context())).toEqual({
        status: "unavailable",
        detail: `${ref} is a Claude Code tool Pizza Bot doesn't support`,
      });
    }
  });

  it("leaves a skill unavailable when a declared ref contains whitespace", () => {
    const ctx = context({
      catalog: { srv: ["my tool"] },
      tools: new Set(["mcp:srv:my tool"]),
      mcpServers: new Map([["srv", { status: "ready" }]]),
    });
    expect(evaluateSkillReadiness(skill("spaced", ["mcp:srv:my tool"]), ctx)).toEqual({
      status: "unavailable",
      detail: "mcp:srv:my tool is invalid",
    });
  });

  it("keeps a skill loading while its MCP server is loading", () => {
    expect(
      evaluateSkillReadiness(
        skill("mail", ["mcp:outlook:send"]),
        context({ mcpServers: new Map([["outlook", { status: "loading" }]]) }),
      ),
    ).toEqual({ status: "loading", detail: "outlook is still loading" });
  });

  it("requires every explicit tool and every wildcard to resolve", () => {
    const ctx = context({
      catalog: { outlook: ["send", "search_mail"] },
      tools: new Set(["mcp:outlook:send", "mcp:outlook:search_mail"]),
      mcpServers: new Map([["outlook", { status: "ready" }]]),
    });
    expect(
      evaluateSkillReadiness(
        skill("mail", ["mcp:outlook:send", "mcp:outlook:search_*"]),
        ctx,
      ),
    ).toEqual({ status: "ready" });
    expect(
      evaluateSkillReadiness(skill("mail", ["mcp:outlook:delete"]), ctx),
    ).toEqual({ status: "unavailable", detail: "mcp:outlook:delete was not discovered" });
    expect(
      evaluateSkillReadiness(skill("mail", ["mcp:outlook:missing_*"]), ctx),
    ).toEqual({ status: "unavailable", detail: "mcp:outlook:missing_* matched no tools" });
  });

  it("projects only ready skills into the callable catalog", () => {
    const skills = new Map([
      ["plain", skill("plain", [])],
      ["mail", skill("mail", ["mcp:outlook:send"])],
    ]);
    const projected = projectSkillReadiness(
      skills,
      context({ mcpServers: new Map([["outlook", { status: "loading" }]]) }),
    );
    expect([...projected.ready.keys()]).toEqual(["plain"]);
    expect(projected.availability).toEqual([
      { id: "plain", name: "plain", status: "ready" },
      { id: "mail", name: "mail", status: "loading", detail: "outlook is still loading" },
    ]);
  });
});
