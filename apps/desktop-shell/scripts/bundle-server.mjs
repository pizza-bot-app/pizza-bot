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

/**
 * The sidecar runs on the machine the app is installed on, so it needs only its
 * own target. Naming it matters beyond size: rpmbuild strips every binary it
 * packages, and `strip` exits non-zero on a foreign architecture, which fails the
 * whole build. Linux gets both libc variants — same architecture, so they strip
 * fine, and better-sqlite3 chooses between them at runtime.
 */
function nativeTargetsFor(platform, arch) {
  return platform === "linux"
    ? [`linux-${arch}`, `linuxmusl-${arch}`]
    : [`${platform}-${arch}`];
}

const [platform = process.platform, arch = process.arch] = process.argv.slice(2);

execFileSync(
  process.execPath,
  [
    bundleScript,
    path.join(shellRoot, "dist-server"),
    ...nativeTargetsFor(platform, arch),
  ],
  { cwd: repoRoot, stdio: "inherit" },
);
