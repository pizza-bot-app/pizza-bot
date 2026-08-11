/** Resolves node-family stdio commands when no ambient shell PATH is available. */
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { basename, delimiter, dirname, isAbsolute, join } from "node:path";

const NODE_FAMILY = new Set(["node", "npx", "npm", "corepack"]);

export function isNodeFamilyCommand(command: string): boolean {
  return NODE_FAMILY.has(command);
}

/**
 * Checks `PIZZA_NODE_PATH`, the platform path lookup, then common installation
 * locations.
 */
export function findSystemNode(): string | undefined {
  if (process.env.PIZZA_NODE_PATH && existsSync(process.env.PIZZA_NODE_PATH)) {
    return process.env.PIZZA_NODE_PATH;
  }
  try {
    const which = process.platform === "win32" ? "where" : "which";
    const out = execFileSync(which, ["node"], { encoding: "utf8" }).split(/\r?\n/)[0]?.trim();
    if (out && existsSync(out)) return out;
  } catch {
    // Continue with known installation locations.
  }
  const home = homedir();
  const knownPaths = ["/usr/local/bin/node", "/opt/homebrew/bin/node", "/usr/bin/node"];
  if (process.platform !== "win32") {
    knownPaths.push(
      join(home, ".nix-profile", "bin", "node"),
      `/etc/profiles/per-user/${basename(home)}/bin/node`,
      "/run/current-system/sw/bin/node",
      "/nix/var/nix/profiles/default/bin/node",
    );
  }
  for (const p of knownPaths) {
    if (existsSync(p)) return p;
  }
  return undefined;
}

/** Resolves the MCP-specific override before ordinary system discovery. */
export function findMcpNode(): string | undefined {
  if (
    process.env.PIZZA_MCP_NODE_PATH &&
    existsSync(process.env.PIZZA_MCP_NODE_PATH)
  ) {
    return process.env.PIZZA_MCP_NODE_PATH;
  }
  return findSystemNode();
}

export interface ResolveMcpCommandOptions {
  /** Preferred Node binary; system discovery is the fallback. */
  nodePath?: string;
}

export interface ResolvedMcpCommand {
  command: string;
  /** Directory to prepend so sibling executables resolve in the child. */
  pathDir?: string;
}

/**
 * Absolute and non-node commands pass through. An unresolved node-family command
 * returns `null` so the caller can skip it instead of spawning an `ENOENT`.
 */
export function resolveMcpCommand(
  command: string,
  opts: ResolveMcpCommandOptions = {},
): ResolvedMcpCommand | null {
  if (isAbsolute(command)) {
    return { command };
  }

  if (!isNodeFamilyCommand(command)) {
    return { command };
  }

  if (opts.nodePath && existsSync(opts.nodePath)) {
    const dir = dirname(opts.nodePath);
    if (command === "node") {
      return { command: opts.nodePath, pathDir: dir };
    }
    const sibling = join(dir, process.platform === "win32" ? `${command}.cmd` : command);
    if (existsSync(sibling)) {
      return { command: sibling, pathDir: dir };
    }
  }

  const systemNode = findSystemNode();
  if (systemNode) {
    const dir = dirname(systemNode);
    if (command === "node") {
      return { command: systemNode, pathDir: dir };
    }
    const sibling = join(dir, process.platform === "win32" ? `${command}.cmd` : command);
    if (existsSync(sibling)) {
      return { command: sibling, pathDir: dir };
    }
    // Preserve the bare command but expose the discovered Node directory.
    return { command, pathDir: dir };
  }

  return null;
}

export function prependPath(dir: string, existing: string | undefined): string {
  if (!existing) return dir;
  const parts = existing.split(delimiter);
  if (parts[0] === dir) return existing;
  return `${dir}${delimiter}${existing}`;
}
