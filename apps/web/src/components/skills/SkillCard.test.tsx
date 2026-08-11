import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { SkillCard, type SkillCardHeader } from "./SkillCard.js";

const header: SkillCardHeader = {
  name: "Release Notes Analyst",
  description: "Summarizes release notes.",
  source: "plugin",
  pluginName: "example-tools",
  declaredTools: ["mcp:docs:search"],
};

describe("SkillCard", () => {
  it("renders the header from the list row while the bundle is pending", () => {
    const html = renderToStaticMarkup(<SkillCard skill={header} content={null} />);

    expect(html).toContain("Release Notes Analyst");
    expect(html).toContain("Summarizes release notes.");
    expect(html).toContain("example-tools");
    expect(html).toContain("mcp:docs:search");
    expect(html).toContain('aria-label="Loading SKILL.md"');
  });

  it("swaps the pending body for SKILL.md without disturbing the header", () => {
    const html = renderToStaticMarkup(
      <SkillCard
        skill={header}
        content={{ body: "Ask about spend.", files: [{ path: "queries.sql", content: "" }] }}
      />,
    );

    expect(html).toContain("Release Notes Analyst");
    expect(html).toContain("Ask about spend.");
    expect(html).toContain("queries.sql");
    expect(html).not.toContain('aria-label="Loading SKILL.md"');
  });
});
