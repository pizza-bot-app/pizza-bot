/** Builds the deployable backend artifact under dist/backend. */
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { generateThirdPartyLicenses } from "./third-party-licenses.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outputDir = path.join(repoRoot, "dist", "backend");
const serverDir = path.join(outputDir, "server");
const linuxNativeTargets = [
  "linux-x64",
  "linux-arm64",
  "linuxmusl-x64",
  "linuxmusl-arm64",
];
const hostNativeTarget = `${
  process.platform === "linux" &&
  !process.report.getReport().header.glibcVersionRuntime
    ? "linuxmusl"
    : process.platform
}-${process.arch}`;

rmSync(outputDir, {
  recursive: true,
  force: true,
  maxRetries: 5,
  retryDelay: 100,
});
mkdirSync(outputDir, { recursive: true });

execFileSync(
  process.execPath,
  [
    path.join(repoRoot, "apps", "api-server", "scripts", "bundle.mjs"),
    serverDir,
    ...new Set([...linuxNativeTargets, hostNativeTarget]),
  ],
  { cwd: repoRoot, stdio: "inherit" },
);

cpSync(path.join(repoRoot, "skills"), path.join(outputDir, "skills"), {
  recursive: true,
  dereference: true,
});
execFileSync(
  process.execPath,
  [
    path.join(repoRoot, "apps", "desktop-shell", "scripts", "stage-plugins.mjs"),
    path.join(outputDir, "plugins"),
  ],
  { cwd: repoRoot, stdio: "inherit" },
);
for (const name of ["LICENSE", "NOTICE"]) {
  cpSync(path.join(repoRoot, name), path.join(outputDir, name));
}
generateThirdPartyLicenses(path.join(outputDir, "THIRD_PARTY_LICENSES.txt"), {
  artifact: "backend",
  pluginNodeModulesDirs: [
    path.join(outputDir, "plugins", "node_modules"),
  ],
});

const rootPackage = JSON.parse(
  readFileSync(path.join(repoRoot, "package.json"), "utf8"),
);
writeFileSync(
  path.join(outputDir, "start.mjs"),
  [
    'import { fileURLToPath } from "node:url";',
    "",
    'process.env.PIZZA_BUILTIN_SKILLS_DIR ??= fileURLToPath(new URL("./skills", import.meta.url));',
    'process.env.PIZZA_PLUGINS_DIR ??= fileURLToPath(new URL("./plugins", import.meta.url));',
    'process.env.PIZZA_SERVE = "1";',
    'await import("./server/index.js");',
    "",
  ].join("\n"),
);
writeFileSync(
  path.join(outputDir, "package.json"),
  JSON.stringify(
    {
      name: "pizza-bot-backend",
      version: rootPackage.version,
      private: true,
      type: "module",
      engines: rootPackage.engines,
      scripts: { start: "node start.mjs" },
    },
    null,
    2,
  ) + "\n",
);

console.log(`built backend artifact -> ${outputDir}`);
