import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { ToolRow } from "./ToolList.js";

describe("ToolRow", () => {
  const row = (asksFirst: boolean) =>
    renderToStaticMarkup(
      <ToolRow
        name="browser_click"
        onSelect={vi.fn()}
        selectLabel="Add mcp:playwright:browser_click"
        included={{ by: "mcp:playwright:browser*", asksFirst }}
      />,
    );

  it("blocks a tool whose covering wildcard already asks first", () => {
    const html = row(true);
    expect(html).toContain("disabled");
    expect(html).toContain("Included in mcp:playwright:browser*, which asks first");
  });

  it("keeps a covered tool addable so it can ask first on its own", () => {
    const html = row(false);
    expect(html).not.toContain("disabled");
    expect(html).toContain("Included in mcp:playwright:browser*; add it to ask first for just this tool");
  });
});
