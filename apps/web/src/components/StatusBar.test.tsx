import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import type { StatusInfo } from "@/api-client";
import { StatusBar } from "./StatusBar.js";

function renderStatusBar(
  showContextUsage: boolean,
  reachable?: boolean,
  status?: StatusInfo,
  connection?: PizzaConnectionState,
): string {
  return renderToStaticMarkup(
    <TooltipProvider>
      <StatusBar
        usage={{ input: 12_000, output: 2_000 }}
        showContextUsage={showContextUsage}
        reachable={reachable}
        status={status}
        connection={connection}
      />
    </TooltipProvider>,
  );
}

function statusWithProviders(
  providers: StatusInfo["inference"]["providers"],
): StatusInfo {
  const connected = providers.filter((provider) => provider.status === "connected").length;
  return {
    model: "bedrock:claude-sonnet-5",
    timezone: "America/Los_Angeles",
    inference: {
      available: connected > 0,
      connected,
      total: providers.length,
      providers,
    },
    mcp: {
      available: false,
      loaded: 0,
      total: 0,
      disabled: 0,
      servers: [],
    },
    timestamp: "2026-08-08T00:00:00.000Z",
  };
}

function statusWithMcp(
  servers: StatusInfo["mcp"]["servers"],
): StatusInfo {
  const status = statusWithProviders([
    { name: "bedrock", status: "connected", modelCount: 1 },
  ]);
  const loaded = servers.filter((server) => server.status === "loaded").length;
  const disabled = servers.filter((server) => server.status === "disabled").length;
  const total = servers.length - disabled;
  return {
    ...status,
    mcp: {
      available: total > 0 && loaded === total,
      loaded,
      total,
      disabled,
      servers,
    },
  };
}

describe("StatusBar", () => {
  it("hides context usage when no conversation is active", () => {
    expect(renderStatusBar(false)).not.toContain("statusbar-gauge");
  });

  it("shows context usage when a conversation is active", () => {
    expect(renderStatusBar(true)).toContain("statusbar-gauge");
  });

  it("surfaces an unreachable-server indicator only once a poll has failed", () => {
    expect(renderStatusBar(false)).toContain("lucide-server");
    expect(renderStatusBar(false)).not.toContain("lucide-wifi-off");
    expect(renderStatusBar(false, true)).toContain("lucide-server");
    expect(renderStatusBar(false, true)).not.toContain("lucide-wifi-off");
    expect(renderStatusBar(false, false)).toContain("lucide-wifi-off");
  });

  it("identifies the active remote backend", () => {
    expect(
      renderStatusBar(false, true, undefined, {
        mode: "remote",
        remoteUrl: "https://pizza.example",
        hasToken: true,
        managedByEnvironment: false,
      }),
    ).toContain("Remote backend: Connected to https://pizza.example");
  });

  it("reports inference available when at least one provider is connected", () => {
    const html = renderStatusBar(
      false,
      true,
      statusWithProviders([
        { name: "bedrock", status: "connected", modelCount: 3 },
        { name: "anthropic", status: "unavailable", modelCount: 0 },
        { name: "ollama", status: "connected", modelCount: 2 },
      ]),
    );

    expect(html).toContain("Inference providers: 2/3 providers available");
    expect(html).toContain("lucide-bot");
    expect(html).toContain("text-ok");
  });

  it("reports inference unavailable only when no provider is connected", () => {
    const html = renderStatusBar(
      false,
      true,
      statusWithProviders([
        { name: "bedrock", status: "unavailable", modelCount: 0 },
        { name: "ollama", status: "unavailable", modelCount: 0 },
      ]),
    );

    expect(html).toContain("Inference providers: No inference providers available");
    expect(html).toContain("text-bad");
  });

  it("reports MCP startup progress without presenting loading servers as failures", () => {
    const html = renderStatusBar(
      false,
      true,
      statusWithMcp([
        { name: "calendar", status: "loaded", toolCount: 2 },
        { name: "mail", status: "loading", toolCount: 0 },
        { name: "search", status: "retrying", toolCount: 0 },
      ]),
    );

    expect(html).toContain("MCP servers: 1/3 servers loaded · 2 connecting");
    expect(html).toContain(
      'class="statusbar-icon text-info" type="button" aria-label="MCP servers:',
    );
  });

  it("uses warning styling when at least one MCP server remains available", () => {
    const html = renderStatusBar(
      false,
      true,
      statusWithMcp([
        { name: "calendar", status: "loaded", toolCount: 2 },
        { name: "mail", status: "error", toolCount: 0 },
      ]),
    );

    expect(html).toContain("MCP servers: 1/2 servers loaded · 1 failed");
    expect(html).toContain(
      'class="statusbar-icon text-warn" type="button" aria-label="MCP servers:',
    );
  });

  it("reserves MCP failure styling for complete unavailability", () => {
    const html = renderStatusBar(
      false,
      true,
      statusWithMcp([
        { name: "calendar", status: "error", toolCount: 0 },
        { name: "mail", status: "crashed", toolCount: 0 },
      ]),
    );

    expect(html).toContain("MCP servers: 0/2 servers loaded · 2 failed");
    expect(html).toContain(
      'class="statusbar-icon text-bad" type="button" aria-label="MCP servers:',
    );
  });
});
