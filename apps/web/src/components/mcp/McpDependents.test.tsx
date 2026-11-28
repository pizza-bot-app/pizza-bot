import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { McpDependents } from "./McpDependents.js";

describe("McpDependents", () => {
  it("says no agent uses the server instead of rendering nothing", () => {
    const html = renderToStaticMarkup(<McpDependents agents={[]} />);
    expect(html).toContain("Required by agents");
    expect(html).toContain("No agent uses this server’s tools yet");
    expect(html).not.toContain("mcp-dependent-list");
  });

  it("lists the agents that use the server", () => {
    const html = renderToStaticMarkup(
      <McpDependents agents={[{ id: "mail", name: "Mail triage", enabled: true, source: "user" }]} />,
    );
    expect(html).toContain("Mail triage");
    expect(html).not.toContain("No agent uses");
  });
});
