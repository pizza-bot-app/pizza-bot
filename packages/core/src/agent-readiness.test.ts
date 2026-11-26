import { describe, expect, it } from "vitest";
import {
  BUILTIN_EVAL_TOOL_REF,
  evaluateAgentReadiness,
  projectAgentReadiness,
  type AgentCatalogEntry,
  type AgentReadinessContext,
} from "./index.js";

function agent(id: string, declaredTools: string[], skills: string[] = []): AgentCatalogEntry {
  return {
    id,
    name: id,
    description: id,
    systemPrompt: "",
    source: "user",
    declaredTools,
    skills,
    interruptOn: {},
  };
}

function context(overrides: Partial<AgentReadinessContext> = {}): AgentReadinessContext {
  return {
    catalog: {},
    tools: new Set(),
    mcpServers: new Map(),
    builtins: new Set([BUILTIN_EVAL_TOOL_REF]),
    skills: new Set(["calendar"]),
    ...overrides,
  };
}

describe("evaluateAgentReadiness", () => {
  it("makes dependency-free and available built-in skills ready immediately", () => {
    expect(evaluateAgentReadiness(agent("plain", []), context())).toEqual({ status: "ready" });
    expect(
      evaluateAgentReadiness(agent("analyst", [BUILTIN_EVAL_TOOL_REF]), context()),
    ).toEqual({ status: "ready" });
  });

  it("keeps a skill loading while its MCP server is loading", () => {
    expect(
      evaluateAgentReadiness(
        agent("mail", ["mcp:outlook:send"]),
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
      evaluateAgentReadiness(
        agent("mail", ["mcp:outlook:send", "mcp:outlook:search_*"]),
        ctx,
      ),
    ).toEqual({ status: "ready" });
    expect(
      evaluateAgentReadiness(agent("mail", ["mcp:outlook:delete"]), ctx),
    ).toEqual({ status: "unavailable", detail: "mcp:outlook:delete was not discovered" });
    expect(
      evaluateAgentReadiness(agent("mail", ["mcp:outlook:missing_*"]), ctx),
    ).toEqual({ status: "unavailable", detail: "mcp:outlook:missing_* matched no tools" });
  });

  it("requires every mounted skill to be enabled", () => {
    expect(evaluateAgentReadiness(agent("planner", [], ["calendar"]), context())).toEqual({ status: "ready" });
    expect(evaluateAgentReadiness(agent("planner", [], ["missing"]), context())).toEqual({
      status: "unavailable",
      detail: "skill missing is missing or disabled",
    });
  });

  it("projects only ready agents into the callable catalog", () => {
    const skills = new Map([
      ["plain", agent("plain", [])],
      ["mail", agent("mail", ["mcp:outlook:send"])],
    ]);
    const projected = projectAgentReadiness(
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
