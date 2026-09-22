import { describe, expect, it } from "vitest";
import {
  agentMcpServerIds,
  parseAgentModel,
  parseAgentSkills,
  parseDeclaredTools,
  parseInterruptOn,
} from "./agent-definition.js";

describe("agentMcpServerIds", () => {
  it("deduplicates exact and wildcard references by server", () => {
    expect(
      agentMcpServerIds({
        declaredTools: ["mcp:mail:send", "mcp:mail:*", "builtin:eval", "mcp:calendar:list"],
      }),
    ).toEqual(["mail", "calendar"]);
  });
});

describe("parseDeclaredTools", () => {
  it("reads a list or a comma/whitespace string, deduped", () => {
    expect(parseDeclaredTools({ tools: ["mcp:a:x", "mcp:b:y"] })).toEqual(["mcp:a:x", "mcp:b:y"]);
    expect(parseDeclaredTools({ tools: "a, b  a" })).toEqual(["a", "b"]);
  });

  it("ignores non-string entries and unusable values", () => {
    expect(parseDeclaredTools({ tools: ["x", 3, null, "y"] as unknown[] })).toEqual(["x", "y"]);
    expect(parseDeclaredTools({})).toEqual([]);
    expect(parseDeclaredTools({ tools: 42 })).toEqual([]);
  });
});

describe("parseAgentSkills", () => {
  it("reads a list or a comma string", () => {
    expect(parseAgentSkills({ skills: ["calendar", "email"] })).toEqual(["calendar", "email"]);
    expect(parseAgentSkills({ skills: "calendar, email" })).toEqual(["calendar", "email"]);
  });
});

describe("parseAgentModel", () => {
  it("treats an absent, blank, or inherit model as the conversation model", () => {
    expect(parseAgentModel({})).toBeUndefined();
    expect(parseAgentModel({ model: " " })).toBeUndefined();
    expect(parseAgentModel({ model: "inherit" })).toBeUndefined();
    expect(parseAgentModel({ model: 3 })).toBeUndefined();
  });

  it("keeps a pinned model id verbatim", () => {
    expect(parseAgentModel({ model: "anthropic:claude-haiku-4-5" })).toBe("anthropic:claude-haiku-4-5");
  });
});

describe("parseInterruptOn", () => {
  it("reads boolean and decision-list policies", () => {
    expect(
      parseInterruptOn({
        interruptOn: {
          "mcp:mail:send": { allowedDecisions: ["approve", "edit", "reject"] },
          "mcp:calendar:create_event": true,
        },
      }),
    ).toEqual({
      "mcp:mail:send": { allowedDecisions: ["approve", "edit", "reject"] },
      "mcp:calendar:create_event": true,
    });
  });

  it("drops invalid refs and unsupported decisions", () => {
    expect(
      parseInterruptOn({
        interruptOn: {
          "mcp:test:valid": { allowedDecisions: ["approve", "unknown", "reject"] },
          "builtin:eval": true,
          "not-a-ref": true,
        },
      }),
    ).toEqual({ "mcp:test:valid": { allowedDecisions: ["approve", "reject"] } });
  });

  it("fails closed when a valid ref has no usable decision", () => {
    expect(
      parseInterruptOn({
        interruptOn: {
          "mcp:test:empty": { allowedDecisions: ["unknown"] },
          "mcp:test:malformed": "yes",
        },
      }),
    ).toEqual({
      "mcp:test:empty": { allowedDecisions: ["approve", "edit", "reject"] },
      "mcp:test:malformed": { allowedDecisions: ["approve", "edit", "reject"] },
    });
  });

  it("reads verifiedArgs, dedupes, and omits the key when absent", () => {
    expect(
      parseInterruptOn({
        interruptOn: {
          "mcp:outlook:send_email": {
            allowedDecisions: ["approve", "edit"],
            verifiedArgs: ["body", "body", " subject "],
          },
          "mcp:outlook:reply": { allowedDecisions: ["approve"] },
        },
      }),
    ).toEqual({
      "mcp:outlook:send_email": {
        allowedDecisions: ["approve", "edit"],
        verifiedArgs: ["body", "subject"],
      },
      "mcp:outlook:reply": { allowedDecisions: ["approve"] },
    });
  });

  it("ignores unusable verifiedArgs rather than failing the whole policy", () => {
    expect(
      parseInterruptOn({
        interruptOn: {
          "mcp:test:a": { allowedDecisions: ["approve"], verifiedArgs: [42, null, "body"] },
          "mcp:test:b": { allowedDecisions: ["approve"], verifiedArgs: "subject, body" },
          "mcp:test:c": { allowedDecisions: ["approve"], verifiedArgs: 7 },
        },
      }),
    ).toEqual({
      "mcp:test:a": { allowedDecisions: ["approve"], verifiedArgs: ["body"] },
      "mcp:test:b": { allowedDecisions: ["approve"], verifiedArgs: ["subject", "body"] },
      "mcp:test:c": { allowedDecisions: ["approve"] },
    });
  });
});
