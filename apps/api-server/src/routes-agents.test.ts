import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { RuntimeDeps } from "@pizza-bot/core";
import { parseAgentMd } from "@pizza-bot/plugin-sdk";
import { AgentHost } from "./agent-host.js";
import { buildApp } from "./index.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const STATUS_PLUGIN = resolve(__dirname, "../../../examples/plugins/mcp-status");
const STATUS_SERVER = resolve(STATUS_PLUGIN, "src/server.js");

const planner = {
  name: "Week Planner",
  description: "Plans the user's week.",
  systemPrompt: "You plan weeks.",
  model: "bedrock:global.anthropic.claude-sonnet-5",
  declaredTools: ["mcp:mcp-status:get_mcp_status", "builtin:eval"],
  skills: ["pizza-bot-guide"],
  interruptOn: { "mcp:mcp-status:get_mcp_status": { allowedDecisions: ["approve", "reject"] } },
};

describe("agent routes", () => {
  let dataRoot: string;
  let host: AgentHost;
  let app: ReturnType<typeof buildApp>;
  const prevMcpConfig = process.env.PIZZA_MCP_CONFIG;
  const prevAgentsDir = process.env.PIZZA_AGENTS_DIR;

  const json = (method: string, body: unknown) => ({
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const runtimeDeps = () =>
    (host as unknown as { graphs: { dependencies: RuntimeDeps } }).graphs.dependencies;
  const listed = async (id: string) =>
    ((await (await app.request("/agents")).json()) as {
      agents: Array<{ id: string; enabled: boolean; status: string; statusDetail?: string }>;
    }).agents.find((agent) => agent.id === id);

  beforeEach(async () => {
    dataRoot = mkdtempSync(join(tmpdir(), "route-agents-data-"));
    const pluginsDir = join(dataRoot, "plugin-fixtures");
    mkdirSync(pluginsDir);
    const pluginDir = join(pluginsDir, "example-mcp-status");
    cpSync(STATUS_PLUGIN, pluginDir, { recursive: true });
    writeFileSync(
      join(pluginDir, ".mcp.json"),
      JSON.stringify({ mcpServers: { "mcp-status": { command: "node", args: [STATUS_SERVER] } } }),
    );
    process.env.PIZZA_MCP_CONFIG = join(dataRoot, ".mcp.json");
    delete process.env.PIZZA_AGENTS_DIR;
    host = await AgentHost.create({ dataRoot, pluginsDir });
    app = buildApp(host);
  });

  afterEach(async () => {
    await host.close();
    rmSync(dataRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    if (prevMcpConfig === undefined) delete process.env.PIZZA_MCP_CONFIG;
    else process.env.PIZZA_MCP_CONFIG = prevMcpConfig;
    if (prevAgentsDir === undefined) delete process.env.PIZZA_AGENTS_DIR;
    else process.env.PIZZA_AGENTS_DIR = prevAgentsDir;
  });

  it("creates, updates, and deletes a user agent as agents/<id>.md", async () => {
    const created = await app.request("/agents", json("POST", { id: "planner", ...planner }));
    expect(created.status).toBe(201);
    expect(await created.json()).toMatchObject({ id: "planner", source: "user", ...planner });

    const file = join(dataRoot, "agents", "planner.md");
    expect(parseAgentMd("planner", readFileSync(file, "utf8"), { source: "user" })).toEqual({
      id: "planner",
      source: "user",
      ...planner,
    });
    expect(await (await app.request("/agents/planner")).json()).toMatchObject(planner);

    const patched = await app.request(
      "/agents/planner",
      json("PATCH", { ...planner, model: "inherit", description: "Plans the month." }),
    );
    expect(patched.status).toBe(200);
    const updated = await patched.json();
    expect(updated).toMatchObject({ description: "Plans the month." });
    expect(updated).not.toHaveProperty("model");
    expect(readFileSync(file, "utf8")).not.toMatch(/^model:/m);

    expect((await app.request("/agents/planner", { method: "DELETE" })).status).toBe(200);
    expect(existsSync(file)).toBe(false);
    expect((await app.request("/agents/planner")).status).toBe(404);
  }, 30_000);

  it.each([
    [{ ...planner, declaredTools: ["not-a-ref"] }, "invalid tool ref"],
    [{ ...planner, interruptOn: { "mcp:mcp-status:other": true } }, "is not granted"],
    [{ ...planner, description: " " }, "description is required"],
    [{ ...planner, skills: ["../escape"] }, "invalid skill id"],
  ])("rejects an invalid definition (%#)", async (body, detail) => {
    const response = await app.request("/agents", json("POST", { id: "planner", ...body }));
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: "invalid", detail: expect.stringContaining(detail) });
  }, 30_000);

  it("reserves the orchestrator id and shipped agent ids", async () => {
    expect((await app.request("/agents", json("POST", { id: "pizza-bot", ...planner }))).status)
      .toBe(409);
    expect((await app.request("/agents", json("POST", { id: "health-report", ...planner }))).status)
      .toBe(409);
  }, 30_000);

  it("lists plugin agents with readiness and returns 404 for an unknown agent", async () => {
    expect(await listed("health-report")).toMatchObject({ enabled: true, status: "ready" });
    expect((await app.request("/agents/missing")).status).toBe(404);
  }, 30_000);

  it("refuses to enable an agent whose MCP server is disabled", async () => {
    expect(
      (await app.request("/agents/health-report/enabled", json("PUT", { enabled: false }))).status,
    ).toBe(200);
    expect(
      (await app.request("/mcp-servers/mcp-status/enabled", json("PUT", { enabled: false }))).status,
    ).toBe(200);

    const response = await app.request("/agents/health-report/enabled", json("PUT", { enabled: true }));
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      error: "dependency_disabled",
      blockers: [{ id: "mcp-status", reason: "disabled" }],
    });
    expect((await app.request("/agents/missing/enabled", json("PUT", { enabled: true }))).status)
      .toBe(404);
  }, 30_000);

  it("moves a skill an agent mounts off the orchestrator", async () => {
    expect(runtimeDeps().rootSkills).toContain("pizza-bot-guide");
    const { model: _model, declaredTools: _tools, interruptOn: _interruptOn, ...guideAgent } = planner;
    expect((await app.request("/agents", json("POST", { id: "guide", ...guideAgent }))).status)
      .toBe(201);

    expect(runtimeDeps().rootSkills ?? []).not.toContain("pizza-bot-guide");
    expect(runtimeDeps().skills?.has("pizza-bot-guide")).toBe(true);
    expect(await listed("guide")).toMatchObject({ status: "ready" });
  }, 30_000);

  it("reports an agent whose pinned model cannot resolve as unavailable", async () => {
    const { declaredTools: _tools, interruptOn: _interruptOn, ...pinned } = planner;
    const response = await app.request(
      "/agents",
      json("POST", { id: "pinned", ...pinned, model: "nope:missing-model" }),
    );
    expect(response.status).toBe(201);

    expect(await listed("pinned")).toMatchObject({
      enabled: true,
      status: "unavailable",
      statusDetail: expect.stringContaining("nope"),
    });
    expect(host.agent).toBeDefined();
  }, 30_000);
});
