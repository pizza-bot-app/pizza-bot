export type ToolReference = string;

export type ToolCatalog = Record<string, readonly string[]>;

export interface ExpandResult {
  expanded: ToolReference[];
  emptyWildcards: ToolReference[];
  invalid: ToolReference[];
}

export function isWildcard(ref: ToolReference): boolean {
  return ref.includes("*");
}

/**
 * Non-wildcard references pass through. Malformed wildcard patterns throw
 * {@link InvalidWildcardError}; valid patterns may match no tools.
 */
export function expandToolPattern(ref: ToolReference, catalog: ToolCatalog): ToolReference[] {
  if (!isWildcard(ref)) return [ref];

  const parts = ref.split(":");
  if (parts[0] !== "mcp" || parts.length !== 3) {
    throw new InvalidWildcardError(ref, "expected mcp:server:pattern");
  }
  const serverName = parts[1]!;
  const pattern = parts[2]!;
  if (pattern !== "*" && !pattern.endsWith("*")) {
    throw new InvalidWildcardError(ref, "wildcard must be at the end");
  }

  const prefix = pattern === "*" ? "" : pattern.slice(0, -1);
  const tools = catalog[serverName] ?? [];
  return tools
    .filter((t) => t.startsWith(prefix))
    .map((t) => `mcp:${serverName}:${t}`);
}

/**
 * Preserves order, removes duplicates, and reports invalid and unmatched
 * wildcards instead of failing the entire list.
 */
export function resolveToolReferences(
  refs: readonly ToolReference[],
  catalog: ToolCatalog,
): ExpandResult {
  const seen = new Set<ToolReference>();
  const expanded: ToolReference[] = [];
  const emptyWildcards: ToolReference[] = [];
  const invalid: ToolReference[] = [];

  for (const ref of refs) {
    if (!isWildcard(ref)) {
      if (!seen.has(ref)) {
        seen.add(ref);
        expanded.push(ref);
      }
      continue;
    }
    let matches: ToolReference[];
    try {
      matches = expandToolPattern(ref, catalog);
    } catch (err) {
      if (err instanceof InvalidWildcardError) {
        invalid.push(ref);
        continue;
      }
      throw err;
    }
    if (matches.length === 0) {
      emptyWildcards.push(ref);
      continue;
    }
    for (const m of matches) {
      if (!seen.has(m)) {
        seen.add(m);
        expanded.push(m);
      }
    }
  }

  return { expanded, emptyWildcards, invalid };
}

export class InvalidWildcardError extends Error {
  constructor(
    readonly reference: ToolReference,
    reason: string,
  ) {
    super(`Invalid wildcard reference "${reference}": ${reason}`);
    this.name = "InvalidWildcardError";
  }
}
