/** Bundle workspace TypeScript dependencies into the Electron main ESM artifact. */
import { build } from "esbuild";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const shellRoot = path.resolve(__dirname, "..");

await build({
  entryPoints: [path.join(shellRoot, "src", "main.ts")],
  outfile: path.join(shellRoot, "dist", "main.js"),
  bundle: true,
  platform: "node",
  format: "esm",
  // Electron 43 embeds Node 24.
  target: "node24",
  conditions: ["source"],
  // Electron is runtime-provided and native modules cannot be bundled.
  external: ["electron", "better-sqlite3"],
  // Inlined CommonJS dependencies still require a `require` shim in ESM output.
  banner: {
    js: [
      "import { createRequire as __pizzaCreateRequire } from 'node:module';",
      "const require = __pizzaCreateRequire(import.meta.url);",
    ].join("\n"),
  },
  logLevel: "info",
});

console.log("✅ bundled Electron main -> dist/main.js");
