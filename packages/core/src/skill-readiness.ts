import type { SkillCatalog, SkillCatalogEntry } from "./skill.js";
import { expandToolPattern, isWildcard, type ToolCatalog } from "./wildcard.js";

export type SkillReadinessStatus = "loading" | "ready" | "unavailable";

export interface SkillReadiness {
  status: SkillReadinessStatus;
  detail?: string;
}

export interface SkillAvailability extends SkillReadiness {
  id: string;
  name: string;
}

export interface McpDependencyState {
  status: "loading" | "ready" | "unavailable";
  detail?: string;
}

export interface SkillReadinessContext {
  catalog: ToolCatalog;
  tools: ReadonlySet<string>;
  mcpServers: ReadonlyMap<string, McpDependencyState>;
  builtins: ReadonlySet<string>;
}

function unavailable(detail: string): SkillReadiness {
  return { status: "unavailable", detail };
}

function loading(detail: string): SkillReadiness {
  return { status: "loading", detail };
}

/** A skill is callable only when every declared dependency is usable. */
export function evaluateSkillReadiness(
  skill: SkillCatalogEntry,
  context: SkillReadinessContext,
): SkillReadiness {
  let pending: string | undefined;

  for (const ref of skill.declaredTools) {
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

export function projectSkillReadiness(
  skills: SkillCatalog,
  context: SkillReadinessContext,
): {
  ready: SkillCatalog;
  availability: SkillAvailability[];
} {
  const ready: SkillCatalog = new Map();
  const availability: SkillAvailability[] = [];
  for (const [id, skill] of skills) {
    const state = evaluateSkillReadiness(skill, context);
    availability.push({ id, name: skill.name, ...state });
    if (state.status === "ready") ready.set(id, skill);
  }
  return { ready, availability };
}
