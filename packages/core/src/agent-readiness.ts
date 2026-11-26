import type { AgentCatalog, AgentCatalogEntry } from "./agent-definition.js";
import { expandToolPattern, isWildcard, type ToolCatalog } from "./wildcard.js";

export type AgentReadinessStatus = "loading" | "ready" | "unavailable";

export interface AgentReadiness {
  status: AgentReadinessStatus;
  detail?: string;
}

export interface AgentAvailability extends AgentReadiness {
  id: string;
  name: string;
}

export interface McpDependencyState {
  status: "loading" | "ready" | "unavailable";
  detail?: string;
}

export interface AgentReadinessContext {
  catalog: ToolCatalog;
  tools: ReadonlySet<string>;
  mcpServers: ReadonlyMap<string, McpDependencyState>;
  builtins: ReadonlySet<string>;
  /** Enabled skill ids an agent may mount. */
  skills: ReadonlySet<string>;
}

function unavailable(detail: string): AgentReadiness {
  return { status: "unavailable", detail };
}

function loading(detail: string): AgentReadiness {
  return { status: "loading", detail };
}

/** An agent is callable only when every declared tool and skill is usable. */
export function evaluateAgentReadiness(
  agent: Pick<AgentCatalogEntry, "declaredTools" | "skills">,
  context: AgentReadinessContext,
): AgentReadiness {
  let pending: string | undefined;

  for (const skill of agent.skills) {
    if (!context.skills.has(skill)) return unavailable(`skill ${skill} is missing or disabled`);
  }

  for (const ref of agent.declaredTools) {
    if (ref.startsWith("builtin:")) {
      if (!context.builtins.has(ref)) return unavailable(`${ref} is unavailable`);
      continue;
    }

    const [kind, server, tool] = ref.split(":");
    if (kind !== "mcp" || !server || !tool) {
      return unavailable(`${ref} is invalid`);
    }

    const serverState = context.mcpServers.get(server);
    if (!serverState) return unavailable(`${server} is not configured`);
    if (serverState.status === "unavailable") {
      return unavailable(serverState.detail ?? `${server} is unavailable`);
    }
    if (serverState.status === "loading") {
      pending ??= serverState.detail ?? `${server} is still loading`;
      continue;
    }

    if (isWildcard(ref)) {
      let matches: string[];
      try {
        matches = expandToolPattern(ref, context.catalog);
      } catch {
        return unavailable(`${ref} is invalid`);
      }
      if (!matches.some((match) => context.tools.has(match))) {
        return unavailable(`${ref} matched no tools`);
      }
      continue;
    }

    if (!context.tools.has(ref)) return unavailable(`${ref} was not discovered`);
  }

  return pending ? loading(pending) : { status: "ready" };
}

export function projectAgentReadiness(
  agents: AgentCatalog,
  context: AgentReadinessContext,
): {
  ready: AgentCatalog;
  availability: AgentAvailability[];
} {
  const ready: AgentCatalog = new Map();
  const availability: AgentAvailability[] = [];
  for (const [id, agent] of agents) {
    const state = evaluateAgentReadiness(agent, context);
    availability.push({ id, name: agent.name, ...state });
    if (state.status === "ready") ready.set(id, agent);
  }
  return { ready, availability };
}
