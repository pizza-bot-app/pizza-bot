import { describe, expect, it } from "vitest";
import {
  sanitizeGeminiSchema,
  sanitizeGeminiTools,
} from "./google-schema-fix.js";

describe("Gemini tool schema compatibility", () => {
  it("rewrites the exclusive bounds Gemini rejects as unknown fields", () => {
    const sanitized = sanitizeGeminiSchema({
      type: "object",
      properties: {
        max_count: {
          anyOf: [
            { type: "integer", exclusiveMinimum: 0 },
            { type: "null" },
          ],
          description: "Optional cap on matches",
        },
        ratio: { type: "number", exclusiveMinimum: 0, exclusiveMaximum: 1 },
      },
    });

    expect(sanitized).toEqual({
      type: "object",
      properties: {
        max_count: {
          anyOf: [{ type: "integer", minimum: 1 }, { type: "null" }],
          description: "Optional cap on matches",
        },
        ratio: { type: "number", minimum: 0, maximum: 1 },
      },
    });
  });

  it("keeps the tighter bound when a schema states both forms", () => {
    expect(
      sanitizeGeminiSchema({ type: "number", minimum: 2, exclusiveMinimum: 5 }),
    ).toEqual({ type: "number", minimum: 5 });
    expect(
      sanitizeGeminiSchema({ type: "number", exclusiveMaximum: 5, maximum: 9 }),
    ).toEqual({ type: "number", maximum: 5 });
  });

  it("drops keywords and formats outside Gemini's OpenAPI subset", () => {
    expect(
      sanitizeGeminiSchema({
        type: "object",
        properties: {
          id: { type: "string", format: "uuid", minLength: 1 },
          when: { type: "string", format: "date-time" },
          tags: {
            type: "array",
            items: { type: "string", pattern: "^a" },
            uniqueItems: true,
          },
          count: { type: "integer", multipleOf: 2 },
        },
        required: ["id"],
        additionalProperties: false,
        $schema: "https://json-schema.org/draft/2020-12/schema",
      }),
    ).toEqual({
      type: "object",
      properties: {
        id: { type: "string", minLength: 1 },
        when: { type: "string", format: "date-time" },
        tags: { type: "array", items: { type: "string", pattern: "^a" } },
        count: { type: "integer" },
      },
      required: ["id"],
    });
  });

  it("translates const and oneOf into the enum and anyOf Gemini understands", () => {
    expect(
      sanitizeGeminiSchema({
        oneOf: [
          { type: "string", const: "leaf", multipleOf: 1 },
          { type: "integer", enum: [1, 2] },
        ],
      }),
    ).toEqual({
      anyOf: [{ type: "string", enum: ["leaf"] }, { type: "integer" }],
    });
  });

  it("merges allOf members into their parent", () => {
    expect(
      sanitizeGeminiSchema({
        allOf: [
          { type: "object", properties: { a: { type: "string" } } },
          { description: "merged", required: ["a"] },
        ],
      }),
    ).toEqual({
      type: "object",
      properties: { a: { type: "string" } },
      description: "merged",
      required: ["a"],
    });
  });

  it("sanitizes function declarations and leaves other Gemini tools untouched", () => {
    const tools = [
      { googleSearch: {} },
      {
        functionDeclarations: [
          {
            name: "grep",
            description: "Search files",
            parameters: {
              type: "object",
              properties: {
                max_count: { type: "integer", exclusiveMinimum: 0 },
              },
            },
          },
        ],
      },
    ];

    expect(sanitizeGeminiTools(tools)).toEqual([
      { googleSearch: {} },
      {
        functionDeclarations: [
          {
            name: "grep",
            description: "Search files",
            parameters: {
              type: "object",
              properties: { max_count: { type: "integer", minimum: 1 } },
            },
          },
        ],
      },
    ]);
  });
});
