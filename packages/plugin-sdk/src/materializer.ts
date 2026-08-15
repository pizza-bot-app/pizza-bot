import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  mkdir,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import {
  basename,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import type {
  PluginManifest,
  PluginMaterializer,
  PluginMaterializerReason,
} from "@pizza-bot/plugin-api";
import { FsPluginLoader } from "./loader.js";
import { ContributionRegistry } from "./registry.js";
import { loadSkillCatalog } from "./skill-catalog.js";

const STATE_FILE = "state.json";
const SNAPSHOTS_DIR = "snapshots";
const MAX_DIAGNOSTIC_BYTES = 64 * 1024;

export type PluginMaterializationState = "synced" | "stale" | "error";

export interface PluginMaterializationStatus {
  state: PluginMaterializationState;
  sourceRoots: string[];
  lastSyncedAt?: string;
  detail?: string;
}

export interface MaterializedPlugin {
  root?: string;
  status: PluginMaterializationStatus;
}

interface PersistedMaterializationState {
  snapshot: string;
  lastSyncedAt: string;
}

export interface MaterializePluginOptions {
  pluginRoot: string;
  manifest: PluginManifest;
  cacheRoot: string;
  reason: PluginMaterializerReason;
}

export async function materializePlugin(
  options: MaterializePluginOptions,
): Promise<MaterializedPlugin> {
  const materializer =
    options.manifest.extensions?.["dev.pizzabot.materializer"];
  if (!materializer) {
    return {
      root: options.pluginRoot,
      status: { state: "synced", sourceRoots: [] },
    };
  }

  const sourceRoots = materializer.sourceRoots.map(expandUserPath);
  const cacheDir = join(options.cacheRoot, options.manifest.name);
  const previous = await readState(cacheDir);
  const previousRoot = previous
    ? join(cacheDir, SNAPSHOTS_DIR, previous.snapshot)
    : undefined;

  if (!materializer.sync.includes(options.reason)) {
    if (previous && previousRoot && (await isDirectory(previousRoot))) {
      return {
        root: previousRoot,
        status: {
          state: "synced",
          sourceRoots,
          lastSyncedAt: previous.lastSyncedAt,
        },
      };
    }
    return {
      status: {
        state: "error",
        sourceRoots,
        detail: `Materializer is not configured for ${options.reason} synchronization`,
      },
    };
  }

  await mkdir(join(cacheDir, SNAPSHOTS_DIR), { recursive: true });
  await pruneSnapshots(cacheDir, previous?.snapshot);
  const id = snapshotId();
  const staging = join(cacheDir, `.staging-${id}`);
  const snapshot = join(cacheDir, SNAPSHOTS_DIR, id);
  await mkdir(staging, { recursive: false });

  try {
    const entrypoint = await resolveEntrypoint(
      options.pluginRoot,
      materializer,
    );
    await runMaterializer({
      entrypoint,
      pluginRoot: options.pluginRoot,
      pluginName: options.manifest.name,
      outputDir: staging,
      sourceRoots,
      timeoutMs: materializer.timeoutMs,
    });
    await validateOutput(staging, options.manifest.name);
    await rename(staging, snapshot);
    const lastSyncedAt = new Date().toISOString();
    await writeState(cacheDir, { snapshot: id, lastSyncedAt });
    return {
      root: snapshot,
      status: { state: "synced", sourceRoots, lastSyncedAt },
    };
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    const detail = error instanceof Error ? error.message : String(error);
    if (previousRoot && (await isDirectory(previousRoot))) {
      return {
        root: previousRoot,
        status: {
          state: "stale",
          sourceRoots,
          lastSyncedAt: previous!.lastSyncedAt,
          detail,
        },
      };
    }
    return {
      status: { state: "error", sourceRoots, detail },
    };
  }
}

async function validateOutput(
  root: string,
  expectedName: string,
): Promise<void> {
  const loader = new FsPluginLoader();
  const manifest = await loader.readManifest(
    join(root, ".claude-plugin", "plugin.json"),
  );
  if (manifest.name !== expectedName) {
    throw new Error(
      `Materialized plugin name "${manifest.name}" does not match "${expectedName}"`,
    );
  }
  if (manifest.extensions?.["dev.pizzabot.materializer"]) {
    throw new Error("Materialized output cannot declare another materializer");
  }
  const registry = new ContributionRegistry();
  await loader.load(manifest, root, registry);
  const skillErrors: string[] = [];
  const skills = await loadSkillCatalog(registry, (message) => {
    if (message.startsWith("skipping skill ")) skillErrors.push(message);
  });
  if (skills.size !== registry.skills.size) {
    throw new Error(skillErrors[0] ?? "Materialized output contains an invalid skill");
  }
}

interface RunMaterializerOptions {
  entrypoint: string;
  pluginRoot: string;
  pluginName: string;
  outputDir: string;
  sourceRoots: string[];
  timeoutMs: number;
}

async function runMaterializer(options: RunMaterializerOptions): Promise<void> {
  await new Promise<void>((resolveRun, rejectRun) => {
    const child = spawn(
      process.execPath,
      [options.entrypoint, ...options.sourceRoots],
      {
        cwd: options.pluginRoot,
        env: {
          ...process.env,
          PIZZA_MATERIALIZER_OUTPUT_DIR: options.outputDir,
          PIZZA_MATERIALIZER_PLUGIN_NAME: options.pluginName,
          PIZZA_MATERIALIZER_PLUGIN_ROOT: options.pluginRoot,
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let settled = false;
    let timeoutError: Error | undefined;
    let stdout: Uint8Array = new Uint8Array();
    let stderr: Uint8Array = new Uint8Array();
    const append = (
      current: Uint8Array,
      chunk: Uint8Array,
    ): Uint8Array =>
      Buffer.concat([current, chunk]).subarray(0, MAX_DIAGNOSTIC_BYTES);
    child.stdout.on("data", (chunk: Uint8Array) => {
      stdout = append(stdout, chunk);
    });
    child.stderr.on("data", (chunk: Uint8Array) => {
      stderr = append(stderr, chunk);
    });

    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) rejectRun(error);
      else resolveRun();
    };
    const timer = setTimeout(() => {
      timeoutError = new Error(
        `Materializer timed out after ${options.timeoutMs}ms`,
      );
      child.kill("SIGKILL");
    }, options.timeoutMs);
    timer.unref?.();

    child.once("error", (error) => finish(error));
    child.once("exit", (code, signal) => {
      if (timeoutError) {
        finish(timeoutError);
        return;
      }
      if (code === 0) {
        finish();
        return;
      }
      const diagnostic = Buffer.from(stderr).toString("utf8").trim()
        || Buffer.from(stdout).toString("utf8").trim();
      const suffix = diagnostic ? `: ${diagnostic}` : "";
      finish(
        new Error(
          `Materializer exited with ${signal ? `signal ${signal}` : `code ${code ?? "unknown"}`}${suffix}`,
        ),
      );
    });
  });
}

async function resolveEntrypoint(
  pluginRoot: string,
  materializer: PluginMaterializer,
): Promise<string> {
  const canonicalRoot = await realpath(pluginRoot);
  const candidate = resolve(
    canonicalRoot,
    materializer.entrypoint.replace(
      /\$\{(?:CLAUDE_PLUGIN_ROOT|PLUGIN_ROOT)\}/g,
      canonicalRoot,
    ),
  );
  const canonical = await realpath(candidate);
  const rel = relative(canonicalRoot, canonical);
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error("Materializer entrypoint escapes the plugin root");
  }
  if (!(await stat(canonical)).isFile()) {
    throw new Error("Materializer entrypoint is not a file");
  }
  return canonical;
}

function expandUserPath(value: string): string {
  const home = homedir();
  const expanded = value
    .replace(/\$\{HOME\}/g, home)
    .replace(/^~(?=$|[\\/])/, home);
  return resolve(expanded);
}

async function readState(
  cacheDir: string,
): Promise<PersistedMaterializationState | undefined> {
  try {
    const parsed = JSON.parse(
      await readFile(join(cacheDir, STATE_FILE), "utf8"),
    ) as Partial<PersistedMaterializationState>;
    if (
      typeof parsed.snapshot === "string"
      && basename(parsed.snapshot) === parsed.snapshot
      && typeof parsed.lastSyncedAt === "string"
    ) {
      return {
        snapshot: parsed.snapshot,
        lastSyncedAt: parsed.lastSyncedAt,
      };
    }
  } catch {
    // A missing or corrupt cache state is equivalent to no prior snapshot.
  }
  return undefined;
}

async function writeState(
  cacheDir: string,
  state: PersistedMaterializationState,
): Promise<void> {
  const temp = join(cacheDir, `${STATE_FILE}.tmp`);
  await writeFile(temp, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  await rename(temp, join(cacheDir, STATE_FILE));
}

async function pruneSnapshots(
  cacheDir: string,
  keep: string | undefined,
): Promise<void> {
  const snapshots = join(cacheDir, SNAPSHOTS_DIR);
  const entries = await readdir(snapshots, { withFileTypes: true }).catch(
    () => [],
  );
  await Promise.all(
    entries
      .filter((entry) => entry.isDirectory() && entry.name !== keep)
      .map((entry) =>
        rm(join(snapshots, entry.name), {
          recursive: true,
          force: true,
          maxRetries: 3,
          retryDelay: 100,
        }).catch(() => {}),
      ),
  );
}

async function isDirectory(path: string): Promise<boolean> {
  return stat(path)
    .then((value) => value.isDirectory())
    .catch(() => false);
}

function snapshotId(): string {
  return `${Date.now()}-${randomUUID()}`;
}
