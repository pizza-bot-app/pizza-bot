/** Build the packaged API sidecar through the shared standalone bundler. */
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const shellRoot = path.resolve(__dirname, "..");
const repoRoot = path.resolve(shellRoot, "..", "..");
const bundleScript = path.join(
  repoRoot,
  "apps",
  "api-server",
  "scripts",
  "bundle.mjs",
);

execFileSync(
  process.execPath,
  [bundleScript, path.join(shellRoot, "dist-server")],
  { cwd: repoRoot, stdio: "inherit" },
);
