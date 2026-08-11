/**
 * Locates npm's cli.js so build scripts can spawn npm as `node <cli.js>` with no
 * shell. On Windows `npm` is a `.cmd` shim, and spawning it needs `shell: true`
 * (a bare name is ENOENT; the `.cmd` path shell-less is EINVAL since Node's
 * CVE-2024-27980 fix) — but each such call nests another cmd.exe, and a deep
 * chain intermittently dies with STATUS_DLL_INIT_FAILED (0xC0000142) partway
 * through a packaging run.
 */
import fs from "node:fs";
import path from "node:path";

export function resolveNpmCli() {
  const nodeDir = path.dirname(process.execPath);
  const candidates = [
    // Set when the caller was itself started by an npm lifecycle script.
    process.env.npm_execpath,
    // Windows / unprefixed installs keep npm beside the node binary.
    path.join(nodeDir, "node_modules", "npm", "bin", "npm-cli.js"),
    // POSIX prefixed installs (including Homebrew) put it under ../lib.
    path.join(nodeDir, "..", "lib", "node_modules", "npm", "bin", "npm-cli.js"),
  ];
  for (const candidate of candidates) {
    if (candidate?.endsWith(".js") && fs.existsSync(candidate)) return candidate;
  }
  throw new Error("could not locate npm's cli.js next to " + process.execPath);
}
