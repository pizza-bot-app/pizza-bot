import { describe, it, expect } from "vitest";
import { PLUGIN_API_VERSION, pluginManifestSchema } from "./manifest.js";

describe("plugin manifest (Claude-plugin superset)", () => {
  it("accepts the supported fields from a Claude Code plugin manifest", () => {
    const stock = {
      name: "mcp-status",
      version: "1.2.0",
      skills: "./skills/",
      mcpServers: "./.mcp.json",
    };
    const parsed = pluginManifestSchema.parse(stock);
    expect(parsed.name).toBe("mcp-status");
    expect(parsed.apiVersion).toBe(PLUGIN_API_VERSION);
  });

  it("accepts the current API version and rejects unsupported versions", () => {
    expect(
      pluginManifestSchema.parse({
        apiVersion: PLUGIN_API_VERSION,
        name: "current-contract",
      }).apiVersion,
    ).toBe(PLUGIN_API_VERSION);
    expect(() =>
      pluginManifestSchema.parse({
        apiVersion: "pizza-bot/v2",
        name: "future-contract",
      }),
    ).toThrow();
  });

  it("ignores unsupported manifest fields instead of failing", () => {
    const withExtras = {
      name: "mcp-status",
      commands: ["./commands/status.md"],
      pizzaBot: { ui: { slots: { "sidebar-panels": ["./ui/Panel.tsx"] } } },
    };
    const parsed = pluginManifestSchema.parse(withExtras);
    expect(parsed.name).toBe("mcp-status");
    expect(parsed).not.toHaveProperty("pizzaBot");
    expect(parsed).not.toHaveProperty("commands");
  });

  it("rejects a non-kebab-case name", () => {
    expect(() => pluginManifestSchema.parse({ name: "MCP Status" })).toThrow();
  });

  it("accepts disabled stdio and remote MCP entries", () => {
    const parsed = pluginManifestSchema.parse({
      name: "optional-tools",
      mcpServers: {
        local: { command: "node", args: ["server.js"], enabled: false },
        remote: { url: "https://example.com/mcp", enabled: false },
      },
    });
    expect(parsed.mcpServers).toMatchObject({
      local: { enabled: false },
      remote: { enabled: false },
    });
  });

  it("rejects unsupported WebSocket MCP entries", () => {
    expect(() =>
      pluginManifestSchema.parse({
        name: "websocket-tools",
        mcpServers: {
          remote: { type: "ws", url: "wss://example.com/mcp" },
        },
      }),
    ).toThrow();
  });

  it("accepts a namespaced materializer extension with lifecycle defaults", () => {
    const parsed = pluginManifestSchema.parse({
      name: "generated-tools",
      extensions: {
        "dev.pizzabot.materializer": {
          entrypoint: "./dist/materialize.mjs",
          sourceRoots: ["~/.pizza-bot/addons"],
        },
        "example.com/metadata": { channel: "stable" },
      },
    });

    expect(
      parsed.extensions?.["dev.pizzabot.materializer"],
    ).toEqual({
      entrypoint: "./dist/materialize.mjs",
      sourceRoots: ["~/.pizza-bot/addons"],
      sync: ["install", "startup", "manual"],
      timeoutMs: 30_000,
    });
    expect(parsed.extensions?.["example.com/metadata"]).toEqual({
      channel: "stable",
    });
  });

  it("rejects invalid materializer lifecycle settings", () => {
    expect(() =>
      pluginManifestSchema.parse({
        name: "generated-tools",
        extensions: {
          "dev.pizzabot.materializer": {
            entrypoint: "",
            sync: [],
            timeoutMs: 0,
          },
        },
      }),
    ).toThrow();
  });
});
