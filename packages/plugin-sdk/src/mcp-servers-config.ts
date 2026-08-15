/** Reads Claude Code MCP config while keeping environment references raw on disk. */
import { chmod, readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";
import {
  mcpServerEntrySchema,
  type McpServerEntry,
} from "@pizza-bot/plugin-api";

/**
 * Entries remain unknown here so each can be validated independently without one
 * invalid server rejecting the entire file.
 */
export const mcpConfigFileSchema = z.object({
  mcpServers: z.record(z.string(), z.unknown()).default({}),
});

type OnError = (file: string, err: unknown) => void;
const defaultOnError: OnError = (file, err) =>
  console.warn(`[mcp] skipping ${file}: ${err instanceof Error ? err.message : String(err)}`);

/**
 * Missing or unreadable files produce an empty map. Invalid entries are reported
 * individually while valid siblings continue loading.
 */
export async function loadUserMcpServers(
  configFile: string,
  onError: OnError = defaultOnError,
): Promise<Record<string, McpServerEntry>> {
  let raw: string;
  try {
    raw = await readFile(configFile, "utf8");
  } catch {
    return {};
  }
  let wrapper: z.infer<typeof mcpConfigFileSchema>;
  try {
    wrapper = mcpConfigFileSchema.parse(JSON.parse(raw));
  } catch (err) {
    onError(configFile, err);
    return {};
  }
  const out: Record<string, McpServerEntry> = {};
  for (const [id, entry] of Object.entries(wrapper.mcpServers)) {
    const parsed = mcpServerEntrySchema.safeParse(entry);
    if (parsed.success) out[id] = parsed.data;
    else onError(configFile, new Error(`invalid MCP server "${id}": ${parsed.error.message}`));
  }
  return out;
}

export async function writeUserMcpServers(
  configFile: string,
  servers: Record<string, McpServerEntry>,
): Promise<void> {
  const directory = dirname(configFile);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  await writeFile(
    configFile,
    JSON.stringify({ mcpServers: servers }, null, 2) + "\n",
    { encoding: "utf8", mode: 0o600 },
  );
  await chmod(configFile, 0o600);
}

function expandEnvString(s: string): string {
  return s.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_m, name: string) => process.env[name] ?? "");
}

/**
 * Expands environment references in a copy destined for a live connection.
 * Never write the result back to disk because it may contain resolved secrets.
 */
export function expandMcpEnvVars<T>(value: T): T {
  if (typeof value === "string") return expandEnvString(value) as T;
  if (Array.isArray(value)) return value.map((v) => expandMcpEnvVars(v)) as T;
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = expandMcpEnvVars(v);
    return out as T;
  }
  return value;
}
