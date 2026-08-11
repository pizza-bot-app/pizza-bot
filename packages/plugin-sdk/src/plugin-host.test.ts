import { describe, it, expect } from "vitest";
import { parseFrontmatter } from "./plugin-host.js";

describe("parseFrontmatter", () => {
  it("extracts top-level frontmatter keys as a record", () => {
    const md = ["---", "name: foo", "description: a bar", "model: bedrock:x", "---", "", "body"].join(
      "\n",
    );
    const fm = parseFrontmatter(md);
    expect(fm).toMatchObject({ name: "foo", description: "a bar", model: "bedrock:x" });
    expect(fm).not.toHaveProperty("body");
  });

  it("parses YAML lists and nested maps, not just flat scalars", () => {
    const md = [
      "---",
      "name: foo",
      "tools:",
      "  - mcp:a:one",
      "  - mcp:a:two",
      "pizzaBot:",
      "  id: foo",
      '  avatar: "🗂️"',
      "---",
      "",
      "body",
    ].join("\n");
    const fm = parseFrontmatter(md);
    expect(fm.tools).toEqual(["mcp:a:one", "mcp:a:two"]);
    expect(fm.pizzaBot).toEqual({ id: "foo", avatar: "🗂️" });
  });

  it("returns an empty record when there is no frontmatter block", () => {
    expect(parseFrontmatter("# just a heading\n")).toEqual({});
  });

  it("returns an empty record for a malformed frontmatter block", () => {
    expect(parseFrontmatter(["---", "name: [unterminated", "---", "body"].join("\n"))).toEqual({});
  });
});
