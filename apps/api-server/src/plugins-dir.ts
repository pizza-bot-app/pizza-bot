import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { resolveLayout } from "@pizza-bot/storage";

export function resolvePluginsDir(): string {
  const override = process.env.PIZZA_PLUGINS_DIR;
  if (override && override.length > 0) return override;
  const here = dirname(fileURLToPath(import.meta.url));
  return resolve(here, "../../../plugins");
}

/** Independently distributed plugins live outside both source and app updates. */
export function resolveExternalPluginsDirs(): string[] {
  const override = process.env.PIZZA_EXTERNAL_PLUGINS_DIRS;
  if (override) return override.split(delimiter).filter((entry) => entry.length > 0);
  return [join(homedir(), ".pizza-bot", "plugins")];
}

/** User-authored skills live with the rest of the mutable application data. */
export function resolveSkillsDir(dataRoot: string): string {
  const override = process.env.PIZZA_SKILLS_DIR;
  if (override && override.length > 0) return override;
  return resolveLayout(dataRoot).skillsDir;
}

/** Built-in skills are shipped with the source tree or packaged application. */
export function resolveBuiltinSkillsDir(): string {
  const override = process.env.PIZZA_BUILTIN_SKILLS_DIR;
  if (override && override.length > 0) return override;
  const here = dirname(fileURLToPath(import.meta.url));
  return resolve(here, "../../../skills");
}

export function resolveMemoriesDir(dataRoot: string): string | false {
  const override = process.env.PIZZA_MEMORIES_DIR;
  if (override && override.length > 0) return override;
  if (dataRoot === ":memory:" || dataRoot.startsWith("file::memory:")) return false;
  return resolveLayout(dataRoot).memoriesDir;
}

export function resolveMcpConfig(dataRoot: string): string | false {
  const override = process.env.PIZZA_MCP_CONFIG;
  if (override && override.length > 0) return override;
  if (dataRoot === ":memory:" || dataRoot.startsWith("file::memory:")) return false;
  return resolveLayout(dataRoot).mcpConfig;
}
