/** Builds a standalone API bundle and co-locates its runtime dependencies. */
import { build } from "esbuild";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const apiRoot = path.resolve(scriptDir, "..");
const repoRoot = path.resolve(apiRoot, "..", "..");
const outputArg = process.argv[2];

if (!outputArg) {
  throw new Error(
    "usage: node apps/api-server/scripts/bundle.mjs <output-directory> [native-target ...]",
  );
}

const outputDir = path.resolve(process.cwd(), outputArg);
const entry = path.join(apiRoot, "src", "index.ts");
const requestedNativeTargets = [...new Set(process.argv.slice(3))];

rmSync(outputDir, {
  recursive: true,
  force: true,
  maxRetries: 5,
  retryDelay: 100,
});
mkdirSync(outputDir, { recursive: true });

await build({
  entryPoints: [entry],
  outfile: path.join(outputDir, "index.js"),
  bundle: true,
  platform: "node",
  format: "esm",
  // Electron 43's sidecar shares this bundle and embeds Node 24.
  target: "node24",
  conditions: ["source"],
  // Native modules must remain external so Node can load the target-platform binary.
  external: ["better-sqlite3"],
  banner: {
    js: [
      "import { createRequire as __pizzaCreateRequire } from 'node:module';",
      "const require = __pizzaCreateRequire(import.meta.url);",
    ].join("\n"),
  },
  logLevel: "info",
});

let quickJsEntry;
try {
  quickJsEntry = require.resolve("@langchain/quickjs");
} catch (error) {
  if (error?.code !== "MODULE_NOT_FOUND") throw error;
}
if (quickJsEntry) {
  const quickJsRequire = createRequire(quickJsEntry);
  const wasmSource = quickJsRequire.resolve(
    "@jitl/quickjs-ng-wasmfile-release-asyncify/wasm",
  );
  cpSync(wasmSource, path.join(outputDir, "emscripten-module.wasm"));
}

const nativePackage = "better-sqlite3";
const nativeSource = path.join(repoRoot, "node_modules", nativePackage);
if (!existsSync(nativeSource)) {
  throw new Error(`missing ${nativePackage}; run npm install before bundling`);
}
const nativeManifest = JSON.parse(
  readFileSync(path.join(nativeSource, "package.json"), "utf8"),
);
if (typeof nativeManifest.version !== "string") {
  throw new Error(`${nativePackage} package has no version`);
}

const nativeTarget = path.join(outputDir, "node_modules", nativePackage);
mkdirSync(nativeTarget, { recursive: true });
for (const entry of ["LICENSE", "lib", "package.json"]) {
  cpSync(path.join(nativeSource, entry), path.join(nativeTarget, entry), {
    recursive: true,
    dereference: true,
  });
}

const prebuildSource = path.join(nativeSource, "prebuilds");
const availablePrebuilds = readdirSync(prebuildSource)
  .filter((name) => name.endsWith(".node"))
  .sort();
const selectedPrebuilds =
  requestedNativeTargets.length === 0
    ? availablePrebuilds
    : requestedNativeTargets.map((target) => `${target}.node`);
const missingPrebuilds = selectedPrebuilds.filter(
  (name) => !availablePrebuilds.includes(name),
);
if (missingPrebuilds.length > 0) {
  throw new Error(
    `missing ${nativePackage} prebuild(s): ${missingPrebuilds.join(", ")}`,
  );
}
const prebuildTarget = path.join(nativeTarget, "prebuilds");
mkdirSync(prebuildTarget, { recursive: true });
for (const name of selectedPrebuilds) {
  cpSync(path.join(prebuildSource, name), path.join(prebuildTarget, name));
}

const apiPackage = JSON.parse(
  readFileSync(path.join(apiRoot, "package.json"), "utf8"),
);
writeFileSync(
  path.join(outputDir, "package.json"),
  JSON.stringify(
    {
      name: "pizza-server-bundle",
      version: apiPackage.version,
      private: true,
      type: "module",
      dependencies: { [nativePackage]: nativeManifest.version },
    },
    null,
    2,
  ) + "\n",
);

console.log(`bundled api-server -> ${outputDir}`);
