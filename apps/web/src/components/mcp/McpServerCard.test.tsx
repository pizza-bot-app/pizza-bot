import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { McpServerRow } from "@/api-client";
import { McpServerCard, mcpStatusLabel } from "./McpServerCard.js";

function server(overrides: Partial<McpServerRow> = {}): McpServerRow {
  return {
    id: "outlook",
    source: "user",
    entry: { command: "npx", args: ["-y", "outlook-mcp"] },
    enabled: true,
    status: "connected",
    toolCount: 12,
    dependentSkills: [],
    ...overrides,
  };
}

describe("McpServerCard", () => {
  it("renders the actions slot and the server's own provenance badge", () => {
    const html = renderToStaticMarkup(
      <McpServerCard server={server()} actions={<button>Edit</button>} />,
    );
    expect(html).toContain('class="resource-card-actions"');
    expect(html).toContain("<button>Edit</button>");
    expect(html).toContain('class="provenance-badge user"');
    expect(html).not.toContain('class="provenance-badge plugin"');
  });

  it("shows plugin provenance in the header", () => {
    const html = renderToStaticMarkup(
      <McpServerCard server={server({ source: "plugin", pluginName: "outlook-suite" })} />,
    );
    expect(html).toContain('class="provenance-badge plugin"');
    expect(html).toContain("from plugin <code>outlook-suite</code>");
  });

  it("renders the load-error slot above the enablement control", () => {
    const html = renderToStaticMarkup(
      <McpServerCard
        server={server()}
        loadError={<div id="load-error" />}
        enablement={<div id="enablement" />}
      />,
    );
    expect(html.indexOf('id="load-error"')).toBeLessThan(html.indexOf('id="enablement"'));
  });
});

describe("mcpStatusLabel", () => {
  it("distinguishes connecting, failed and crashed instead of a generic 'not connected'", () => {
    expect(mcpStatusLabel(server({ status: "loading" }))).toBe("Connecting…");
    expect(mcpStatusLabel(server({ status: "retrying" }))).toBe("Connecting…");
    expect(mcpStatusLabel(server({ status: "error" }))).toBe("Failed to connect");
    expect(mcpStatusLabel(server({ status: "crashed" }))).toBe("Crashed");
    expect(mcpStatusLabel(server({ status: "connected", toolCount: 1 }))).toBe("Connected · 1 tool");
    expect(mcpStatusLabel(server({ enabled: false }))).toBe("Disabled");
  });
});
