/** Launches the packaged Playwright MCP server and performs a real navigation. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import path from "node:path";
import { createInterface } from "node:readline";

const artifactRoot = path.resolve(process.argv[2] ?? "dist/backend");
const launcher = path.join(
  artifactRoot,
  "plugins",
  "playwright-mcp",
  "launch.mjs",
);
const pageServer = createServer((_request, response) => {
  response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  response.end("<!doctype html><title>Pizza Bot browser smoke</title><main>Browser ready</main>");
});
await new Promise((resolve, reject) => {
  pageServer.once("error", reject);
  pageServer.listen(0, "127.0.0.1", resolve);
});
const address = pageServer.address();
assert(address && typeof address === "object");

const child = spawn(process.execPath, [launcher], {
  cwd: artifactRoot,
  env: process.env,
  stdio: ["pipe", "pipe", "pipe"],
});
let stderr = "";
child.stderr.setEncoding("utf8").on("data", (chunk) => {
  stderr = (stderr + chunk).slice(-50_000);
});

const pending = new Map();
const lines = createInterface({ input: child.stdout });
lines.on("line", (line) => {
  const message = JSON.parse(line);
  const request = pending.get(message.id);
  if (!request) return;
  pending.delete(message.id);
  clearTimeout(request.timer);
  if (message.error) request.reject(new Error(message.error.message));
  else request.resolve(message.result);
});

let nextId = 1;
const request = (method, params = {}) => {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`${method} timed out\n${stderr}`));
    }, 30_000);
    pending.set(id, { resolve, reject, timer });
    child.stdin.write(
      `${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`,
    );
  });
};

try {
  await request("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "pizza-bot-browser-smoke", version: "1.0.0" },
  });
  child.stdin.write(
    `${JSON.stringify({
      jsonrpc: "2.0",
      method: "notifications/initialized",
      params: {},
    })}\n`,
  );

  const listed = await request("tools/list");
  assert.ok(
    listed.tools.some((tool) => tool.name === "browser_navigate"),
    "browser_navigate tool was not packaged",
  );
  const navigated = await request("tools/call", {
    name: "browser_navigate",
    arguments: { url: `http://127.0.0.1:${address.port}` },
  });
  assert.notEqual(navigated.isError, true, JSON.stringify(navigated));
  assert.match(JSON.stringify(navigated.content), /Pizza Bot browser smoke/);
  await request("tools/call", {
    name: "browser_close",
    arguments: {},
  });
  console.log("packaged Playwright MCP browser smoke passed");
} catch (error) {
  process.stderr.write(stderr);
  throw error;
} finally {
  for (const request of pending.values()) clearTimeout(request.timer);
  const childExited =
    child.exitCode === null
      ? new Promise((resolve) => child.once("exit", resolve))
      : Promise.resolve();
  child.stdin.end();
  if (child.exitCode === null) child.kill("SIGTERM");
  await Promise.all([
    childExited,
    new Promise((resolve, reject) =>
      pageServer.close((error) => (error ? reject(error) : resolve())),
    ),
  ]);
}
