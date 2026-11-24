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
    expect(html).toContain("Already granted by mcp:playwright:browser*, which pauses for your approval before it runs");
  });

  it("keeps a covered tool addable so it can ask first on its own", () => {
    const html = row(false);
    expect(html).not.toContain("disabled");
    expect(html).toContain("Already granted by mcp:playwright:browser*. Add it to pause for your approval before just this tool runs");
  });
});
