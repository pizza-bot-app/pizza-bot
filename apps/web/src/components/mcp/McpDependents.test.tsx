import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { McpDependents } from "./McpDependents.js";

describe("McpDependents", () => {
  it("says no skill uses the server instead of rendering nothing", () => {
    const html = renderToStaticMarkup(<McpDependents skills={[]} />);
    expect(html).toContain("Required by skills");
    expect(html).toContain("No skill uses this server’s tools yet");
    expect(html).not.toContain("mcp-dependent-list");
  });

  it("lists the skills that use the server", () => {
    const html = renderToStaticMarkup(
      <McpDependents skills={[{ id: "mail", name: "Mail triage", enabled: true, source: "user" }]} />,
    );
    expect(html).toContain("Mail triage");
    expect(html).not.toContain("No skill uses");
  });
});
