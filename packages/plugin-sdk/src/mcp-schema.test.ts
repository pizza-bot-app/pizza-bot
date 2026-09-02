import { DynamicStructuredTool } from "@langchain/core/tools";
import { describe, expect, it } from "vitest";
import { restoreFlattenedUnions } from "./mcp-schema.js";

/**
 * The filter shape common to record-search MCP tools: a recursive definition
 * whose two branches are a leaf comparison and a compound group.
 */
const filterSource = {
  type: "object",
  properties: {
    queryTerm: { type: "string" },
    condition: {
      allOf: [
        { description: "simple or compound conditions", $ref: "#/definitions/__schema0" },
      ],
    },
  },
  $schema: "http://json-schema.org/draft-07/schema#",
  additionalProperties: false,
  definitions: {
    __schema0: {
      anyOf: [
        {
          type: "object",
          properties: {
            field: { type: "string", minLength: 1 },
            operator: { type: "string", enum: ["EXACT_MATCH", "CONTAINS", "GT", "EXISTS"] },
            value: { type: "string", minLength: 1 },
          },
          required: ["field", "operator"],
        },
        {
          type: "object",
          properties: {
            operator: { type: "string", enum: ["AND", "OR"] },
            conditions: { type: "array", items: { $ref: "#/definitions/__schema0" } },
          },
          required: ["operator", "conditions"],
        },
      ],
    },
  },
};

/** What mcp-adapters hands the model for `filterSource`: both branches merged into one. */
const filterAdapted = {
  type: "object",
  properties: {
    queryTerm: { type: "string" },
    condition: {
      description: "simple or compound conditions",
      type: "object",
      properties: {
        field: { type: "string", minLength: 1 },
        operator: { type: "string", enum: ["AND", "OR"] },
        value: { type: "string", minLength: 1 },
        conditions: { type: "array", items: { type: "object" } },
      },
      required: ["operator"],
    },
  },
  additionalProperties: false,
};

const leafFilter = { condition: { field: "accountId", operator: "EXACT_MATCH", value: "acct-1" } };
const compoundFilter = {
  condition: {
    operator: "AND",
    conditions: [{ field: "accountId", operator: "EXACT_MATCH", value: "acct-1" }],
  },
};

/** Validate through the same pre-flight LangChain runs before a tool call reaches the server. */
async function callWithSchema(schema: unknown, args: unknown): Promise<string> {
  const tool = new DynamicStructuredTool({
    name: "search",
    description: "search",
    schema: schema as Record<string, unknown>,
    func: async () => "called",
  });
  tool.verboseParsingErrors = true;
  return (await tool.invoke(args as Record<string, unknown>)) as string;
}

describe("restoreFlattenedUnions", () => {
  it("restores a nullable string type removed from an optional MCP field", () => {
    const source = {
      type: "object",
      properties: {
        spoof_account_id: {
          anyOf: [{ type: "string", pattern: "^\\d{12}$" }, { type: "null" }],
          default: null,
          title: "Spoof Account Id",
        },
      },
    };
    const adapted = {
      type: "object",
      properties: {
        spoof_account_id: {
          default: null,
          title: "Spoof Account Id",
        },
      },
    };

    expect(restoreFlattenedUnions(adapted, source)).toEqual({
      type: "object",
      properties: {
        spoof_account_id: {
          type: "string",
          pattern: "^\\d{12}$",
          default: null,
          title: "Spoof Account Id",
        },
      },
    });
  });

  it("restores nullable arrays recursively without restoring the null union", () => {
    expect(
      restoreFlattenedUnions(
        { title: "Metrics" },
        {
          anyOf: [
            { type: "array", items: { type: ["string", "null"] } },
            { type: "null" },
          ],
          title: "Metrics",
        },
      ),
    ).toEqual({
      type: "array",
      items: { type: "string" },
      title: "Metrics",
    });
  });

  it("restores a scalar-or-array union the adapter reduces to a bare description", () => {
    const source = {
      type: "object",
      properties: {
        createdBy: {
          description: "alias or aliases",
          anyOf: [{ type: "string" }, { type: "array", items: { type: "string" } }],
        },
      },
    };
    const adapted = {
      type: "object",
      properties: { createdBy: { description: "alias or aliases" } },
    };

    expect(restoreFlattenedUnions(adapted, source)).toEqual({
      type: "object",
      properties: {
        createdBy: {
          description: "alias or aliases",
          anyOf: [{ type: "string" }, { type: "array", items: { type: "string" } }],
        },
      },
    });
  });

  it("restores a union nested in array items", () => {
    const variants = [
      {
        type: "object",
        properties: { slackUrl: { type: "string" } },
        required: ["slackUrl"],
        additionalProperties: false,
      },
      {
        type: "object",
        properties: { channelId: { type: "string" }, threadTs: { type: "string" } },
        required: ["channelId", "threadTs"],
        additionalProperties: false,
      },
    ];
    const source = {
      type: "object",
      properties: { threads: { type: "array", items: { anyOf: variants } } },
    };
    const adapted = {
      type: "object",
      properties: {
        threads: {
          type: "array",
          items: {
            type: "object",
            properties: {
              slackUrl: { type: "string" },
              channelId: { type: "string" },
              threadTs: { type: "string" },
            },
            additionalProperties: false,
          },
        },
      },
    };

    expect(restoreFlattenedUnions(adapted, source)).toEqual({
      type: "object",
      properties: { threads: { type: "array", items: { anyOf: variants } } },
    });
  });

  it("resolves a $ref hidden behind allOf and keeps the merged description", () => {
    const restored = restoreFlattenedUnions(filterAdapted, filterSource) as {
      properties: { condition: { description: string; anyOf: unknown[] } };
    };

    expect(restored.properties.condition.description).toBe("simple or compound conditions");
    expect(restored.properties.condition.anyOf).toHaveLength(2);
  });

  it("degrades a self-referencing definition to a bare object rather than recursing", () => {
    const restored = restoreFlattenedUnions(filterAdapted, filterSource) as {
      properties: { condition: { anyOf: { properties?: { conditions?: unknown } }[] } };
    };

    expect(restored.properties.condition.anyOf[1]?.properties?.conditions).toEqual({
      type: "array",
      items: { type: "object" },
    });
  });

  it("drops keys the adapter strips for provider compatibility", () => {
    const source = {
      type: "object",
      properties: {
        value: {
          anyOf: [
            { type: "string", $schema: "http://json-schema.org/draft-07/schema#" },
            { type: "integer", not: { const: 0 }, unevaluatedProperties: false },
          ],
        },
      },
    };

    expect(restoreFlattenedUnions({ type: "object", properties: { value: {} } }, source)).toEqual({
      type: "object",
      properties: { value: { anyOf: [{ type: "string" }, { type: "integer" }] } },
    });
  });

  it("keeps a property the adapter emitted but the source never described", () => {
    expect(
      restoreFlattenedUnions(
        { type: "object", properties: { extra: { type: "string" } } },
        { type: "object", properties: {} },
      ),
    ).toEqual({ type: "object", properties: { extra: { type: "string" } } });
  });
});

describe("restored MCP schemas under LangChain pre-flight validation", () => {
  it("accepts the leaf filter the flattened schema rejected", async () => {
    await expect(callWithSchema(filterAdapted, leafFilter)).rejects.toThrow(
      /did not match expected schema/,
    );
    await expect(
      callWithSchema(restoreFlattenedUnions(filterAdapted, filterSource), leafFilter),
    ).resolves.toBe("called");
  });

  it("still accepts the compound filter the flattened schema already allowed", async () => {
    await expect(callWithSchema(filterAdapted, compoundFilter)).resolves.toBe("called");
    await expect(
      callWithSchema(restoreFlattenedUnions(filterAdapted, filterSource), compoundFilter),
    ).resolves.toBe("called");
  });

  it("rejects a filter that matches neither branch", async () => {
    await expect(
      callWithSchema(restoreFlattenedUnions(filterAdapted, filterSource), {
        condition: { operator: "EXACT_MATCH" },
      }),
    ).rejects.toThrow(/did not match expected schema/);
  });

  it("names the failing constraint when verboseParsingErrors is set", async () => {
    await expect(
      callWithSchema(restoreFlattenedUnions(filterAdapted, filterSource), {
        condition: { field: "accountId", operator: "NOPE", value: "acct-1" },
      }),
    ).rejects.toThrow(/operator/);
  });
});
