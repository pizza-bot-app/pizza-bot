import { Hono } from "hono";
import { BUILTIN_EVAL_TOOL_REF, type SkillInfo } from "@pizza-bot/core";
import type { AgentHost } from "./agent-host.js";

export interface ToolInfo {
  ref: string;
  name: string;
}

export interface ToolServerInfo {
  server: string;
  wildcard: string;
  tools: ToolInfo[];
}

export interface ToolsResponse {
  builtins: ToolInfo[];
  servers: ToolServerInfo[];
}

export interface SkillsResponse {
  skills: SkillInfo[];
}

export function toolsRoutes(host: AgentHost): Hono {
  const app = new Hono();

  app.get("/tools", async (c) => {
    const catalog = await host.toolCatalog();
    const builtins: ToolInfo[] = [
      { ref: BUILTIN_EVAL_TOOL_REF, name: "eval" },
    ];
    const servers: ToolServerInfo[] = Object.entries(catalog).map(([server, tools]) => ({
      server,
      wildcard: `mcp:${server}:*`,
      tools: tools.map((name) => ({ ref: `mcp:${server}:${name}`, name })),
    }));
    servers.sort((a, b) => a.server.localeCompare(b.server));
    return c.json({ builtins, servers } satisfies ToolsResponse);
  });

  app.get("/skills", async (c) => {
    const skills = await host.skillCatalog();
    skills.sort((a, b) => a.name.localeCompare(b.name));
    return c.json({ skills } satisfies SkillsResponse);
  });

  return app;
}
