import { describe, expect, it } from "vitest";
import type { ToolCatalogInfo } from "@/api-client";
import { describeGrantedTool, filterTools, patternSuggestions, toolGroups } from "./tool-catalog.js";

const catalog: ToolCatalogInfo = {
  builtins: [{ ref: "builtin:eval", name: "eval", description: "Evaluate expressions." }],
  servers: [
    {
      server: "files",
      wildcard: "mcp:files:*",
      tools: ["list_directory", "list_allowed_directories", "read_file"].map((name) => ({
        ref: `mcp:files:${name}`,
        name,
      })),
    },
    {
      server: "mail",
      wildcard: "mcp:mail:*",
      tools: [{ ref: "mcp:mail:list_folders", name: "list_folders" }],
    },
  ],
};

describe("filterTools", () => {
  const tools = [
    { name: "s3_list_buckets", description: "List S3 buckets in the account." },
    { name: "ec2_describe_instances", description: "Describe EC2 instances." },
    { name: "sts_whoami" },
  ];

  it("matches on name or description, case-insensitively", () => {
    expect(filterTools(tools, "S3").map((t) => t.name)).toEqual(["s3_list_buckets"]);
    expect(filterTools(tools, "instances").map((t) => t.name)).toEqual(["ec2_describe_instances"]);
    expect(filterTools(tools, "whoami").map((t) => t.name)).toEqual(["sts_whoami"]);
  });

  it("returns everything for a blank query", () => {
    expect(filterTools(tools, "  ")).toBe(tools);
  });
});

describe("toolGroups", () => {
  it("puts built-ins first and tags every tool with its source", () => {
    const groups = toolGroups(catalog);
    expect(groups.map((g) => [g.source, g.wildcard])).toEqual([
      ["Built-in", undefined],
      ["files", "mcp:files:*"],
      ["mail", "mcp:mail:*"],
    ]);
    expect(groups[1]!.tools[0]).toMatchObject({ name: "list_directory", source: "files" });
  });
});

describe("describeGrantedTool", () => {
  it("names the source of exact refs", () => {
    expect(describeGrantedTool("builtin:eval", catalog)).toEqual({ ref: "builtin:eval", name: "eval", source: "Built-in" });
    expect(describeGrantedTool("mcp:files:read_file", catalog)).toEqual({
      ref: "mcp:files:read_file",
      name: "read_file",
      source: "files",
    });
  });

  it("expands wildcard grants against the connected catalog", () => {
    expect(describeGrantedTool("mcp:files:*", catalog)).toMatchObject({ name: "All tools", matches: ["list_directory", "list_allowed_directories", "read_file"] });
    expect(describeGrantedTool("mcp:files:list_*", catalog)).toMatchObject({
      name: "list_*",
      source: "files",
      matches: ["list_directory", "list_allowed_directories"],
    });
  });

  it("leaves matches unknown for a disconnected server or malformed pattern", () => {
    expect(describeGrantedTool("mcp:gone:list_*", catalog).matches).toBeUndefined();
    expect(describeGrantedTool("mcp:files:*_file", catalog).matches).toBeUndefined();
  });
});

describe("patternSuggestions", () => {
  it("ignores searches without a *", () => {
    expect(patternSuggestions("list_", catalog)).toEqual({ suggestions: [] });
  });

  it("tries a bare pattern on every server and drops the ones that match nothing", () => {
    expect(patternSuggestions("list_*", catalog).suggestions).toEqual([
      { ref: "mcp:files:list_*", source: "files", matches: ["list_directory", "list_allowed_directories"] },
      { ref: "mcp:mail:list_*", source: "mail", matches: ["list_folders"] },
    ]);
    expect(patternSuggestions("read_*", catalog).suggestions.map((s) => s.ref)).toEqual(["mcp:files:read_*"]);
  });

  it("scopes a full ref to its server", () => {
    expect(patternSuggestions("mcp:mail:list_*", catalog).suggestions.map((s) => s.ref)).toEqual(["mcp:mail:list_*"]);
  });

  it("explains a misplaced *", () => {
    expect(patternSuggestions("*_file", catalog)).toEqual({
      suggestions: [],
      error: "A * can only go at the end of a pattern.",
    });
    expect(patternSuggestions("mcp:list_*", catalog).error).toBe("Patterns look like mcp:<server>:<prefix>*.");
  });
});
