import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { McpServerRow } from "@/api-client";
import { McpServerCard } from "./McpServerCard.js";

function server(overrides: Partial<McpServerRow> = {}): McpServerRow {
  return {
    id: "aws",
    source: "plugin",
    pluginName: "amazon",
    entry: { command: "node", args: ["server.cjs"] },
    enabled: true,
    status: "connected",
    toolCount: 83,
    dependentSkills: [],
    ...overrides,
  };
}

describe("McpServerCard tool count", () => {
  it("renders the tool count as a dialog trigger when connected and tools can be listed", () => {
    const html = renderToStaticMarkup(<McpServerCard server={server()} onGetTools={vi.fn()} />);
    expect(html).toMatch(/<button[^>]*mcp-tools-link[^>]*aria-haspopup="dialog"[^>]*>83 tools<\/button>/);
  });

  it("keeps the count as plain text when the server is not connected", () => {
    const html = renderToStaticMarkup(
      <McpServerCard server={server({ status: "error", toolCount: 0 })} onGetTools={vi.fn()} />,
    );
    expect(html).not.toContain("mcp-tools-link");
    expect(html).toContain("Failed to connect");
  });

  it("pluralises the count correctly", () => {
    const html = renderToStaticMarkup(
      <McpServerCard server={server({ toolCount: 1 })} onGetTools={vi.fn()} />,
    );
    expect(html).toContain(">1 tool</button>");
  });
});
