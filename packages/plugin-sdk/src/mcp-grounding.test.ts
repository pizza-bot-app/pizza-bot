import { describe, expect, it } from "vitest";
import { GROUNDING_ARGUMENT } from "@pizza-bot/core";
import {
  injectGroundingArgument,
  resolvableVerifiedArgs,
  stripGroundingArgument,
  stripGroundingFromInvocation,
} from "./mcp-grounding.js";
import { restoreFlattenedUnions } from "./mcp-schema.js";

const sendMail = {
  type: "object",
  properties: {
    to: { type: "string" },
    subject: { type: "string" },
    body: { type: "string" },
  },
  required: ["to", "body"],
  additionalProperties: false,
};

function groundingOf(schema: unknown): Record<string, unknown> {
  const properties = (schema as { properties: Record<string, unknown> }).properties;
  return properties[GROUNDING_ARGUMENT] as Record<string, unknown>;
}

describe("injectGroundingArgument", () => {
  it("adds an optional array argument constrained to the verified args", () => {
    const injected = injectGroundingArgument(sendMail, ["body", "subject"]);
    const grounding = groundingOf(injected);
    expect(grounding.type).toBe("array");
    const item = grounding.items as { properties: Record<string, { enum?: string[] }>; required: string[] };
    expect(item.properties.arg?.enum).toEqual(["body", "subject"]);
    expect(item.required).toEqual(["arg", "text", "cites"]);
    // Citing is optional; a required argument would make an uncited draft impossible.
    expect((injected as { required: string[] }).required).toEqual(["to", "body"]);
  });

  it("does not describe offsets, only a verbatim quote", () => {
    const item = groundingOf(injectGroundingArgument(sendMail, ["body"])).items as {
      properties: Record<string, unknown>;
    };
    expect(Object.keys(item.properties)).toEqual(["arg", "text", "cites"]);
  });

  it("leaves the schema alone when there is nothing to cite", () => {
    expect(injectGroundingArgument(sendMail, [])).toBe(sendMail);
    expect(injectGroundingArgument(sendMail, ["nonexistent"])).toBe(sendMail);
    expect(injectGroundingArgument({ type: "string" }, ["body"])).toEqual({ type: "string" });
  });

  it("narrows to the verified args the tool actually declares", () => {
    const item = groundingOf(injectGroundingArgument(sendMail, ["body", "nonexistent"])).items as {
      properties: Record<string, { enum?: string[] }>;
    };
    expect(item.properties.arg?.enum).toEqual(["body"]);
  });

  it("yields to a server that already owns the name", () => {
    const owned = {
      ...sendMail,
      properties: { ...sendMail.properties, [GROUNDING_ARGUMENT]: { type: "string" } },
    };
    expect(injectGroundingArgument(owned, ["body"])).toBe(owned);
  });

  it("does not mutate the input schema", () => {
    const before = JSON.stringify(sendMail);
    injectGroundingArgument(sendMail, ["body"]);
    expect(JSON.stringify(sendMail)).toBe(before);
  });
});

/**
 * The adapted schema is the only viable injection point: union restoration builds
 * from it and only rewrites properties already present, so a source-side injection
 * is silently dropped.
 */
describe("injection survives union restoration", () => {
  const source = {
    type: "object",
    properties: {
      body: { type: "string" },
      priority: { anyOf: [{ type: "string", enum: ["low", "high"] }, { type: "integer" }] },
    },
    additionalProperties: false,
  };
  const adapted = {
    type: "object",
    properties: {
      body: { type: "string" },
      priority: { description: "flattened by the adapter" },
    },
    additionalProperties: false,
  };

  it("keeps the argument when injected into the adapted schema before restoring", () => {
    const restored = restoreFlattenedUnions(injectGroundingArgument(adapted, ["body"]), source);
    expect(groundingOf(restored)).toBeDefined();
    // Restoration still did its own job.
    expect((restored as { properties: { priority: { anyOf?: unknown[] } } }).properties.priority.anyOf)
      .toHaveLength(2);
  });

  it("keeps the argument when injected after restoring", () => {
    const restored = restoreFlattenedUnions(adapted, source);
    expect(groundingOf(injectGroundingArgument(restored, ["body"]))).toBeDefined();
  });

  it("loses the argument when injected into the source schema", () => {
    const restored = restoreFlattenedUnions(adapted, injectGroundingArgument(source, ["body"]));
    expect((restored as { properties: Record<string, unknown> }).properties)
      .not.toHaveProperty(GROUNDING_ARGUMENT);
  });
});

describe("resolvableVerifiedArgs", () => {
  it("keeps only declared properties", () => {
    expect(resolvableVerifiedArgs(sendMail, ["body", "nope", "subject"])).toEqual(["body", "subject"]);
    expect(resolvableVerifiedArgs({ type: "string" }, ["body"])).toEqual([]);
  });
});

describe("stripGroundingArgument", () => {
  const spans = [{ arg: "body", text: "a 20% credit", cites: [{ evidenceId: "ev-2", lines: [1] }] }];

  it("removes the key without mutating the source", () => {
    const args = { to: "x@example.com", body: "…", [GROUNDING_ARGUMENT]: spans };
    expect(stripGroundingArgument(args)).toEqual({ to: "x@example.com", body: "…" });
    // The persisted tool call is this same object; the reviewer's citations live there.
    expect(args[GROUNDING_ARGUMENT]).toBe(spans);
  });

  it("returns the input untouched when the key is absent", () => {
    const args = { body: "…" };
    expect(stripGroundingArgument(args)).toBe(args);
  });
});

describe("stripGroundingFromInvocation", () => {
  it("reaches into a wrapped ToolCall's args", () => {
    const call = {
      type: "tool_call",
      id: "call_1",
      name: "outlook__send_mail",
      args: { body: "…", [GROUNDING_ARGUMENT]: [] },
    };
    const stripped = stripGroundingFromInvocation(call) as typeof call;
    expect(stripped.args).not.toHaveProperty(GROUNDING_ARGUMENT);
    expect(stripped.id).toBe("call_1");
    expect(call.args).toHaveProperty(GROUNDING_ARGUMENT);
  });

  it("also accepts a bare arguments object", () => {
    expect(stripGroundingFromInvocation({ body: "…", [GROUNDING_ARGUMENT]: [] }))
      .toEqual({ body: "…" });
  });

  it("passes through anything else unchanged", () => {
    expect(stripGroundingFromInvocation("text")).toBe("text");
    const clean = { type: "tool_call", args: { body: "…" } };
    expect(stripGroundingFromInvocation(clean)).toBe(clean);
  });
});
