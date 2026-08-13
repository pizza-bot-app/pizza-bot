import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { McpServerRow } from "@/api-client";
import { AppToastProvider } from "../AppToast.js";
import { McpReconnectControl } from "./McpReconnectControl.js";

function server(
  status: McpServerRow["status"],
  enabled = true,
): McpServerRow {
  return {
    id: "documents",
    source: "plugin",
    entry: { command: "node" },
    enabled,
    status,
    toolCount: 0,
    detail: "connection timed out after 20000ms",
    dependentSkills: [],
  };
}

function render(status: McpServerRow["status"], enabled = true): string {
  return renderToStaticMarkup(
    <AppToastProvider>
      <McpReconnectControl
        server={server(status, enabled)}
        onReconnect={vi.fn()}
      />
    </AppToastProvider>,
  );
}

describe("McpReconnectControl", () => {
  it("shows the failure detail and retry action for a failed server", () => {
    const html = render("error");
    expect(html).toContain("Connection failed");
    expect(html).toContain("connection timed out after 20000ms");
    expect(html).toContain("Retry connection");
    expect(html).toContain("lucide-refresh-cw");
  });

  it("does not offer reconnect while connected or disabled", () => {
    expect(render("connected")).not.toContain("Retry connection");
    expect(render("error", false)).not.toContain("Retry connection");
  });
});
