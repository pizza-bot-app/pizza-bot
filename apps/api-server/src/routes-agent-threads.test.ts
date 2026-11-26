import { afterEach, describe, expect, it } from "vitest";
import { openAppDatabase, type AppDatabase, type ThreadRecord } from "@pizza-bot/storage";
import type { AgentCatalogEntry } from "@pizza-bot/core";
import type { AgentHost } from "./agent-host.js";
import { agentRoutes } from "./routes-agents.js";
import { langGraphRoutes } from "./routes-langgraph.js";

const open: AppDatabase[] = [];

const researcher: AgentCatalogEntry = {
  id: "researcher",
  name: "Researcher",
  description: "Finds sources.",
  systemPrompt: "Research.",
  source: "user",
  declaredTools: [],
  skills: [],
  interruptOn: {},
};

function testHost() {
  const appDb = openAppDatabase(":memory:");
  open.push(appDb);
  appDb.folders.create({ folderId: "projects", name: "Projects" });
  const host = {
    threadStore: appDb.threadStore,
    folderStore: appDb.folders,
    agentDefinition: async (id: string) => (id === researcher.id || id === "off" ? { ...researcher, id } : undefined),
    agentCatalog: async () => [
      { id: researcher.id, enabled: true },
      { id: "off", enabled: false },
    ],
  } as unknown as AgentHost;
  return { host, appDb };
}

function post(body: unknown): RequestInit {
  return { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) };
}

afterEach(() => {
  for (const appDb of open.splice(0)) appDb.close();
});

describe("POST /threads with an agent", () => {
  it("records the thread with its agent and folder before any run", async () => {
    const { host, appDb } = testHost();
    const response = await langGraphRoutes(host).request(
      "/threads",
      post({ thread_id: "t1", metadata: { agent_id: "researcher", folder_id: "projects" } }),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      thread_id: "t1",
      metadata: { agent_id: "researcher", folder_id: "projects" },
    });
    expect(appDb.threadStore.get("t1")).toMatchObject({ agentId: "researcher", folderId: "projects" });
  });

  it("refuses an unknown agent, a malformed id, and re-pointing an existing thread", async () => {
    const { host, appDb } = testHost();
    const routes = langGraphRoutes(host);
    expect((await routes.request("/threads", post({ thread_id: "t1", metadata: { agent_id: "ghost" } }))).status)
      .toBe(404);
    expect((await routes.request("/threads", post({ thread_id: "t1", metadata: { agent_id: 7 } }))).status)
      .toBe(400);
    expect(appDb.threadStore.get("t1")).toBeUndefined();

    appDb.threadStore.create({ threadId: "t2" });
    expect((await routes.request("/threads", post({ thread_id: "t2", metadata: { agent_id: "researcher" } }))).status)
      .toBe(409);
    expect(appDb.threadStore.get("t2")?.agentId).toBeUndefined();
  });
});

describe("POST /agents/:id/home", () => {
  it("creates the agent's pinned home thread once and returns it after", async () => {
    const { host } = testHost();
    const routes = agentRoutes(host);
    const created = await routes.request("/agents/researcher/home", { method: "POST" });
    expect(created.status).toBe(201);
    const home = (await created.json()) as ThreadRecord;
    expect(home).toMatchObject({ title: "Researcher", agentId: "researcher", agentHome: true, pinned: true });

    const again = await routes.request("/agents/researcher/home", { method: "POST" });
    expect(again.status).toBe(200);
    expect(((await again.json()) as ThreadRecord).threadId).toBe(home.threadId);
  });

  it("404s for an unknown agent and refuses a turned-off one", async () => {
    const { host, appDb } = testHost();
    expect((await agentRoutes(host).request("/agents/ghost/home", { method: "POST" })).status).toBe(404);
    expect((await agentRoutes(host).request("/agents/off/home", { method: "POST" })).status).toBe(409);
    expect((await langGraphRoutes(host).request("/threads", post({ thread_id: "t9", metadata: { agent_id: "off" } }))).status)
      .toBe(409);
    expect(appDb.threadStore.agentHome("off")).toBeUndefined();
  });
});
