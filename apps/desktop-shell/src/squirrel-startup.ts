/**
 * Squirrel.Windows relaunches the packaged app with a lifecycle flag to manage
 * its own shortcuts, then kills it after ~15s — so this must resolve before any
 * other startup work.
 */
import { spawnSync } from "node:child_process";
import { win32 as windowsPath } from "node:path";

/** Stay well inside Squirrel's grace period before it force-kills the app. */
const SHORTCUT_TIMEOUT_MS = 10_000;

/**
 * Squirrel stamps `com.squirrel.<packageId>.<exe>` onto every shortcut it
 * creates. Windows treats a running process whose model id differs from the
 * launching shortcut's as a separate app, which splits the taskbar button and
 * breaks pinning, so the app must adopt the same id. Derived from the maker's
 * `name` and `executableName` in forge.config.ts — keep the three in step.
 */
export const SQUIRREL_APP_ID = "com.squirrel.pizza_bot_oss.pizza-bot-oss";

export type SquirrelStartup =
  /** Not a Squirrel invocation — start the app normally. */
  | { kind: "run" }
  /** A superseded version being retired: exit without touching shortcuts. */
  | { kind: "quit" }
  | { kind: "shortcut"; exe: string; args: string[] };

/**
 * `--squirrel-firstrun` is deliberately unhandled: it marks the first ordinary
 * launch after install, where the app must start as usual.
 */
export function resolveSquirrelStartup(
  platform: string,
  argv: readonly string[],
  execPath: string,
): SquirrelStartup {
  if (platform !== "win32") return { kind: "run" };

  const flag = argv.slice(1).find((arg) => SQUIRREL_FLAGS.has(arg));
  if (!flag) return { kind: "run" };
  if (flag === "--squirrel-obsolete") return { kind: "quit" };

  // Update.exe sits one level above the versioned app-x.y.z directory.
  const exe = windowsPath.resolve(
    windowsPath.dirname(execPath),
    "..",
    "Update.exe",
  );
  const target = windowsPath.basename(execPath);
  const verb = flag === "--squirrel-uninstall" ? "removeShortcut" : "createShortcut";
  return { kind: "shortcut", exe, args: [`--${verb}=${target}`] };
}

/** True when the caller must exit immediately instead of starting the app. */
export function handleSquirrelStartup(): boolean {
  const startup = resolveSquirrelStartup(process.platform, process.argv, process.execPath);
  if (startup.kind === "run") return false;
  if (startup.kind === "shortcut") {
    // Synchronous: the process exits the moment this returns, and a detached
    // spawn would race Squirrel's kill.
    spawnSync(startup.exe, startup.args, {
      timeout: SHORTCUT_TIMEOUT_MS,
      stdio: "ignore",
      windowsHide: true,
    });
  }
  return true;
}

// An install and an update both need shortcuts repointed at the new version.
const SQUIRREL_FLAGS = new Set([
  "--squirrel-install",
  "--squirrel-updated",
  "--squirrel-uninstall",
  "--squirrel-obsolete",
]);
