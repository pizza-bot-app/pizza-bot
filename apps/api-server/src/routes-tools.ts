import { Hono } from "hono";
import type { SkillInfo } from "@pizza-bot/core";
import type { AgentHost } from "./agent-host.js";

export interface ToolInfo {
  ref: string;
  name: string;
  description?: string;
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
    const builtins: ToolInfo[] = host.builtinTools();
    const servers: ToolServerInfo[] = Object.entries(catalog).map(([server, tools]) => ({
      server,
      wildcard: `mcp:${server}:*`,
      tools: tools.map((name) => {
        const ref = `mcp:${server}:${name}`;
        const description = host.mcpToolDescription(ref);
        return description ? { ref, name, description } : { ref, name };
      }).sort((a, b) => a.name.localeCompare(b.name)),
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
