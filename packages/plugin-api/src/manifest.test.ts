import { describe, expect, it } from "vitest";
import {
  PLUGIN_API_VERSION,
  pluginManifestSchema,
} from "./manifest.js";

describe("plugin manifest contract", () => {
  it("accepts the supported fields from a stock Claude Code manifest", () => {
    const parsed = pluginManifestSchema.parse({
      name: "mcp-status",
      version: "1.2.0",
      skills: "./skills/",
      mcpServers: "./.mcp.json",
    });

    expect(parsed).toMatchObject({
      name: "mcp-status",
      apiVersion: PLUGIN_API_VERSION,
    });
  });

  it("treats pre-versioned manifests as enabled v1 plugins", () => {
    const parsed = pluginManifestSchema.parse({ name: "mcp-status" });

    expect(parsed).toMatchObject({
      apiVersion: PLUGIN_API_VERSION,
      enabled: true,
    });
  });

  it("separates plugin release, manifest API, engine, and capabilities", () => {
    const parsed = pluginManifestSchema.parse({
      apiVersion: PLUGIN_API_VERSION,
      name: "interactive-tools",
      version: "2.3.0",
      engines: { pizzaBot: ">=1.0.0 <2.0.0" },
      capabilities: {
        required: ["mcp-servers/v1"],
        optional: ["mcp-apps/v1"],
      },
    });

    expect(parsed.version).toBe("2.3.0");
    expect(parsed.engines?.pizzaBot).toBe(">=1.0.0 <2.0.0");
    expect(parsed.capabilities).toEqual({
      required: ["mcp-servers/v1"],
      optional: ["mcp-apps/v1"],
    });
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

  it("rejects malformed capability identifiers", () => {
    expect(() =>
      pluginManifestSchema.parse({
        name: "bad-capability",
        capabilities: { required: ["mcp apps"] },
      }),
    ).toThrow();
  });

  it("rejects a non-kebab-case plugin name", () => {
    expect(() =>
      pluginManifestSchema.parse({ name: "MCP Status" }),
    ).toThrow();
  });

  it("ignores unsupported top-level manifest fields", () => {
    const parsed = pluginManifestSchema.parse({
      name: "mcp-status",
      commands: ["./commands/status.md"],
      pizzaBot: { ui: { slots: ["./ui/Panel.tsx"] } },
    });

    expect(parsed).not.toHaveProperty("pizzaBot");
    expect(parsed).not.toHaveProperty("commands");
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

  it("preserves namespaced extension metadata", () => {
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

    expect(parsed.extensions?.["example.com/metadata"]).toEqual({
      channel: "stable",
    });
    expect(
      parsed.extensions?.["dev.pizzabot.materializer"],
    ).toMatchObject({
      sync: ["install", "startup", "manual"],
      timeoutMs: 30_000,
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
