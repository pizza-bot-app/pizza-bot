import { describe, it, expect } from "vitest";
import {
  expandToolPattern,
  resolveToolReferences,
  isWildcard,
  InvalidWildcardError,
  type ToolCatalog,
} from "./wildcard.js";

const CATALOG: ToolCatalog = {
  status: ["get_status", "get_health", "reset", "ping"],
  weather: ["forecast", "current"],
};

describe("expandToolPattern", () => {
  it("expands a full wildcard to every tool on the server", () => {
    expect(expandToolPattern("mcp:status:*", CATALOG)).toEqual([
      "mcp:status:get_status",
      "mcp:status:get_health",
      "mcp:status:reset",
      "mcp:status:ping",
    ]);
  });

  it("expands a prefix wildcard to matching tools only", () => {
    expect(expandToolPattern("mcp:status:get_*", CATALOG)).toEqual([
      "mcp:status:get_status",
      "mcp:status:get_health",
    ]);
  });

  it("passes a concrete reference through unchanged", () => {
    expect(expandToolPattern("mcp:status:ping", CATALOG)).toEqual(["mcp:status:ping"]);
  });

  it("yields nothing for a server absent from the catalog", () => {
    expect(expandToolPattern("mcp:unknown:*", CATALOG)).toEqual([]);
  });

  it("throws on a wildcard not at the end of the tool segment", () => {
    expect(() => expandToolPattern("mcp:status:*_status", CATALOG)).toThrow(InvalidWildcardError);
  });

  it("throws on a malformed reference shape", () => {
    expect(() => expandToolPattern("mcp:status:sub:*", CATALOG)).toThrow(InvalidWildcardError);
    expect(() => expandToolPattern("not-mcp:*", CATALOG)).toThrow(InvalidWildcardError);
  });
});

describe("isWildcard", () => {
  it("detects the presence of a *", () => {
    expect(isWildcard("mcp:status:*")).toBe(true);
    expect(isWildcard("mcp:status:ping")).toBe(false);
  });
});

describe("resolveToolReferences", () => {
  it("expands a mixed list, dedupes, and classifies empties + invalids", () => {
    const result = resolveToolReferences(
      [
        "mcp:status:get_*",
        "mcp:status:get_status",
        "mcp:weather:*",
        "mcp:ghost:*",
        "mcp:status:*bad",
      ],
      CATALOG,
    );
    expect(result.expanded).toEqual([
      "mcp:status:get_status",
      "mcp:status:get_health",
      "mcp:weather:forecast",
      "mcp:weather:current",
    ]);
    expect(result.emptyWildcards).toEqual(["mcp:ghost:*"]);
    expect(result.invalid).toEqual(["mcp:status:*bad"]);
  });

  it("preserves non-wildcard references and their order", () => {
    const result = resolveToolReferences(["mcp:a:x", "mcp:b:y"], {});
    expect(result.expanded).toEqual(["mcp:a:x", "mcp:b:y"]);
    expect(result.emptyWildcards).toEqual([]);
    expect(result.invalid).toEqual([]);
  });
});
