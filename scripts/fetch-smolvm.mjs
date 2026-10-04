#!/usr/bin/env node
/**
 * Stages the pinned smolvm release for one desktop target in
 * `apps/desktop-shell/dist-smolvm/smolvm`, which Forge ships as `resources/smolvm`.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Git for Windows can put GNU tar ahead of System32's bsdtar on PATH; GNU tar
// cannot read the zip and treats a `C:` path as a remote host.
const TAR =
  process.platform === "win32"
    ? path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe")
    : "tar";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export const SMOLVM_VERSION = "1.22.2";

/** Digests from the release's `checksums.sha256`; smolvm has no Intel macOS build. */
export const SMOLVM_RELEASES = {
  "darwin-arm64": {
    asset: `smolvm-${SMOLVM_VERSION}-darwin-arm64.tar.gz`,
    sha256: "a355139fc8e0d67bdf5d8d915062b98401f4c6a02871cf74306a304fb92183ca",
  },
  "linux-x64": {
    asset: `smolvm-${SMOLVM_VERSION}-linux-x86_64.tar.gz`,
    sha256: "95d626218b88ad42f791c7a46a928591e78cf5a4a4b5777318c77202fb0eb582",
  },
  "linux-arm64": {
    asset: `smolvm-${SMOLVM_VERSION}-linux-arm64.tar.gz`,
    sha256: "74b9a7f2a04c90511a3a644d1dd3e42b92b0beb8143923306438e5986813de61",
  },
  "win32-x64": {
    asset: `smolvm-${SMOLVM_VERSION}-windows-x86_64.zip`,
    sha256: "a91e82347faf4c343f8f7eded2c8f86e621ca5b37214874c47b18be4a1c8d81c",
  },
};

/** Release entries the desktop app never runs: Kubernetes integration and the shell wrapper. */
const PRUNED = ["kubernetes", "containerd-shim-smolvm-v2", "smolvm"];

export const DEFAULT_OUTPUT = path.join(repoRoot, "apps", "desktop-shell", "dist-smolvm", "smolvm");

export function releaseFor(platform, arch) {
  return SMOLVM_RELEASES[`${platform}-${arch}`];
}

function parseArgs(argv) {
  const options = { platform: process.platform, arch: process.arch, output: DEFAULT_OUTPUT };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (flag === "--platform" || flag === "--arch" || flag === "--output") {
      if (!value) throw new Error(`${flag} needs a value`);
      options[flag.slice(2)] = value;
      index += 1;
    } else {
      throw new Error(`unknown argument: ${flag}`);
    }
  }
  return options;
}

export async function fetchSmolvm({ platform, arch, output }) {
  const target = `${platform}-${arch}`;
  const release = releaseFor(platform, arch);
  if (!release) {
    // A stale stage from another target must not ride along in this package.
    fs.rmSync(output, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    console.log(`[smolvm] no ${SMOLVM_VERSION} build for ${target}; shipping without it`);
    return false;
  }
  const marker = path.join(output, ".pizza-smolvm");
  const stamp = `${release.asset}\nrootfs-tarball\n`;
  if (fs.existsSync(marker) && fs.readFileSync(marker, "utf8") === stamp) {
    console.log(`[smolvm] ${release.asset} already staged`);
    return true;
  }

  const url = `https://github.com/smol-machines/smolvm/releases/download/v${SMOLVM_VERSION}/${release.asset}`;
  console.log(`[smolvm] downloading ${url}`);
  const response = await fetch(url);
  if (!response.ok) throw new Error(`download failed: ${response.status} ${url}`);
  const archive = Buffer.from(await response.arrayBuffer());
  const digest = createHash("sha256").update(archive).digest("hex");
  if (digest !== release.sha256) {
    throw new Error(`${release.asset} sha256 ${digest} does not match ${release.sha256}`);
  }

  const work = fs.mkdtempSync(path.join(os.tmpdir(), "pizza-smolvm-"));
  try {
    const archivePath = path.join(work, release.asset);
    fs.writeFileSync(archivePath, archive);
    const unpacked = path.join(work, "unpacked");
    fs.mkdirSync(unpacked);
    // bsdtar, which macOS and Windows ship as `tar`, also reads the Windows zip.
    execFileSync(TAR, ["-xf", archivePath, "-C", unpacked], { stdio: "inherit" });
    const entries = fs.readdirSync(unpacked);
    const staged = path.join(unpacked, entries[0] ?? "");
    if (entries.length !== 1 || !fs.statSync(staged).isDirectory()) {
      throw new Error(`${release.asset} should hold one top-level directory, found: ${entries.join(", ")}`);
    }
    for (const entry of PRUNED) {
      fs.rmSync(path.join(staged, entry), { recursive: true, force: true });
    }
    // The rootfs holds symlinks to guest-only paths, which Forge's resource copy
    // follows and fails on. smolvm unpacks a tarball beside its binary into the
    // user cache instead, as the Windows release already ships it.
    const rootfs = path.join(staged, "agent-rootfs");
    if (fs.existsSync(rootfs)) {
      execFileSync(TAR, ["-czf", path.join(staged, "agent-rootfs.tar.gz"), "-C", rootfs, "."], {
        stdio: "inherit",
      });
      fs.rmSync(rootfs, { recursive: true, force: true });
    }
    fs.writeFileSync(path.join(staged, ".pizza-smolvm"), stamp);
    fs.rmSync(output, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    fs.mkdirSync(path.dirname(output), { recursive: true });
    fs.cpSync(staged, output, { recursive: true, verbatimSymlinks: true });
  } finally {
    fs.rmSync(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
  console.log(`[smolvm] staged ${release.asset} in ${output}`);
  return true;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await fetchSmolvm(parseArgs(process.argv.slice(2)));
}
