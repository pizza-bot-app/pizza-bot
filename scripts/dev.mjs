// Dev launcher: Vite web + the Electron shell on a non-default port so a dev
// build runs beside another instance. The shell forks its own api-server (the
// packaged app's path), so `npm run dev` exercises the production boot path.
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { resolveNpmCli } from "./npm-cli.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// Spawn JS entrypoints with this Node rather than the `npx`/`npm` shims — see
// scripts/npm-cli.mjs for why the shims can't be spawned directly.
const viteBin = path.join(
  path.dirname(createRequire(path.join(root, "apps/web/package.json")).resolve("vite/package.json")),
  "bin",
  "vite.js",
);

// Offset from the 5173 default so this coexists with another instance. The
// sidecar's API port stays OS-assigned (as in production), so it never clashes.
const WEB_PORT = Number(process.env.PIZZA_WEB_PORT ?? 5273);
const webUrl = `http://localhost:${WEB_PORT}`;

console.log(`[dev] web (Vite)     → ${webUrl}`);
console.log(`[dev] desktop shell  → loads ${webUrl}, forks its own api-server`);

const children = [];
let shuttingDown = false;

function launch(name, command, args, cwd, extraEnv) {
  const child = spawn(command, args, {
    cwd,
    stdio: "inherit",
    env: { ...process.env, ...extraEnv },
  });
  child.on("exit", (code, signal) => {
    if (shuttingDown) return;
    // One process dying takes the group down — a half-up dev env is a trap.
    console.error(`[dev] ${name} exited (code=${code} signal=${signal}); stopping the rest`);
    shutdown(code ?? 1);
  });
  children.push(child);
  return child;
}

function shutdown(exitCode) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const child of children) child.kill("SIGTERM");
  const timer = setTimeout(() => {
    for (const child of children) child.kill("SIGKILL");
    process.exit(exitCode);
  }, 5_000);
  timer.unref();
  Promise.all(
    children.map((c) => (c.exitCode === null ? new Promise((r) => c.once("exit", r)) : Promise.resolve())),
  ).then(() => process.exit(exitCode));
}

process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));

launch(
  "web",
  process.execPath,
  [viteBin, "--port", String(WEB_PORT), "--strictPort"],
  path.join(root, "apps/web"),
);
launch("desktop", process.execPath, [resolveNpmCli(), "run", "dev", "-w", "@pizza-bot/desktop-shell"], root, {
  // The shell loads the UI from this Vite origin and allowlists it for CORS.
  PIZZA_WEB_URL: webUrl,
});
