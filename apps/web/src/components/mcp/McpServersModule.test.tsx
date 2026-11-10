import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { McpServerRow } from "@/api-client";
import { McpManagedLink, McpServerActions } from "./McpServersModule.js";

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
    />,
  );
}

const button = (html: string, label: string) =>
  [...html.matchAll(/<button[^>]*>(?:(?!<\/button>).)*<\/button>/gs)]
    .map((m) => m[0])
    .find((b) => b.includes(`aria-label="${label}"`) || new RegExp(`>\\s*${label}</button>$`).test(b));

describe("McpServerActions", () => {
  it("puts Delete first and a live Edit button last for a custom server", () => {
    const html = render(server());
    expect(button(html, "Edit")).not.toContain("disabled");
    expect(button(html, "Delete")).toContain("resource-editor-delete");
    expect(html.indexOf("Delete</button>")).toBeLessThan(html.indexOf("Edit</button>"));
    expect(button(html, "Delete")).not.toContain("disabled");
    expect(html).not.toContain("Managed by plugin");
  });

  it("hides Edit and disables Delete for a plugin server", () => {
    const html = render(server({ source: "plugin", pluginName: "amazon" }));
    expect(button(html, "Edit")).toBeUndefined();
    expect(button(html, "Delete")).toMatch(/title="Managed by the amazon plugin"[^>]*disabled=""/);
    expect(html).not.toContain("Managed by plugin");
  });

  it("disables Delete with the blocking reason when enabled skills depend on the server", () => {
    const html = render(server(), "Required by Email Triage. Disable that skill first.");
    expect(button(html, "Edit")).not.toContain("disabled");
    expect(button(html, "Delete")).toMatch(
      /title="Required by Email Triage\. Disable that skill first\."[^>]*disabled=""/,
    );
  });
});

describe("McpManagedLink", () => {
  it("links to the plugins view when navigation is available", () => {
    const html = renderToStaticMarkup(<McpManagedLink onOpenPlugins={vi.fn()} />);
    expect(button(html, "Managed by plugin")).not.toContain("disabled");
  });

  it("renders disabled without a navigation target", () => {
    const html = renderToStaticMarkup(<McpManagedLink />);
    expect(button(html, "Managed by plugin")).toContain("disabled");
  });
});
