/**
 * Recovers the user's shell PATH for a GUI launch. macOS starts Dock/Finder apps
 * with launchd's bare PATH, so bare stdio MCP commands would otherwise ENOENT.
 */
import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { delimiter } from "node:path";

const MARKER = "__PIZZA_LOGIN_SHELL_PATH__";

export interface LoginShellPathOptions {
  platform?: NodeJS.Platform;
  shell?: string;
  timeoutMs?: number;
  spawnShell?: typeof spawn;
}

export type LoginShellPathFailure = "unsupported_platform" | "timeout" | "spawn_error" | "no_markers";

export type LoginShellPathResult =
  | { path: string; elapsedMs: number }
  | { reason: LoginShellPathFailure; elapsedMs: number };

/** Reads the PATH an interactive login shell exports; never rejects. */
export function readLoginShellPath(opts: LoginShellPathOptions = {}): Promise<LoginShellPathResult> {
  // Windows GUI apps already receive the user's full PATH.
  if ((opts.platform ?? process.platform) === "win32") {
    return Promise.resolve({ reason: "unsupported_platform", elapsedMs: 0 });
  }
  const shell = opts.shell ?? process.env.SHELL ?? "/bin/zsh";
  const timeoutMs = opts.timeoutMs ?? 10_000;
  const spawnShell = opts.spawnShell ?? spawn;
  const started = Date.now();

  return new Promise((resolve) => {
    let settled = false;
    let stdout = "";
    const finish = (outcome: { path: string } | { reason: LoginShellPathFailure }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.stdout?.destroy();
      child.unref();
      resolve({ ...outcome, elapsedMs: Date.now() - started });
    };
    // `-i` too: many users extend PATH in .zshrc/.bashrc, which login-only skips.
    // `command` bypasses rc-defined aliases and functions; markers fence off banners.
    const child = spawnShell(
      shell,
      [
        "-i",
        "-l",
        "-c",
        `command printf '%s\\n' ${MARKER}; command printenv PATH; command printf '%s\\n' ${MARKER}`,
      ],
      {
        // Version managers resolve global tools relative to the working directory.
        cwd: homedir(),
        stdio: ["ignore", "pipe", "ignore"],
        // Own session, no controlling terminal: an interactive shell launched from a
        // terminal would otherwise seize that terminal's job control.
        detached: true,
      },
    );
    // Interactive shells ignore SIGTERM; a hung rc file needs SIGKILL.
    const timer = setTimeout(() => {
      killGroup(child.pid);
      finish({ reason: "timeout" });
    }, timeoutMs);
    child.stdout?.setEncoding("utf8");
    // Resolve on the closing marker, not on exit: a job an rc file backgrounds
    // inherits stdout and holds the pipe open long after the shell is done.
    child.stdout?.on("data", (chunk: string) => {
      stdout += chunk;
      const path = parseMarkedPath(stdout);
      if (path !== undefined) finish({ path });
    });
    child.on("error", () => finish({ reason: "spawn_error" }));
    child.on("close", () => {
      const path = parseMarkedPath(stdout);
      finish(path === undefined ? { reason: "no_markers" } : { path });
    });
  });
}

function killGroup(pid: number | undefined): void {
  if (pid === undefined) return;
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    // Already gone.
  }
}

export function parseMarkedPath(stdout: string): string | undefined {
  const parts = stdout.split(MARKER);
  if (parts.length < 3) return undefined;
  const value = parts[1]!.trim();
  return value.length > 0 ? value : undefined;
}

/** Shell entries first (they reflect the user's intent), then any current-only entries. */
export function mergePath(shellPath: string, current: string | undefined): string {
  const seen = new Set<string>();
  const merged: string[] = [];
  for (const entry of [...shellPath.split(delimiter), ...(current ?? "").split(delimiter)]) {
    if (entry.length === 0 || seen.has(entry)) continue;
    seen.add(entry);
    merged.push(entry);
  }
  return merged.join(delimiter);
}
