import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { McpServerRow } from "@/api-client";
import { McpServerActions } from "./McpServersModule.js";

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

function render(row: McpServerRow, deleteBlockedReason?: string): string {
  return renderToStaticMarkup(
    <McpServerActions
      server={row}
      deleteBlockedReason={deleteBlockedReason}
      onEdit={vi.fn()}
      onDelete={vi.fn()}
      onOpenPlugins={vi.fn()}
    />,
  );
}

const button = (html: string, label: string) =>
  [...html.matchAll(/<button[^>]*>(?:(?!<\/button>).)*<\/button>/gs)]
    .map((m) => m[0])
    .find((b) => b.includes(`aria-label="${label}"`) || new RegExp(`>\\s*${label}</button>$`).test(b));

describe("McpServerActions", () => {
  it("offers live Edit and Delete icon actions for a custom server", () => {
    const html = render(server());
    expect(button(html, "Edit outlook")).toContain("plugin-card-action");
    expect(button(html, "Edit outlook")).not.toContain("disabled");
    expect(button(html, "Delete outlook")).toContain("plugin-card-remove");
    expect(button(html, "Delete outlook")).not.toContain("disabled");
    expect(html).not.toContain("Managed by plugin");
  });

  it("disables Edit and Delete for a plugin server and links to the plugin", () => {
    const html = render(server({ source: "plugin", pluginName: "amazon" }));
    expect(button(html, "Edit outlook")).toMatch(/title="Managed by the amazon plugin"[^>]*disabled=""/);
    expect(button(html, "Delete outlook")).toMatch(/title="Managed by the amazon plugin"[^>]*disabled=""/);
    expect(button(html, "Managed by plugin")).toContain("mcp-managed-link");
    expect(button(html, "Managed by plugin")).not.toContain("disabled");
  });

  it("disables Delete with the blocking reason when enabled skills depend on the server", () => {
    const html = render(server(), "Required by Email Triage. Disable that skill first.");
    expect(button(html, "Edit outlook")).not.toContain("disabled");
    expect(button(html, "Delete outlook")).toMatch(
      /title="Required by Email Triage\. Disable that skill first\."[^>]*disabled=""/,
    );
  });
});
