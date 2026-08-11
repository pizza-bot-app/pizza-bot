/** Supervises the local API sidecar from handshake through shutdown. */
import { fork, execFileSync, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { findSystemNode } from "@pizza-bot/plugin-sdk/runtime-resolver";

/**
 * Development native modules target system Node's ABI, not Electron's. Resolve a
 * system Node when this process is Electron; plain Node can use its own executable.
 */
function resolveNodeExecPath(): { execPath?: string } {
  const isElectron = Boolean((process as { versions: { electron?: string } }).versions.electron);
  if (!isElectron) return {};
  const found = findSystemNode();
  return found ? { execPath: found } : {};
}

/**
 * Use the tsx CLI for the cross-package TS graph. Node strip-only mode rejects
 * parameter properties, and loader-only registration breaks vendored CJS interop.
 */
function defaultTsxCli(): string {
  const require = createRequire(import.meta.url);
  try {
    return require.resolve("tsx/cli");
  } catch {
    const pkg = require.resolve("tsx/package.json");
    return pathToFileURL(pkg).href;
  }
}

export interface SidecarHandshake {
  type: "ready";
  port: number;
  pid: number;
  apiVersion: string;
}

export interface SidecarOptions {
  serverModulePath: string;
  tsxCli?: string;
  nodePath?: string;
  /** Prevent native resolution from finding a wrong-ABI module outside the app. */
  nativeModulesPath?: string;
  /** Node binary for independent stdio MCP processes. */
  mcpNodePath?: string;
  dataRoot: string;
  apiToken?: string;
  /** CORS allowlist for the child; dev sets the Vite origin, packaged pages are origin "null". */
  allowedOrigins?: string;
  /**
   * Decrypted secret values keyed by env-ref name. Fixed sidecar variables override
   * this map so secrets cannot shadow process configuration.
   */
  extraEnv?: Record<string, string>;
  /**
   * Packaged contribution roots. Bundle-relative fallbacks resolve outside the
   * application, so packaged children require explicit resource paths.
   */
  pluginsDir?: string;
  builtinSkillsDir?: string;
  expectedApiVersion: string;
  healthIntervalMs?: number;
  healthTimeoutMs?: number;
  lifecycleTimeoutMs?: number;
  handshakeTimeoutMs?: number;
  maxRestarts?: number;
  /**
   * Graceful-stop deadline before group SIGKILL. The default 10s exceeds the
   * stdio MCP close sequence, which may take about 4s.
   */
  stopTimeoutMs?: number;
  fetch?: typeof fetch;
  onFatal?: (err: Error) => void;
  onReady?: (handshake: SidecarHandshake) => void;
  onEndpointChanged?: (baseUrl: string, handshake: SidecarHandshake) => void;
}

export interface Sidecar {
  readonly baseUrl: string;
  readonly handshake: SidecarHandshake;
  suspend(): Promise<boolean>;
  resume(): Promise<boolean>;
  stop(): Promise<void>;
}

function isHandshake(msg: unknown): msg is SidecarHandshake {
  return (
    typeof msg === "object" &&
    msg !== null &&
    (msg as { type?: unknown }).type === "ready" &&
    typeof (msg as { port?: unknown }).port === "number" &&
    typeof (msg as { pid?: unknown }).pid === "number" &&
    typeof (msg as { apiVersion?: unknown }).apiVersion === "string"
  );
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

const isWindows = process.platform === "win32";

export async function fetchWithTimeout(
  doFetch: typeof fetch,
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const ac = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      ac.abort();
      reject(new Error(`request timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    timer.unref?.();
  });
  try {
    return await Promise.race([
      doFetch(url, { ...init, signal: ac.signal }),
      timeout,
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Kill the entire sidecar process tree to avoid orphaning stdio MCP servers.
 * POSIX uses the detached process group; Windows uses `taskkill /T`.
 */
function killTree(child: ChildProcess, signal: NodeJS.Signals): void {
  if (child.pid === undefined) return;
  if (isWindows) {
    try {
      execFileSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
    } catch {
      try {
        child.kill(signal);
      } catch {
        // Process already exited.
      }
    }
    return;
  }
  try {
    process.kill(-child.pid, signal);
  } catch {
    try {
      child.kill(signal);
    } catch {
      // Process already exited.
    }
  }
}

async function spawnOnce(opts: SidecarOptions): Promise<{ child: ChildProcess; handshake: SidecarHandshake }> {
  const handshakeTimeoutMs = opts.handshakeTimeoutMs ?? 30_000;

  // Packaged natives are rebuilt for Electron's ABI; development natives target
  // system Node. Keep each server entry on the matching executable.
  const isBuiltJs = opts.serverModulePath.endsWith(".js");
  const [forkTarget, forkArgs] = isBuiltJs
    ? [opts.serverModulePath, [] as string[]]
    : [opts.tsxCli ?? defaultTsxCli(), [opts.serverModulePath]];

  const execPathOpt = isBuiltJs
    ? {}
    : opts.nodePath
      ? { execPath: opts.nodePath }
      : resolveNodeExecPath();

  const child = fork(forkTarget, forkArgs, {
    ...execPathOpt,
    env: {
      ...process.env,
      // Fixed variables below override decrypted secrets.
      ...(opts.extraEnv ?? {}),
      ELECTRON_RUN_AS_NODE: "1",
      // Packaged paths with spaces can break the entry's import.meta.url guard.
      PIZZA_SERVE: "1",
      // Constrain native resolution to the unpacked, matching-ABI modules.
      ...(opts.nativeModulesPath ? { NODE_PATH: opts.nativeModulesPath } : {}),
      ...(opts.mcpNodePath ? { PIZZA_MCP_NODE_PATH: opts.mcpNodePath } : {}),
      ...(opts.pluginsDir ? { PIZZA_PLUGINS_DIR: opts.pluginsDir } : {}),
      ...(opts.builtinSkillsDir
        ? { PIZZA_BUILTIN_SKILLS_DIR: opts.builtinSkillsDir }
        : {}),
      // The child reaps MCP servers if this supervisor dies without disconnecting.
      PIZZA_SUPERVISOR_PID: String(process.pid),
      PORT: "0",
      PIZZA_HOST: "127.0.0.1",
      PIZZA_API_TOKEN: opts.apiToken ?? "",
      PIZZA_ALLOWED_ORIGINS:
        opts.allowedOrigins ?? "null,http://localhost:5173,http://127.0.0.1:5173",
      PIZZA_DATA_ROOT: opts.dataRoot,
    },
    stdio: ["ignore", "inherit", "inherit", "ipc"],
    // POSIX process groups make MCP grandchildren killable as one tree.
    detached: !isWindows,
  });

  return await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      killTree(child, "SIGKILL");
      reject(new Error(`sidecar handshake timed out after ${handshakeTimeoutMs}ms`));
    }, handshakeTimeoutMs);
    timer.unref?.();

    const onMessage = (msg: unknown): void => {
      if (!isHandshake(msg)) return;
      cleanup();
      if (msg.apiVersion !== opts.expectedApiVersion) {
        killTree(child, "SIGKILL");
        reject(
          new Error(
            `sidecar apiVersion mismatch: expected ${opts.expectedApiVersion}, got ${msg.apiVersion}`,
          ),
        );
        return;
      }
      resolve({ child, handshake: msg });
    };
    const onExit = (code: number | null, signal: NodeJS.Signals | null): void => {
      cleanup();
      reject(new Error(`sidecar exited before handshake (code=${code} signal=${signal})`));
    };
    const onError = (err: Error): void => {
      cleanup();
      reject(new Error(`sidecar failed to fork: ${err.message}`));
    };
    function cleanup(): void {
      clearTimeout(timer);
      child.off("message", onMessage);
      child.off("exit", onExit);
      child.off("error", onError);
    }

    child.on("message", onMessage);
    child.on("exit", onExit);
    child.on("error", onError);
  });
}

/** Start the sidecar with health checks, restart backoff, and graceful shutdown. */
export async function startSidecar(opts: SidecarOptions): Promise<Sidecar> {
  const doFetch = opts.fetch ?? globalThis.fetch;
  const healthIntervalMs = opts.healthIntervalMs ?? 5_000;
  const healthTimeoutMs = opts.healthTimeoutMs ?? 3_000;
  const lifecycleTimeoutMs = opts.lifecycleTimeoutMs ?? 60_000;
  const maxRestarts = opts.maxRestarts ?? 5;
  const stopTimeoutMs = opts.stopTimeoutMs ?? 10_000;

  let child: ChildProcess;
  let handshake: SidecarHandshake;
  let baseUrl: string;
  let stopped = false;
  let healthTimer: NodeJS.Timeout | undefined;
  let consecutiveFailures = 0;
  let restartInFlight: Promise<void> | undefined;

  const boot = await spawnOnce(opts);
  child = boot.child;
  handshake = boot.handshake;
  baseUrl = `http://127.0.0.1:${handshake.port}`;
  opts.onReady?.(handshake);

  async function ping(): Promise<boolean> {
    try {
      const res = await fetchWithTimeout(
        doFetch,
        `${baseUrl}/ping`,
        {},
        healthTimeoutMs,
      );
      if (!res.ok) return false;
      const body = (await res.json()) as { status?: string };
      return body.status === "Healthy" || body.status === "HealthyBusy";
    } catch {
      return false;
    }
  }

  async function postLifecycle(
    event: "suspend" | "resume",
    timeoutMs: number,
  ): Promise<boolean> {
    try {
      const res = await fetchWithTimeout(
        doFetch,
        `${baseUrl}/lifecycle/${event}`,
        {
          method: "POST",
          headers: opts.apiToken
            ? { authorization: `Bearer ${opts.apiToken}` }
            : {},
        },
        timeoutMs,
      );
      return res.ok;
    } catch {
      return false;
    }
  }

  async function stopProcess(target: ChildProcess): Promise<void> {
    if (target.exitCode !== null || target.signalCode !== null) return;
    const exited = once(target, "exit");
    target.kill("SIGTERM");
    const hardKill = setTimeout(() => {
      if (target.exitCode === null && target.signalCode === null) {
        killTree(target, "SIGKILL");
      }
    }, stopTimeoutMs);
    hardKill.unref?.();
    await exited;
    clearTimeout(hardKill);
  }

  async function restartLoop(reason: string): Promise<void> {
    let lastReason = reason;
    while (!stopped) {
      consecutiveFailures += 1;
      if (consecutiveFailures > maxRestarts) {
        const err = new Error(
          `sidecar circuit breaker tripped after ${maxRestarts} restarts (last reason: ${lastReason})`,
        );
        stopped = true;
        opts.onFatal?.(err);
        return;
      }
      const backoff = Math.min(250 * 2 ** (consecutiveFailures - 1), 10_000);
      await sleep(backoff);
      if (stopped) return;

      detach();
      const previousBaseUrl = baseUrl;
      try {
        const replacement = await spawnOnce(opts);
        if (stopped) {
          await stopProcess(replacement.child);
          return;
        }
        child = replacement.child;
        handshake = replacement.handshake;
        baseUrl = `http://127.0.0.1:${handshake.port}`;
        attach();
        opts.onReady?.(handshake);
        if (baseUrl !== previousBaseUrl) {
          opts.onEndpointChanged?.(baseUrl, handshake);
        }
        return;
      } catch (err) {
        lastReason = err instanceof Error ? err.message : String(err);
      }
    }
  }

  function restart(reason: string): Promise<void> {
    if (stopped) return Promise.resolve();
    if (restartInFlight) return restartInFlight;
    const pending = restartLoop(reason).finally(() => {
      if (restartInFlight === pending) restartInFlight = undefined;
    });
    restartInFlight = pending;
    return pending;
  }

  const onExit = (code: number | null, signal: NodeJS.Signals | null): void => {
    if (stopped) return;
    void restart(`child exited (code=${code} signal=${signal})`);
  };
  function attach(): void {
    child.on("exit", onExit);
  }
  function detach(): void {
    child.off("exit", onExit);
  }
  attach();

  // Self-scheduling prevents overlapping health requests.
  const scheduleHealth = (): void => {
    healthTimer = setTimeout(async () => {
      if (stopped) return;
      const healthy = await ping();
      if (stopped) return;
      if (healthy) {
        consecutiveFailures = 0;
      } else {
        if (child.exitCode === null && child.signalCode === null) {
          killTree(child, "SIGKILL");
        } else {
          void restart("health ping failed");
        }
      }
      if (!stopped) scheduleHealth();
    }, healthIntervalMs);
    healthTimer.unref?.();
  };
  scheduleHealth();

  async function stop(): Promise<void> {
    if (!stopped) {
      stopped = true;
      if (healthTimer) clearTimeout(healthTimer);
      detach();
      // Signal only the server first so host.close() can stop MCP children cleanly.
      await stopProcess(child);
    }
    await restartInFlight;
  }

  return {
    get baseUrl() {
      return baseUrl;
    },
    get handshake() {
      return handshake;
    },
    suspend: () => postLifecycle("suspend", healthTimeoutMs),
    resume: async () => {
      const healthy = await ping();
      if (!healthy) {
        if (child.exitCode === null && child.signalCode === null) {
          killTree(child, "SIGKILL");
        }
        return false;
      }
      return postLifecycle("resume", lifecycleTimeoutMs);
    },
    stop,
  };
}
