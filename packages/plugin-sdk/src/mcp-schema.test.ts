import { describe, expect, it } from "vitest";
import { restoreNullableSchemaTypes } from "./mcp-schema.js";

describe("restoreNullableSchemaTypes", () => {
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

    expect(restoreNullableSchemaTypes(adapted, source)).toEqual({
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
      restoreNullableSchemaTypes(
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

  it("leaves non-nullable unions in the adapter's provider-compatible form", () => {
    const adapted = { title: "Value" };
    const source = { anyOf: [{ type: "string" }, { type: "integer" }], title: "Value" };
    expect(restoreNullableSchemaTypes(adapted, source)).toEqual(adapted);
  });
});
