/** Exercises the packaged backend through its authenticated HTTP/SSE boundary. */
import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sourceDir = path.join(repoRoot, "dist", "backend");
if (!existsSync(path.join(sourceDir, "start.mjs"))) {
  throw new Error("missing dist/backend/start.mjs; run npm run backend:bundle first");
}

const smokeRoot = mkdtempSync(path.join(tmpdir(), "pizza-bot-backend-smoke-"));
const backendDir = path.join(smokeRoot, "backend");
const dataRoot = path.join(smokeRoot, "data");
cpSync(sourceDir, backendDir, { recursive: true, dereference: true });

const entry = path.join(backendDir, "start.mjs");
const token = "pizza-bot-backend-smoke-token-0000000000000000";
const origin = "null";
const cleanEnv = Object.fromEntries(
  Object.entries(process.env).filter(([name]) => !name.startsWith("PIZZA_")),
);
const child = fork(entry, [], {
  cwd: backendDir,
  env: {
    ...cleanEnv,
    OLLAMA_HOST: "http://127.0.0.1:1",
    PIZZA_ALLOWED_ORIGINS: origin,
    PIZZA_API_TOKEN: token,
    PIZZA_DATA_ROOT: dataRoot,
    PIZZA_HOST: "127.0.0.1",
    PIZZA_MODEL: "ollama:smoke",
    PORT: "0",
  },
  stdio: ["ignore", "pipe", "pipe", "ipc"],
});

let serverOutput = "";
for (const output of [child.stdout, child.stderr]) {
  output?.on("data", (chunk) => {
    serverOutput = (serverOutput + chunk.toString()).slice(-100_000);
  });
}

let streamAbort;
let streamReader;

try {
  const port = await waitForReady(child);
  const baseUrl = `http://127.0.0.1:${port}`;
  const authHeaders = {
    authorization: `Bearer ${token}`,
    origin,
  };

  const unauthenticated = await fetch(`${baseUrl}/`, {
    headers: { origin },
  });
  assert.equal(unauthenticated.status, 401, "root endpoint must require bearer auth");

  const badOrigin = await fetch(`${baseUrl}/`, {
    headers: {
      authorization: `Bearer ${token}`,
      origin: "https://not-allowed.example",
    },
  });
  assert.equal(badOrigin.status, 403, "unlisted origins must be rejected");

  const preflight = await fetch(`${baseUrl}/`, {
    method: "OPTIONS",
    headers: {
      origin,
      "access-control-request-headers": "authorization,content-type",
      "access-control-request-method": "POST",
    },
  });
  assert.equal(preflight.status, 204, "CORS preflight must succeed");
  assert.equal(preflight.headers.get("access-control-allow-origin"), origin);

  const handshake = await fetch(`${baseUrl}/`, { headers: authHeaders });
  assert.equal(handshake.status, 200);
  assert.deepEqual(
    await handshake.json(),
    { service: "pizza-bot", protocolVersion: 1, apiVersion: "1" },
    "root endpoint must advertise the expected protocol",
  );

  await waitForHealthy(baseUrl, origin);

  const shippedSkill = await fetch(`${baseUrl}/skills/browser-automation`, {
    headers: authHeaders,
  });
  assert.equal(shippedSkill.status, 200);
  const shippedSkillBody = await shippedSkill.json();
  assert.deepEqual(
    {
      source: shippedSkillBody.source,
      pluginName: shippedSkillBody.pluginName,
    },
    { source: "plugin", pluginName: "playwright-mcp" },
  );

  const plugins = await fetch(`${baseUrl}/plugins`, { headers: authHeaders });
  assert.equal(plugins.status, 200);
  assert.deepEqual(
    (await plugins.json()).plugins.map((plugin) => plugin.name).sort(),
    ["playwright-mcp"],
  );

  const mcpServers = await waitForMcpLoaded(baseUrl, authHeaders);
  assert.deepEqual(
    mcpServers
      .filter((server) => server.name === "playwright")
      .map((server) => ({ name: server.name, status: server.status }))
      .sort((a, b) => a.name.localeCompare(b.name)),
    [{ name: "playwright", status: "loaded" }],
  );

  streamAbort = new AbortController();
  const stream = await fetch(`${baseUrl}/threads/events`, {
    headers: authHeaders,
    signal: streamAbort.signal,
  });
  assert.equal(stream.status, 200);
  assert.match(stream.headers.get("content-type") ?? "", /^text\/event-stream\b/);
  assert.equal(stream.headers.get("x-accel-buffering"), "no");
  assert.ok(stream.body, "thread event response must have a body");
  streamReader = createSseReader(stream.body);
  assert.equal((await streamReader.next()).event, "ready");

  const threadId = `smoke-${Date.now()}`;
  const created = await fetch(`${baseUrl}/threads`, {
    method: "POST",
    headers: { ...authHeaders, "content-type": "application/json" },
    body: JSON.stringify({ thread_id: threadId }),
  });
  assert.equal(created.status, 200);
  assert.equal((await created.json()).thread_id, threadId);

  const started = await fetch(`${baseUrl}/threads/${threadId}/commands`, {
    method: "POST",
    headers: { ...authHeaders, "content-type": "application/json" },
    body: JSON.stringify({
      id: 1,
      method: "run.start",
      params: {
        input: {
          messages: [
            { id: "smoke-message", role: "user", content: "backend smoke test" },
          ],
        },
      },
    }),
  });
  assert.equal(started.status, 200);
  const startedBody = await started.json();
  assert.equal(startedBody.type, "success");
  assert.equal((await streamReader.next()).event, "changed");

  const cancelled = await fetch(
    `${baseUrl}/threads/${threadId}/runs/${startedBody.result.run_id}/cancel`,
    {
      method: "POST",
      headers: authHeaders,
    },
  );
  assert.equal(cancelled.status, 200);

  console.log(`remote backend smoke passed (${baseUrl})`);
} catch (error) {
  process.stderr.write(serverOutput);
  throw error;
} finally {
  streamAbort?.abort();
  await streamReader?.cancel();
  await stopChild(child);
  rmSync(smokeRoot, {
    recursive: true,
    force: true,
    maxRetries: 5,
    retryDelay: 100,
  });
}

function waitForReady(server) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("backend readiness handshake timed out"));
    }, 30_000);
    timer.unref?.();

    const onMessage = (message) => {
      if (
        message == null ||
        typeof message !== "object" ||
        message.type !== "ready" ||
        !Number.isInteger(message.port)
      ) {
        return;
      }
      cleanup();
      resolve(message.port);
    };
    const onExit = (code, signal) => {
      cleanup();
      reject(
        new Error(
          `backend exited before readiness (code=${String(code)}, signal=${String(signal)})`,
        ),
      );
    };
    const onError = (error) => {
      cleanup();
      reject(error);
    };
    const cleanup = () => {
      clearTimeout(timer);
      server.off("message", onMessage);
      server.off("exit", onExit);
      server.off("error", onError);
    };

    server.on("message", onMessage);
    server.once("exit", onExit);
    server.once("error", onError);
  });
}

async function waitForHealthy(baseUrl, origin) {
  const deadline = Date.now() + 30_000;
  let lastStatus = "not reachable";
  while (Date.now() < deadline) {
    const response = await fetch(`${baseUrl}/ping`, { headers: { origin } });
    const body = await response.json();
    lastStatus = `${response.status} ${JSON.stringify(body)}`;
    if (response.ok && body.status === "Healthy") return;
    if (body.status === "Unhealthy") break;
    await delay(100);
  }
  throw new Error(`backend did not become healthy: ${lastStatus}`);
}

async function waitForMcpLoaded(baseUrl, headers) {
  const deadline = Date.now() + 15_000;
  let servers = [];
  while (Date.now() < deadline) {
    const response = await fetch(`${baseUrl}/status`, { headers });
    assert.equal(response.status, 200);
    servers = (await response.json()).mcp.servers;
    const shipped = servers.filter((server) => server.name === "playwright");
    if (shipped.length === 1 && shipped[0].status === "loaded") {
      return servers;
    }
    await delay(100);
  }
  throw new Error(`packaged MCP servers did not load: ${JSON.stringify(servers)}`);
}

function createSseReader(body) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  return {
    async next() {
      const deadline = Date.now() + 15_000;
      for (;;) {
        const boundary = buffer.match(/\r?\n\r?\n/);
        if (boundary?.index !== undefined) {
          const block = buffer.slice(0, boundary.index);
          buffer = buffer.slice(boundary.index + boundary[0].length);
          const event = parseSseBlock(block);
          if (event) return event;
          continue;
        }

        const remaining = deadline - Date.now();
        if (remaining <= 0) throw new Error("timed out waiting for SSE event");
        const result = await withTimeout(
          reader.read(),
          remaining,
          "timed out waiting for SSE event",
        );
        if (result.done) throw new Error("SSE stream ended before the expected event");
        buffer += decoder.decode(result.value, { stream: true });
      }
    },
    cancel: () => reader.cancel().catch(() => {}),
  };
}

function parseSseBlock(block) {
  let event = "message";
  const data = [];
  for (const line of block.split(/\r?\n/)) {
    if (line.startsWith("event:")) event = line.slice("event:".length).trimStart();
    if (line.startsWith("data:")) data.push(line.slice("data:".length).trimStart());
  }
  return data.length > 0 ? { event, data: data.join("\n") } : undefined;
}

function withTimeout(promise, timeoutMs, message) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), timeoutMs);
    timer.unref?.();
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function stopChild(server) {
  if (server.exitCode !== null || server.signalCode !== null) return;
  const exited = new Promise((resolve) => server.once("exit", resolve));
  server.kill("SIGTERM");
  const stopped = await Promise.race([exited.then(() => true), delay(10_000).then(() => false)]);
  if (!stopped) {
    server.kill("SIGKILL");
    await exited;
  }
}
