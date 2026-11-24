/** Pure helpers shared by every tool list: grouping by source, filtering, and wildcard grants. */
import {
  BUILTIN_EVAL_TOOL_REF,
  expandToolPattern,
  InvalidWildcardError,
  isWildcard,
  type ToolCatalog,
} from "@pizza-bot/core";
import type { ToolCatalogInfo } from "@/api-client";

export const BUILTIN_SOURCE = "Built-in";

export interface ToolEntry {
  ref: string;
  name: string;
  source: string;
  description?: string;
}

export interface ToolGroup {
  source: string;
  /** Grants every tool in the group; built-ins have no wildcard. */
  wildcard?: string;
  tools: ToolEntry[];
}

export interface GrantedTool {
  ref: string;
  name: string;
  source: string;
  /** Tool names a wildcard grant expands to; absent for exact refs and disconnected servers. */
  matches?: string[];
}

export interface PatternSuggestion {
  ref: string;
  source: string;
  matches: string[];
}

export function toolGroups(catalog: ToolCatalogInfo): ToolGroup[] {
  const builtins: ToolGroup[] = catalog.builtins.length
    ? [{ source: BUILTIN_SOURCE, tools: catalog.builtins.map((t) => ({ ...t, source: BUILTIN_SOURCE })) }]
    : [];
  return [
    ...builtins,
    ...catalog.servers.map((s) => ({
      source: s.server,
      wildcard: s.wildcard,
      tools: s.tools.map((t) => ({ ...t, source: s.server })),
    })),
  ];
}

export function filterTools<T extends { name: string; description?: string }>(tools: T[], query: string): T[] {
  const q = query.trim().toLowerCase();
  if (!q) return tools;
  return tools.filter(
    (tool) => tool.name.toLowerCase().includes(q) || (tool.description ?? "").toLowerCase().includes(q),
  );
}

function namesBySource(catalog: ToolCatalogInfo): ToolCatalog {
  return Object.fromEntries(catalog.servers.map((s) => [s.server, s.tools.map((t) => t.name)]));
}

export function describeGrantedTool(ref: string, catalog: ToolCatalogInfo): GrantedTool {
  if (ref === BUILTIN_EVAL_TOOL_REF) return { ref, name: "eval", source: BUILTIN_SOURCE };
  const [, server = "", name = ref] = ref.split(":");
  if (!isWildcard(ref)) return { ref, name, source: server };
  const granted = { ref, name: name === "*" ? "All tools" : name, source: server };
  if (!catalog.servers.some((s) => s.server === server)) return granted;
  try {
    return { ...granted, matches: expandToolPattern(ref, namesBySource(catalog)).map((r) => r.split(":")[2]!) };
  } catch (err) {
    if (err instanceof InvalidWildcardError) return granted;
    throw err;
  }
}

/**
 * Turns a search into grantable patterns: `list_*` is tried on every server,
 * `<server>:list_*` or `mcp:<server>:list_*` on that server only, and a search naming
 * a server offers its `*`. Patterns matching nothing are dropped because the runtime
 * rejects an empty wildcard grant.
 */
export function patternSuggestions(
  query: string,
  catalog: ToolCatalogInfo,
): { suggestions: PatternSuggestion[]; error?: string } {
  const q = query.trim();
  if (!q) return { suggestions: [] };
  if (!q.includes("*")) {
    const lower = q.toLowerCase();
    return {
      suggestions: catalog.servers
        .filter((s) => s.tools.length > 0 && s.server.toLowerCase().includes(lower))
        .map((s) => ({ ref: s.wildcard, source: s.server, matches: s.tools.map((t) => t.name) })),
    };
  }
  const qualified = q.startsWith("mcp:") ? q : q.includes(":") ? `mcp:${q}` : undefined;
  if (qualified !== undefined && qualified.split(":").length !== 3) {
    return { suggestions: [], error: "Patterns look like <server>:<prefix>* or mcp:<server>:<prefix>*." };
  }
  const refs = qualified !== undefined ? [qualified] : catalog.servers.map((s) => `mcp:${s.server}:${q}`);
  const names = namesBySource(catalog);
  const suggestions: PatternSuggestion[] = [];
  try {
    for (const ref of refs) {
      const matches = expandToolPattern(ref, names).map((r) => r.split(":")[2]!);
      if (matches.length > 0) suggestions.push({ ref, source: ref.split(":")[1]!, matches });
    }
  } catch (err) {
    if (!(err instanceof InvalidWildcardError)) throw err;
    return { suggestions: [], error: "A * can only go at the end of a pattern." };
  }
  return { suggestions };
}

/** The first wildcard in `refs`, other than `ref` itself, whose matches include everything `ref` grants. */
export function coveringWildcard(ref: string, refs: readonly string[]): string | undefined {
  const [, server, name = ""] = ref.split(":");
  const own = name.endsWith("*") ? name.slice(0, -1) : name;
  return refs.find((other) => {
    if (other === ref || !isWildcard(other)) return false;
    const [, otherServer, pattern = ""] = other.split(":");
    return otherServer === server && pattern.endsWith("*") && own.startsWith(pattern.slice(0, -1));
  });
}
