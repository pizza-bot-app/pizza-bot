import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { cpSync, mkdtempSync, mkdirSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { buildApp } from "./index.js";
import { AgentHost } from "./agent-host.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const STATUS_PLUGIN = resolve(__dirname, "../../../plugins/example-mcp-status");
const STATUS_SERVER = resolve(__dirname, "../../../plugins/example-mcp-status/src/server.js");

describe("mcp-server routes: GET/POST/PATCH/DELETE /mcp-servers", () => {
  let configFile: string;
  let dataRoot: string;
  let host: AgentHost;
  let app: ReturnType<typeof buildApp>;
  const prevMcpConfig = process.env.PIZZA_MCP_CONFIG;

  const readConfig = (): Record<string, Record<string, unknown>> =>
    existsSync(configFile)
      ? (JSON.parse(readFileSync(configFile, "utf8")) as { mcpServers?: Record<string, Record<string, unknown>> })
          .mcpServers ?? {}
      : {};

  beforeEach(async () => {
    dataRoot = mkdtempSync(join(tmpdir(), "route-mcp-data-"));
    configFile = join(dataRoot, ".mcp.json");
    const pluginsDir = join(dataRoot, "plugin-fixtures");
    mkdirSync(pluginsDir);
    const pluginDir = join(pluginsDir, "example-mcp-status");
    cpSync(STATUS_PLUGIN, pluginDir, { recursive: true });
    writeFileSync(
      join(pluginDir, ".mcp.json"),
      JSON.stringify({ mcpServers: { "mcp-status": { command: "node", args: [STATUS_SERVER] } } }),
    );
    process.env.PIZZA_MCP_CONFIG = configFile;
    host = await AgentHost.create({ dataRoot, pluginsDir });
    app = buildApp(host);
  });

  afterEach(async () => {
    await host.close();
    rmSync(dataRoot, { recursive: true, force: true });
    if (prevMcpConfig === undefined) delete process.env.PIZZA_MCP_CONFIG;
    else process.env.PIZZA_MCP_CONFIG = prevMcpConfig;
  });

  const post = (body: unknown) =>
    app.request("/mcp-servers", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  const list = async () =>
    ((await (await app.request("/mcp-servers")).json()) as { servers: Array<{ id: string; source: string; status: string; toolCount: number }> }).servers;

  it("lists the plugin-declared server with its live connection status", async () => {
    const servers = await list();
    const status = servers.find((s) => s.id === "mcp-status");
    expect(status).toBeDefined();
    expect(status!.source).toBe("plugin");
    expect(status!.status).toBe("connected");
    expect(status!.toolCount).toBeGreaterThan(0);
  }, 20_000);

  it("enforces skill and MCP enablement dependencies for plugin contributions", async () => {
    const initial = (await (await app.request("/mcp-servers")).json()) as {
      servers: Array<{
        id: string;
        enabled: boolean;
        dependentSkills: Array<{ id: string; enabled: boolean }>;
      }>;
    };
    expect(initial.servers.find((server) => server.id === "mcp-status")).toMatchObject({
      enabled: true,
      dependentSkills: [{ id: "health-report", enabled: true }],
    });

    const blockedServer = await app.request("/mcp-servers/mcp-status/enabled", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ enabled: false }),
    });
    expect(blockedServer.status).toBe(409);
    expect(await blockedServer.json()).toMatchObject({
      error: "resource_in_use",
      blockers: [{ id: "health-report" }],
    });

    const disabledSkill = await app.request("/skills/health-report/enabled", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ enabled: false }),
    });
    expect(disabledSkill.status).toBe(200);
    expect(await disabledSkill.json()).toMatchObject({
      id: "health-report",
      enabled: false,
      status: "disabled",
    });

    const disabledServer = await app.request("/mcp-servers/mcp-status/enabled", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ enabled: false }),
    });
    expect(disabledServer.status).toBe(200);
    expect(await disabledServer.json()).toMatchObject({
      id: "mcp-status",
      enabled: false,
      status: "disabled",
    });

    const blockedSkill = await app.request("/skills/health-report/enabled", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ enabled: true }),
    });
    expect(blockedSkill.status).toBe(409);
    expect(await blockedSkill.json()).toMatchObject({
      error: "dependency_disabled",
      blockers: [{ id: "mcp-status", reason: "disabled" }],
    });

    expect(
      (host as unknown as { graphs: { skills(): Map<string, unknown> } }).graphs
        .skills()
        ?.has("health-report") ?? false,
    ).toBe(false);

    expect(
      (
        await app.request("/mcp-servers/mcp-status/enabled", {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ enabled: true }),
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await app.request("/skills/health-report/enabled", {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ enabled: true }),
        })
      ).status,
    ).toBe(200);
  }, 30_000);

  it("identifies a missing dependency when an explicitly disabled skill is re-enabled", async () => {
    const created = await app.request("/skills", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        id: "ghost-review",
        name: "Ghost review",
        description: "Reviews a server that is not configured.",
        body: "Review the status.",
        declaredTools: ["mcp:ghost:*"],
      }),
    });
    expect(created.status).toBe(201);
    expect(
      (
        (await (await app.request("/skills")).json()) as {
          skills: Array<{ id: string; enabled: boolean; status: string }>;
        }
      ).skills.find((skill) => skill.id === "ghost-review"),
    ).toMatchObject({ enabled: true, status: "unavailable" });

    expect(
      (
        await app.request("/skills/ghost-review/enabled", {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ enabled: false }),
        })
      ).status,
    ).toBe(200);
    const response = await app.request("/skills/ghost-review/enabled", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ enabled: true }),
    });

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      error: "dependency_disabled",
      blockers: [{ id: "ghost", reason: "missing" }],
    });
  });

  it("blocks direct update and deletion of a user server required by an enabled skill", async () => {
    expect(
      (await post({ id: "echo", command: "node", args: [STATUS_SERVER] })).status,
    ).toBe(201);
    const skill = await app.request("/skills", {
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
    expect(skill.status).toBe(201);

    const patch = await app.request("/mcp-servers/echo", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        command: "node",
        args: [STATUS_SERVER],
        enabled: false,
      }),
    });
    expect(patch.status).toBe(409);
    expect(await patch.json()).toMatchObject({
      error: "resource_in_use",
      blockers: [{ id: "echo-review" }],
    });

    const remove = await app.request("/mcp-servers/echo", { method: "DELETE" });
    expect(remove.status).toBe(409);
    expect(await remove.json()).toMatchObject({
      error: "resource_in_use",
      blockers: [{ id: "echo-review" }],
    });
  }, 30_000);

  it("creates a user server: writes the config file, connects it live (tool in catalog)", async () => {
    const res = await post({ id: "echo", command: "node", args: [STATUS_SERVER] });
    expect(res.status).toBe(201);
    const created = (await res.json()) as { id: string; source: string; status: string };
    expect(created.source).toBe("user");
    expect(created.status).toBe("connected");

    expect(readConfig()).toHaveProperty("echo");
    const tools = (await (await app.request("/tools")).json()) as { servers: Array<{ server: string }> };
    expect(tools.servers.map((s) => s.server)).toContain("echo");
  }, 20_000);

  it("creates a disabled server without launching it", async () => {
    const res = await post({
      id: "later",
      command: "node",
      args: ["/no/such/server.js"],
      enabled: false,
    });
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ id: "later", status: "disabled" });
    expect(readConfig().later).toMatchObject({ enabled: false });
  }, 20_000);

  it("GET /mcp-servers/:id returns a user server's editable entry; 404 for a plugin", async () => {
    await post({ id: "echo", command: "node", args: [STATUS_SERVER] });
    const res = await app.request("/mcp-servers/echo");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { id: string; entry: { command: string } };
    expect(body.entry.command).toBe("node");
    expect((await app.request("/mcp-servers/mcp-status")).status).toBe(404);
  }, 20_000);

  it("rejects an unsafe id (400) and an invalid entry (400) without writing", async () => {
    expect((await post({ id: "../escape", command: "node" })).status).toBe(400);
    const bad = await post({ id: "nonsense", foo: "bar" });
    expect(bad.status).toBe(400);
    expect(readConfig()).not.toHaveProperty("nonsense");
  });

  it("refuses an id that collides with a plugin server (409)", async () => {
    const res = await post({ id: "mcp-status", command: "node", args: [STATUS_SERVER] });
    expect(res.status).toBe(409);
  }, 20_000);

  it("refuses to create the same id twice (409)", async () => {
    const entry = { id: "dup", url: "https://example.com/mcp", enabled: false };
    expect((await post(entry)).status).toBe(201);
    expect((await post(entry)).status).toBe(409);
  });

  it("patches a user server's entry and rewrites the config, preserving other servers", async () => {
    await post({ id: "remote", url: "https://one.example.com/mcp", enabled: false });
    await post({ id: "keep", url: "https://keep.example.com/mcp", enabled: false });
    const res = await app.request("/mcp-servers/remote", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url: "https://two.example.com/mcp", enabled: false }),
    });
    expect(res.status).toBe(200);
    const onDisk = readConfig();
    expect((onDisk.remote as { url: string }).url).toBe("https://two.example.com/mcp");
    expect((onDisk.keep as { url: string }).url).toBe("https://keep.example.com/mcp");
  }, 30_000);

  it("preserves a hidden source default during an unrelated server edit", async () => {
    await post({
      id: "later",
      command: "node",
      args: ["/no/such/server.js"],
      enabled: false,
    });
    const skill = await app.request("/skills", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        id: "later-review",
        name: "Later review",
        description: "Reviews the later server.",
        body: "Review the status.",
        declaredTools: ["mcp:later:*"],
      }),
    });
    expect(skill.status).toBe(201);

    const response = await app.request("/mcp-servers/later", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        command: "node",
        args: ["/still/not/launched.js"],
      }),
    });

    expect(response.status).toBe(200);
    expect(readConfig().later).toMatchObject({
      enabled: false,
      args: ["/still/not/launched.js"],
    });
  }, 20_000);

  it("PATCH/DELETE on a plugin server is refused (409, not editable)", async () => {
    const patch = await app.request("/mcp-servers/mcp-status", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ command: "node" }),
    });
    expect(patch.status).toBe(409);
    expect((await app.request("/mcp-servers/mcp-status", { method: "DELETE" })).status).toBe(409);
  }, 20_000);

  it("deletes a user server: removes it from the config and drops it from the catalog", async () => {
    await post({ id: "echo", command: "node", args: [STATUS_SERVER] });
    expect((await list()).some((s) => s.id === "echo")).toBe(true);

    const del = await app.request("/mcp-servers/echo", { method: "DELETE" });
    expect(del.status).toBe(200);
    expect(readConfig()).not.toHaveProperty("echo");
    const tools = (await (await app.request("/tools")).json()) as { servers: Array<{ server: string }> };
    expect(tools.servers.map((s) => s.server)).not.toContain("echo");
  }, 20_000);

  it("clears user preferences when skills and servers are deleted", async () => {
    await post({ id: "echo", command: "node", args: [STATUS_SERVER] });
    expect(
      (
        await app.request("/mcp-servers/echo/enabled", {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ enabled: false }),
        })
      ).status,
    ).toBe(200);
    expect((await app.request("/mcp-servers/echo", { method: "DELETE" })).status).toBe(200);
    expect(
      (await post({ id: "echo", command: "node", args: [STATUS_SERVER] })).status,
    ).toBe(201);
    expect(
      (await list()).find((server) => server.id === "echo"),
    ).toMatchObject({ status: "connected" });

    const createSkill = () =>
      app.request("/skills", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          id: "plain-review",
          name: "Plain review",
          description: "Reviews without tools.",
          body: "Review.",
        }),
      });
    expect((await createSkill()).status).toBe(201);
    expect(
      (
        await app.request("/skills/plain-review/enabled", {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ enabled: false }),
        })
      ).status,
    ).toBe(200);
    expect((await app.request("/skills/plain-review", { method: "DELETE" })).status).toBe(200);
    expect((await createSkill()).status).toBe(201);
    expect(
      (
        (await (await app.request("/skills")).json()) as {
          skills: Array<{ id: string; enabled: boolean }>;
        }
      ).skills.find((skill) => skill.id === "plain-review"),
    ).toMatchObject({ enabled: true });
  }, 30_000);
});

describe("mcp-server routes: disabled on an in-memory host (409)", () => {
  let host: AgentHost;
  let app: ReturnType<typeof buildApp>;

  beforeEach(async () => {
    host = await AgentHost.create({ dataRoot: ":memory:", pluginsDir: false });
    app = buildApp(host);
  });
  afterEach(async () => await host.close());

  it("refuses a create with 409 when the MCP config is disabled", async () => {
    const res = await app.request("/mcp-servers", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "x", url: "https://example.com/mcp" }),
    });
    expect(res.status).toBe(409);
  });
});
