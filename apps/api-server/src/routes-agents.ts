import { Hono } from "hono";
import { access, rm, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import {
  INHERIT_MODEL,
  PIZZA_BOT_AGENT,
  interruptConfigSchema,
  interruptToolRefSchema,
  toolRefSchema,
  type AgentCatalogEntry,
  type AgentInfo,
  type InterruptOnPolicy,
} from "@pizza-bot/core";
import { AGENT_FILE_EXT, composeAgentMd } from "@pizza-bot/plugin-sdk";
import { CapabilityDependencyError, type AgentHost } from "./agent-host.js";
import { RESOURCE_ID_RE, fileResourceRoutes, type ParseResult } from "./resource-crud.js";

interface AgentFields {
  name: string;
  description: string;
  systemPrompt: string;
  model?: string;
  declaredTools: string[];
  skills: string[];
  interruptOn: InterruptOnPolicy;
}

export type AgentDefinitionWire = Omit<AgentCatalogEntry, "model"> & { model?: string };

export interface AgentsResponse {
  agents: AgentInfo[];
}

function parseRefList(
  raw: unknown,
  valid: (ref: string) => boolean,
  label: string,
): string[] | { detail: string } {
  const out: string[] = [];
  for (const item of Array.isArray(raw) ? raw : []) {
    if (typeof item !== "string") continue;
    const ref = item.trim();
    if (!ref || out.includes(ref)) continue;
    if (!valid(ref)) return { detail: `invalid ${label} "${ref}"` };
    out.push(ref);
  }
  return out;
}

function parseBody(raw: unknown): ParseResult<AgentFields> {
  const b = (raw ?? {}) as Record<string, unknown>;
  const name = typeof b.name === "string" ? b.name.trim() : "";
  const description = typeof b.description === "string" ? b.description.trim() : "";
  const systemPrompt = typeof b.systemPrompt === "string" ? b.systemPrompt : "";
  if (!name) return { ok: false, detail: "name is required" };
  if (!description) return { ok: false, detail: "description is required" };
  const model = typeof b.model === "string" ? b.model.trim() : "";

  const declaredTools = parseRefList(b.declaredTools, (ref) => toolRefSchema.safeParse(ref).success, "tool ref");
  if (!Array.isArray(declaredTools)) return { ok: false, ...declaredTools };
  const skills = parseRefList(b.skills, (id) => RESOURCE_ID_RE.test(id), "skill id");
  if (!Array.isArray(skills)) return { ok: false, ...skills };

  const interruptOn: InterruptOnPolicy = {};
  const rawInterruptOn =
    b.interruptOn && typeof b.interruptOn === "object" && !Array.isArray(b.interruptOn)
      ? b.interruptOn as Record<string, unknown>
      : {};
  for (const [rawRef, config] of Object.entries(rawInterruptOn)) {
    const ref = rawRef.trim();
    if (!interruptToolRefSchema.safeParse(ref).success) {
      return { ok: false, detail: `invalid interruptOn tool ref "${ref}"` };
    }
    if (!declaredTools.includes(ref)) {
      return { ok: false, detail: `interruptOn tool "${ref}" is not granted to this agent` };
    }
    const parsed = interruptConfigSchema.safeParse(config);
    if (!parsed.success) return { ok: false, detail: `invalid interruptOn config for "${ref}"` };
    interruptOn[ref] = parsed.data;
  }

  return {
    ok: true,
    name,
    description,
    systemPrompt,
    ...(model && model !== INHERIT_MODEL ? { model } : {}),
    declaredTools,
    skills,
    interruptOn,
  };
}

function agentPath(agentsDir: string, id: string): string {
  return join(agentsDir, `${id}${AGENT_FILE_EXT}`);
}

export function agentRoutes(host: AgentHost): Hono {
  const app = fileResourceRoutes<string, AgentFields>({
    base: "/agents",
    disabledError: "agents_disabled",
    container: () => host.agentsDirectory().then((d) => d || null),
    parse: parseBody,
    exists: (agentsDir, id) => access(agentPath(agentsDir, id)).then(() => true, () => false),
    patchable: (_agentsDir, id) =>
      host.agentDefinition(id).then((entry) => entry !== undefined && entry.source !== "user"),
    reserved: async (_agentsDir, id) =>
      id === PIZZA_BOT_AGENT.id || Boolean(await host.agentDefinition(id)),
    write: async (agentsDir, id, fields) => {
      await mkdir(agentsDir, { recursive: true });
      await writeFile(agentPath(agentsDir, id), composeAgentMd({ id, ...fields }), "utf8");
    },
    remove: async (agentsDir, id) => {
      await rm(agentPath(agentsDir, id), { force: true });
      host.clearUserAgentPreference(id);
    },
    reload: () => host.reloadAgents(),
    present: async (id, fields) =>
      (await host.agentDefinition(id)) ?? { id, ...fields, source: "user" },
  });

  app.get("/agents", async (c) => {
    const agents = await host.agentCatalog();
    agents.sort((a, b) => a.name.localeCompare(b.name));
    return c.json({ agents } satisfies AgentsResponse);
  });

  app.get("/agents/:id", async (c) => {
    const entry = await host.agentDefinition(c.req.param("id"));
    return entry ? c.json(entry satisfies AgentDefinitionWire) : c.json({ error: "not_found" }, 404);
  });

  app.post("/agents/generate", async (c) => {
    if (!(await host.agentsDirectory())) return c.json({ error: "agents_disabled" }, 409);
    const body = (await c.req.json().catch(() => ({}))) as { prompt?: unknown };
    const prompt = typeof body.prompt === "string" ? body.prompt.trim() : "";
    if (prompt.length === 0) return c.json({ error: "invalid", detail: "prompt is required" }, 400);
    try {
      return c.json(await host.generateAgentDraft(prompt));
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      console.error("[agents] generate failed:", detail);
      return c.json({ error: "generate_failed", detail }, 500);
    }
  });

  app.put("/agents/:id/enabled", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { enabled?: unknown };
    if (typeof body.enabled !== "boolean") {
      return c.json({ error: "invalid", detail: "enabled must be a boolean" }, 400);
    }
    try {
      const agent = await host.setAgentEnabled(c.req.param("id"), body.enabled);
      return agent ? c.json(agent) : c.json({ error: "not_found" }, 404);
    } catch (error) {
      if (error instanceof CapabilityDependencyError) {
        return c.json({ error: error.code, detail: error.message, blockers: error.blockers }, 409);
      }
      throw error;
    }
  });

  return app;
}
