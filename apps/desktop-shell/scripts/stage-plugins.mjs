/** Stage shipped plugins with their own node_modules for the packaged app. */
import {
  cpSync,
  existsSync,
  lstatSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  unlinkSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveNpmCli } from "../../../scripts/npm-cli.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const shellRoot = path.resolve(__dirname, "..");
const repoRoot = path.resolve(shellRoot, "..", "..");

const source = path.join(repoRoot, "plugins");
// The basename must stay "plugins": Forge's extraResource copies by basename,
// and the sidecar is pointed at `<resources>/plugins`.
const stagedDir = process.argv[2]
  ? path.resolve(process.cwd(), process.argv[2])
  : path.join(shellRoot, "dist-plugins", "plugins");
if (path.basename(stagedDir) !== "plugins") {
  throw new Error(`the staged plugin directory must be named 'plugins': ${stagedDir}`);
}

const npmCli = resolveNpmCli();

function materializeSymlinks(root) {
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const entryPath = path.join(root, entry.name);
    if (entry.isSymbolicLink()) {
      const target = realpathSync(entryPath);
      const recursive = lstatSync(target).isDirectory();
      unlinkSync(entryPath);
      cpSync(target, entryPath, { recursive, dereference: true });
    } else if (entry.isDirectory()) {
      materializeSymlinks(entryPath);
    }
  }
}

// Windows keeps directory handles open briefly after npm exits, so a plain
// rmSync here throws EPERM on a re-run.
rmSync(stagedDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
cpSync(source, stagedDir, {
  recursive: true,
  dereference: true,
  // A stale tree from an interrupted run must never reach the installer.
  filter: (src) => path.basename(src) !== "node_modules",
});

const staged = readdirSync(stagedDir, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => path.join(stagedDir, entry.name));

const workspaces = [];
let needsInstall = false;
for (const dir of staged) {
  const manifest = path.join(dir, "package.json");
  if (!existsSync(manifest)) continue;
  const pkg = JSON.parse(readFileSync(manifest, "utf8"));
  workspaces.push(path.basename(dir));
  needsInstall ||= Object.keys(pkg.dependencies ?? {}).length > 0;
}

if (needsInstall) {
  const stagingManifest = path.join(stagedDir, "package.json");
  const stagingLock = path.join(stagedDir, "package-lock.json");
  if (!existsSync(stagingManifest) || !existsSync(stagingLock)) {
    throw new Error("plugins/package.json and package-lock.json are required for staging");
  }
  const configuredWorkspaces = JSON.parse(
    readFileSync(stagingManifest, "utf8"),
  ).workspaces;
  if (
    !Array.isArray(configuredWorkspaces) ||
    configuredWorkspaces.slice().sort().join("\n") !==
      workspaces.slice().sort().join("\n")
  ) {
    throw new Error("plugins/package.json workspaces do not match the shipped plugin directories");
  }
  // MCP child processes resolve this shared tree by walking up from each plugin;
  // npm nests incompatible workspace dependency versions where needed.
  console.log(`[stage-plugins] installing dependencies for ${workspaces.length} plugin(s)`);
  // `--ignore-scripts` keeps third-party plugin lifecycle hooks off the
  // packaging host; these bundles are pure JS and need no build step.
  execFileSync(
    process.execPath,
    [
      npmCli,
      "ci",
      "--omit=dev",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
    ],
    { stdio: "inherit", cwd: stagedDir },
  );
  // Packager makes extraResource symlinks absolute, invalidating macOS signatures.
  materializeSymlinks(path.join(stagedDir, "node_modules"));
}

console.log(`staged ${staged.length} plugin(s) -> ${stagedDir}`);
