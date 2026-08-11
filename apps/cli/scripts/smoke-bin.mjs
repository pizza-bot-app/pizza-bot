import { spawn } from "node:child_process";
import { access, constants } from "node:fs/promises";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const bin = fileURLToPath(new URL("../dist/index.js", import.meta.url));
const dataRoot = await mkdtemp(path.join(tmpdir(), "pizza-cli-smoke-"));
if (process.platform !== "win32") await access(bin, constants.X_OK);

const command = process.platform === "win32" ? process.execPath : bin;
const args = process.platform === "win32" ? [bin] : [];
const child = spawn(command, args, {
  env: { ...process.env, NO_COLOR: "1", PIZZA_DATA_ROOT: dataRoot },
  stdio: ["pipe", "pipe", "pipe"],
});

let stdout = "";
let stderr = "";
child.stdout.setEncoding("utf8").on("data", (chunk) => {
  stdout += chunk;
});
child.stderr.setEncoding("utf8").on("data", (chunk) => {
  stderr += chunk;
});
child.stdin.end("/exit\n");

const code = await new Promise((resolve, reject) => {
  child.once("error", reject);
  child.once("exit", resolve);
});
await rm(dataRoot, { recursive: true, force: true });

if (code !== 0 || !stdout.includes("Pizza Bot shell") || stderr.length > 0) {
  throw new Error(
    `CLI smoke test failed (exit ${String(code)})\nstdout:\n${stdout}\nstderr:\n${stderr}`,
  );
}
