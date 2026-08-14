import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  cpSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { McpServerEntry } from "@pizza-bot/plugin-sdk";
import { AgentHost } from "./agent-host.js";
import { buildApp } from "./index.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const STATUS_PLUGIN = resolve(
  __dirname,
  "../../../examples/plugins/mcp-status",
);
const STATUS_SERVER = resolve(STATUS_PLUGIN, "src/server.js");
const DELAYED_SERVER = resolve(
  __dirname,
  "../../../packages/plugin-sdk/src/__fixtures__/mcp-delayed-server.mjs",
);

describe("AgentHost.reloadMcpServers", () => {
  let configFile: string;
  let dataRoot: string;
  let pluginsDir: string;
  let host: AgentHost;
  const prevMcpConfig = process.env.PIZZA_MCP_CONFIG;

  const writeConfig = (servers: Record<string, McpServerEntry>) =>
    writeFileSync(configFile, JSON.stringify({ mcpServers: servers }));

  beforeEach(async () => {
    dataRoot = mkdtempSync(join(tmpdir(), "host-mcp-data-"));
    configFile = join(dataRoot, ".mcp.json");
    pluginsDir = join(dataRoot, "plugin-fixtures");
    mkdirSync(pluginsDir);
    const pluginDir = join(pluginsDir, "example-mcp-status");
    cpSync(STATUS_PLUGIN, pluginDir, { recursive: true });
    writeFileSync(
      join(pluginDir, ".mcp.json"),
      JSON.stringify({
        mcpServers: {
          "mcp-status": {
            command: "node",
            args: [STATUS_SERVER],
            env: { PLUGIN_SECRET: "must-not-be-returned" },
          },
        },
      }),
    );
    process.env.PIZZA_MCP_CONFIG = configFile;
    host = await AgentHost.create({ dataRoot, pluginsDir });
  });

  afterEach(async () => {
    await host.close();
    rmSync(dataRoot, { recursive: true, force: true });
    if (prevMcpConfig === undefined) delete process.env.PIZZA_MCP_CONFIG;
    else process.env.PIZZA_MCP_CONFIG = prevMcpConfig;
  });

  it("connects a newly-added user server after reload — tools in the catalog", async () => {
    expect(await host.toolCatalog()).not.toHaveProperty("echo");

    writeConfig({ echo: { command: "node", args: [STATUS_SERVER] } });
    await host.reloadMcpServers();

    const catalog = await host.toolCatalog();
    expect(catalog).toHaveProperty("echo");
    expect(catalog.echo).toContain("get_mcp_status");
    expect(catalog).toHaveProperty("mcp-status");
  }, 30_000);

  // Windows locks a running child's cwd, so the plugin's MCP server has to exit
  // before its directory can be removed. On POSIX this passes either way.
  it("deletes a plugin whose MCP server holds a lock on its own directory", async () => {
    const installDir = await host.pluginsInstallDirectory();
    expect(installDir).toBeTypeOf("string");
    const name = "locking-plugin";
    const dir = join(installDir as string, name);
    mkdirSync(join(dir, ".claude-plugin"), { recursive: true });
    writeFileSync(
      join(dir, ".claude-plugin", "plugin.json"),
      JSON.stringify({ name, mcpServers: "./.mcp.json" }),
    );
    // `cwd` inside the plugin is what takes the Windows lock; the server itself
    // runs from the repo so it can resolve the MCP SDK.
    writeFileSync(
      join(dir, ".mcp.json"),
      JSON.stringify({
        mcpServers: { locking: { command: "node", args: [STATUS_SERVER], cwd: dir } },
      }),
    );

    await host.reloadPlugins();
    expect(await host.toolCatalog()).toHaveProperty("locking");
    expect(await host.pluginIsInstalled(name)).toBe(true);
    host.capabilityPreferences.set(
      { kind: "mcp", source: `plugin:${name}`, id: "locking" },
      false,
    );

    await expect(host.deletePlugin(name)).resolves.toBe(true);
    expect(existsSync(dir)).toBe(false);
    expect(await host.toolCatalog()).not.toHaveProperty("locking");
    expect(
      host.capabilityPreferences.get({
        kind: "mcp",
        source: `plugin:${name}`,
        id: "locking",
      }),
    ).toBeUndefined();
  }, 30_000);

  it("rediscovers an MCP plugin installed while the host is running", async () => {
    const addonDir = join(pluginsDir, "runtime-addon");
    mkdirSync(join(addonDir, ".claude-plugin"), { recursive: true });
    writeFileSync(
      join(addonDir, ".claude-plugin", "plugin.json"),
      JSON.stringify({ name: "runtime-addon", mcpServers: "./.mcp.json" }),
    );
    writeFileSync(
      join(addonDir, ".mcp.json"),
      JSON.stringify({
        mcpServers: {
          "runtime-addon": { command: "node", args: [STATUS_SERVER] },
        },
      }),
    );

    await host.reloadPlugins();

    expect(await host.toolCatalog()).toHaveProperty("runtime-addon");
    expect((await host.listMcpServers()).find((row) => row.id === "runtime-addon")).toMatchObject({
      source: "plugin",
      pluginName: "runtime-addon",
      status: "connected",
    });
  }, 30_000);

  it("drops a removed user server from the catalog after reload", async () => {
    writeConfig({ removable: { command: "node", args: [STATUS_SERVER] } });
    await host.reloadMcpServers();
    expect(await host.toolCatalog()).toHaveProperty("removable");

    writeConfig({});
    await host.reloadMcpServers();
    expect(await host.toolCatalog()).not.toHaveProperty("removable");
  }, 30_000);

  it("surfaces the user server through listMcpServers with source:user", async () => {
    writeConfig({ echo: { command: "node", args: [STATUS_SERVER] } });
    await host.reloadMcpServers();
    const rows = await host.listMcpServers();
    const echo = rows.find((r) => r.id === "echo");
    expect(echo).toBeDefined();
    expect(echo!.source).toBe("user");
    expect(echo!.status).toBe("connected");
    const plugin = rows.find((r) => r.id === "mcp-status");
    expect((plugin?.entry as { env?: Record<string, string> }).env).toEqual({
      PLUGIN_SECRET: "<redacted>",
    });
  }, 30_000);

  it("reports disabled servers without launching them", async () => {
    writeConfig({
      disabled: {
        command: "node",
        args: ["/no/such/server.js"],
        enabled: false,
      },
    });
    await host.reloadMcpServers();

    const disabled = (await host.listMcpServers()).find((row) => row.id === "disabled");
    expect(disabled).toMatchObject({ status: "disabled", toolCount: 0 });
    expect(await host.toolCatalog()).not.toHaveProperty("disabled");
  }, 30_000);

  it("keeps skill intent while an external dependency is disabled", async () => {
    const pluginMcpFile = join(pluginsDir, "example-mcp-status", ".mcp.json");
    writeFileSync(
      pluginMcpFile,
      JSON.stringify({
        mcpServers: {
          "mcp-status": {
            command: "node",
            args: [STATUS_SERVER],
            enabled: false,
          },
        },
      }),
    );

    await host.reloadPlugins();

    expect(
      (await host.skillCatalog()).find((skill) => skill.id === "health-report"),
    ).toMatchObject({
      enabled: true,
      status: "unavailable",
      statusDetail: "mcp-status is disabled",
    });
    expect(
      (await host.listMcpServers()).find((server) => server.id === "mcp-status"),
    ).toMatchObject({ enabled: false, status: "disabled" });
    expect(
      host.capabilityPreferences.get({
        kind: "skill",
        source: "plugin:mcp-status",
        id: "health-report",
      }),
    ).toBeUndefined();
  }, 30_000);

  it("recovers a skill after a malformed MCP config is repaired", async () => {
    writeConfig({ echo: { command: "node", args: [STATUS_SERVER] } });
    await host.reloadMcpServers();
    const app = buildApp(host);
    const created = await app.request("/skills", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        id: "echo-review",
        name: "Echo review",
        description: "Reviews echo status.",
        body: "Review the status.",
        declaredTools: ["mcp:echo:*"],
      }),
    });
    expect(created.status).toBe(201);
    expect(
      (await host.skillCatalog()).find((skill) => skill.id === "echo-review"),
    ).toMatchObject({ enabled: true, status: "ready" });

    writeFileSync(configFile, "{");
    await host.reloadMcpServers();

    expect(
      (await host.skillCatalog()).find((skill) => skill.id === "echo-review"),
    ).toMatchObject({
      enabled: true,
      status: "unavailable",
      statusDetail: "echo is not configured",
      mcpDependencies: [{ id: "echo", enabled: false, status: "missing" }],
    });
    expect(
      host.capabilityPreferences.get({
        kind: "skill",
        source: "user",
        id: "echo-review",
      }),
    ).toBeUndefined();

    writeConfig({ echo: { command: "node", args: [STATUS_SERVER] } });
    await host.reloadMcpServers();

    expect(
      (await host.skillCatalog()).find((skill) => skill.id === "echo-review"),
    ).toMatchObject({ enabled: true, status: "ready" });
  }, 30_000);

  it("allows turns while an MCP skill loads, then marks it ready after discovery", async () => {
    await host.close();
    const pluginMcpFile = join(pluginsDir, "example-mcp-status", ".mcp.json");
    writeFileSync(
      pluginMcpFile,
      JSON.stringify({
        mcpServers: {
          "mcp-status": {
            command: "node",
            args: [DELAYED_SERVER],
            env: { MCP_STARTUP_DELAY_MS: "750" },
          },
        },
      }),
    );

    host = AgentHost.createPhased({ dataRoot, pluginsDir });
    await host.whenReady();

    expect(
      (await host.skillCatalog()).find((skill) => skill.id === "health-report"),
    ).toMatchObject({ status: "loading" });

    const resolveTurn = (
      host as unknown as {
        resolveTurn(opts: { threadId: string }): Promise<unknown>;
      }
    ).resolveTurn.bind(host);
    await expect(
      Promise.race([
        resolveTurn({ threadId: "immediate-turn" }),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error("turn waited for MCP startup")), 200),
        ),
      ]),
    ).resolves.toBeDefined();

    await vi.waitFor(
      async () => {
        expect(
          (await host.skillCatalog()).find((skill) => skill.id === "health-report"),
        ).toMatchObject({ status: "ready" });
      },
      { timeout: 5_000, interval: 50 },
    );
  }, 10_000);

  it("waits for initial MCP discovery before starting automations", async () => {
    await host.close();
    const pluginMcpFile = join(pluginsDir, "example-mcp-status", ".mcp.json");
    writeFileSync(
      pluginMcpFile,
      JSON.stringify({
        mcpServers: {
          "mcp-status": {
            command: "node",
            args: [DELAYED_SERVER],
            env: { MCP_STARTUP_DELAY_MS: "750" },
          },
        },
      }),
    );

    host = AgentHost.createPhased({ dataRoot, pluginsDir });
    const start = vi.spyOn(host.triggerService, "start");
    const starting = host.startAutomations();
    await host.whenReady();

    expect(start).not.toHaveBeenCalled();

    await starting;
    expect(start).toHaveBeenCalledOnce();
    expect(
      (await host.skillCatalog()).find((skill) => skill.id === "health-report"),
    ).toMatchObject({ status: "ready" });
  }, 10_000);

  it("marks a skill unavailable when discovery exhausts its retries", async () => {
    await host.close();
    const pluginMcpFile = join(pluginsDir, "example-mcp-status", ".mcp.json");
    writeFileSync(
      pluginMcpFile,
      JSON.stringify({
        mcpServers: {
          "mcp-status": {
            command: "node",
            args: ["/no/such/server.js"],
          },
        },
      }),
    );

    host = await AgentHost.create({ dataRoot, pluginsDir });
    expect(
      (await host.skillCatalog()).find((skill) => skill.id === "health-report"),
    ).toMatchObject({ status: "unavailable" });
  }, 10_000);

  it("loads multiple servers from one config file", async () => {
    writeConfig({
      echo: { command: "node", args: [STATUS_SERVER] },
      remote: { type: "http", url: "https://example.com/mcp", enabled: false },
    });
    await host.reloadMcpServers();
    const ids = (await host.listMcpServers()).filter((r) => r.source === "user").map((r) => r.id);
    expect(ids).toContain("echo");
    expect(ids).toContain("remote");
  }, 30_000);

  it("expands `${ENV_VAR}` at connect time but keeps the raw reference on disk/in the list", async () => {
    process.env.STATUS_SERVER_PATH = STATUS_SERVER;
    try {
      writeConfig({ echo: { command: "node", args: ["${STATUS_SERVER_PATH}"] } });
      await host.reloadMcpServers();

      expect(await host.toolCatalog()).toHaveProperty("echo");

      const echo = (await host.listMcpServers()).find((r) => r.id === "echo");
      expect((echo!.entry as { args: string[] }).args[0]).toBe("${STATUS_SERVER_PATH}");
      const onDisk = JSON.parse(readFileSync(configFile, "utf8")) as { mcpServers: Record<string, { args: string[] }> };
      expect(onDisk.mcpServers.echo!.args[0]).toBe("${STATUS_SERVER_PATH}");
    } finally {
      delete process.env.STATUS_SERVER_PATH;
    }
  }, 30_000);

  it("invalidates a crashed server's tools and reports it crashed in /status", async () => {
    writeConfig({ echo: { command: "node", args: [STATUS_SERVER] } });
    await host.reloadMcpServers();
    expect(await host.toolCatalog()).toHaveProperty("echo");

    const client = host.plugins!.client as {
      getClient(server: string): Promise<{ transport?: { pid?: number | null } } | undefined>;
    };
    const conn = await client.getClient("echo");
    const pid = conn?.transport?.pid;
    expect(pid).toBeTypeOf("number");
    process.kill(pid!, "SIGKILL");

    await vi.waitFor(
      () => {
        expect(host.mcpHealthSnapshot().echo?.status).toBe("crashed");
      },
      { timeout: 5_000, interval: 50 },
    );

    const catalog = await host.toolCatalog();
    expect(catalog).not.toHaveProperty("echo");
    expect(catalog).toHaveProperty("mcp-status");

    const echo = (await host.listMcpServers()).find((r) => r.id === "echo");
    expect(echo?.status).toBe("crashed");
    expect(echo?.detail).toBeTypeOf("string");

    const app = buildApp(host);
    const res = await app.request("/mcp-servers");
    const { servers } = (await res.json()) as { servers: Array<{ id: string; status: string }> };
    expect(servers.find((r) => r.id === "echo")?.status).toBe("crashed");
  }, 30_000);
});
