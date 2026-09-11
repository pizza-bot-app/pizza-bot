import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { build } from "esbuild";
import {
  fetchWithTimeout,
  startSidecar,
  type HealthProbeReport,
  type Sidecar,
} from "./sidecar.js";

const shellRoot = path.resolve(__dirname, "..");
const distServer = path.join(shellRoot, "dist-server");
const hadDistServer = existsSync(distServer);
const tempRoots: string[] = [];

function tempRoot(prefix: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  tempRoots.push(dir);
  return dir;
}

// Windows holds directory handles for seconds after a sidecar exits — longest
// for the SIGKILLed child, which never closes its SQLite handle. Even a retried
// rmSync can outlast its window under full-suite load, and a leftover temp dir
// that the OS reclaims anyway must not fail the run.
const removeDir = (dir: string) => {
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
  } catch (error) {
    console.warn(`[sidecar.test] could not remove ${dir}:`, error);
  }
};

afterAll(() => {
  for (const dir of tempRoots) removeDir(dir);
  if (!hadDistServer) removeDir(distServer);
});

const require = createRequire(import.meta.url);

function serverEntry(): string {
  const pkgJson = require.resolve("@pizza-bot/api-server/package.json");
  return path.join(path.dirname(pkgJson), "src", "index.ts");
}

function emptyContributionDirs(dataRoot: string): {
  pluginsDir: string;
  builtinSkillsDir: string;
} {
  const pluginsDir = path.join(dataRoot, "test-plugins");
  const builtinSkillsDir = path.join(dataRoot, "test-builtin-skills");
  for (const dir of [pluginsDir, builtinSkillsDir]) mkdirSync(dir);
  return { pluginsDir, builtinSkillsDir };
}

let sidecar: Sidecar | undefined;

afterEach(async () => {
  await sidecar?.stop();
  sidecar = undefined;
}, 15_000);

describe("startSidecar (real api-server)", () => {
  it("handshakes on a bound port, is Healthy, and stops cleanly", async () => {
    const dataRoot = tempRoot("electron-shell-verify-");
    const { pluginsDir, builtinSkillsDir } = emptyContributionDirs(dataRoot);

    sidecar = await startSidecar({
      serverModulePath: serverEntry(),
      dataRoot,
      apiToken: "sidecar-secret",
      pluginsDir,
      builtinSkillsDir,
      expectedApiVersion: "1",
      handshakeTimeoutMs: 60_000,
      healthIntervalMs: 60_000,
    });

    expect(sidecar.handshake.type).toBe("ready");
    expect(sidecar.handshake.apiVersion).toBe("1");
    expect(sidecar.handshake.port).toBeGreaterThan(0);
    expect(sidecar.handshake.pid).toBeGreaterThan(0);
    expect(sidecar.baseUrl).toBe(`http://127.0.0.1:${sidecar.handshake.port}`);

    const res = await fetch(`${sidecar.baseUrl}/ping`);
    expect(res.status).toBe(200);
    expect(["Healthy", "HealthyBusy"]).toContain((await res.json() as { status: string }).status);
    expect((await fetch(`${sidecar.baseUrl}/`)).status).toBe(401);
    expect(
      (
        await fetch(`${sidecar.baseUrl}/`, {
          headers: { authorization: "Bearer sidecar-secret" },
        })
      ).status,
    ).toBe(200);
    const originalEndpoint = sidecar.baseUrl;
    const originalPid = sidecar.handshake.pid;
    await sidecar.updateSecrets({
      PIZZA_SECRET_TEST_APIKEY: "updated-without-restart",
    });
    const authHeaders = {
      authorization: "Bearer sidecar-secret",
      "content-type": "application/json",
    };
    const providerSave = await fetch(`${sidecar.baseUrl}/providers/openai`, {
      method: "PUT",
      headers: authHeaders,
      body: JSON.stringify({
        method: "api-key",
        values: { apiKey: "${PIZZA_SECRET_TEST_APIKEY}" },
      }),
    });
    expect(providerSave.status).toBe(200);
    const preferenceSave = await fetch(
      `${sidecar.baseUrl}/providers/openai/models`,
      {
        method: "PUT",
        headers: authHeaders,
        body: JSON.stringify({ mode: "all", selected: [] }),
      },
    );
    expect(preferenceSave.status).toBe(200);
    expect(sidecar.baseUrl).toBe(originalEndpoint);
    expect(sidecar.handshake.pid).toBe(originalPid);
    await expect(sidecar.suspend()).resolves.toBe(true);
    await expect(sidecar.resume()).resolves.toBe(true);

    const deadPort = sidecar.handshake.port;
    await sidecar.stop();
    sidecar = undefined;

    await new Promise((r) => setTimeout(r, 250));
    await expect(fetch(`http://127.0.0.1:${deadPort}/ping`)).rejects.toThrow();
  }, 90_000);

  it("builds and forks the packaged server bundle with its runtime dependencies", async () => {
    execFileSync(process.execPath, [path.join(shellRoot, "scripts", "bundle-server.mjs")], {
      cwd: shellRoot,
      env: process.env,
      stdio: "pipe",
    });

    const bundle = path.join(distServer, "index.js");
    const wasm = path.join(distServer, "emscripten-module.wasm");
    expect(existsSync(bundle)).toBe(true);
    expect(existsSync(wasm)).toBe(true);

    const evalProbe = path.join(distServer, "eval-probe.js");
    await build({
      stdin: {
        contents: `
          import { ReplSession } from "@langchain/quickjs";

          const session = new ReplSession("packaged-eval-probe", {
            captureConsole: false,
          });
          try {
            const result = await session.eval("6 * 7", 5_000);
            if (!result.ok) throw new Error(JSON.stringify(result.error));
            process.stdout.write(JSON.stringify(result.value));
          } finally {
            session.dispose();
          }
        `,
        resolveDir: shellRoot,
        sourcefile: "eval-probe.ts",
      },
      outfile: evalProbe,
      bundle: true,
      platform: "node",
      format: "esm",
      target: "node24",
      banner: {
        js: [
          "import { createRequire as __pizzaCreateRequire } from 'node:module';",
          "const require = __pizzaCreateRequire(import.meta.url);",
        ].join("\n"),
      },
      logLevel: "silent",
    });
    try {
      expect(
        execFileSync(process.execPath, [evalProbe], {
          cwd: distServer,
          encoding: "utf8",
        }),
      ).toBe("42");
    } finally {
      rmSync(evalProbe, { force: true });
    }

    const bundledNativePackage = JSON.parse(
      readFileSync(
        path.join(distServer, "node_modules", "better-sqlite3", "package.json"),
        "utf8",
      ),
    );
    expect(
      JSON.parse(readFileSync(path.join(distServer, "package.json"), "utf8")),
    ).toMatchObject({
      type: "module",
      dependencies: { "better-sqlite3": bundledNativePackage.version },
    });
    expect(
      existsSync(path.join(distServer, "node_modules", "better-sqlite3", "deps")),
    ).toBe(false);

    const bundledRequire = createRequire(path.join(distServer, "package.json"));
    expect(bundledRequire.resolve("better-sqlite3/package.json")).toBe(
      path.join(distServer, "node_modules", "better-sqlite3", "package.json"),
    );
    expect(typeof bundledRequire("better-sqlite3")).toBe("function");

    const dataRoot = tempRoot("electron-shell-bundle-");
    const { pluginsDir, builtinSkillsDir } = emptyContributionDirs(dataRoot);
    sidecar = await startSidecar({
      serverModulePath: bundle,
      dataRoot,
      nativeModulesPath: path.join(distServer, "node_modules"),
      pluginsDir,
      builtinSkillsDir,
      expectedApiVersion: "1",
      handshakeTimeoutMs: 60_000,
      healthIntervalMs: 60_000,
    });
    expect(sidecar.handshake.type).toBe("ready");
    expect(sidecar.handshake.port).toBeGreaterThan(0);
    const res = await fetch(`${sidecar.baseUrl}/ping`);
    expect(["Healthy", "HealthyBusy"]).toContain((await res.json() as { status: string }).status);
    await sidecar.stop();
    sidecar = undefined;
  }, 90_000);

  it("keeps a child whose probes never answer during the startup grace window", async () => {
    const dataRoot = tempRoot("electron-shell-grace-");
    const { pluginsDir, builtinSkillsDir } = emptyContributionDirs(dataRoot);
    const reports: HealthProbeReport[] = [];
    sidecar = await startSidecar({
      serverModulePath: serverEntry(),
      dataRoot,
      pluginsDir,
      builtinSkillsDir,
      expectedApiVersion: "1",
      handshakeTimeoutMs: 60_000,
      healthIntervalMs: 50,
      healthTimeoutMs: 50,
      healthPolicy: { failureThreshold: 1, startupGraceMs: 30_000 },
      // A stalled event loop is indistinguishable from this: the probe is sent
      // and never answered.
      fetch: (() => new Promise<Response>(() => {})) as typeof fetch,
      onHealthProbeFailed: (report) => reports.push(report),
    });
    const originalPid = sidecar.handshake.pid;
    const originalEndpoint = sidecar.baseUrl;

    await new Promise((r) => setTimeout(r, 1_500));

    expect(reports.length).toBeGreaterThan(2);
    expect(reports.every((r) => r.outcome === "unreachable" && !r.killing)).toBe(true);
    expect(sidecar.handshake.pid).toBe(originalPid);
    expect(sidecar.baseUrl).toBe(originalEndpoint);
    // The real server is untouched and still serving on the original port.
    expect((await fetch(`${originalEndpoint}/ping`)).status).toBe(200);
  }, 90_000);

  it("trips the breaker instead of restarting forever past the grace window", async () => {
    const dataRoot = tempRoot("electron-shell-breaker-");
    const { pluginsDir, builtinSkillsDir } = emptyContributionDirs(dataRoot);
    let resolveFatal!: (err: Error) => void;
    const fatal = new Promise<Error>((resolve) => {
      resolveFatal = resolve;
    });
    sidecar = await startSidecar({
      serverModulePath: serverEntry(),
      dataRoot,
      pluginsDir,
      builtinSkillsDir,
      expectedApiVersion: "1",
      handshakeTimeoutMs: 60_000,
      healthIntervalMs: 50,
      healthTimeoutMs: 50,
      healthPolicy: { failureThreshold: 1, startupGraceMs: 0 },
      maxRestarts: 0,
      fetch: (() => new Promise<Response>(() => {})) as typeof fetch,
      onFatal: (err) => resolveFatal(err),
    });

    const err = await Promise.race([
      fatal,
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("breaker never tripped")), 30_000),
      ),
    ]);
    expect(err.message).toContain("circuit breaker tripped");
  }, 90_000);

  it("reports a changed endpoint after recovering a crashed child", async () => {
    const dataRoot = tempRoot("electron-shell-restart-");
    const { pluginsDir, builtinSkillsDir } = emptyContributionDirs(dataRoot);
    let resolveEndpoint!: (value: string) => void;
    const endpointChanged = new Promise<string>((resolve) => {
      resolveEndpoint = resolve;
    });
    sidecar = await startSidecar({
      serverModulePath: serverEntry(),
      dataRoot,
      apiToken: "restart-secret",
      pluginsDir,
      builtinSkillsDir,
      expectedApiVersion: "1",
      handshakeTimeoutMs: 60_000,
      healthIntervalMs: 60_000,
      onEndpointChanged: (baseUrl) => resolveEndpoint(baseUrl),
    });
    const original = sidecar.baseUrl;

    process.kill(sidecar.handshake.pid, "SIGKILL");
    const recovered = await Promise.race([
      endpointChanged,
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("sidecar did not report a new endpoint")), 30_000),
      ),
    ]);

    expect(recovered).not.toBe(original);
    expect(sidecar.baseUrl).toBe(recovered);
    expect((await fetch(`${recovered}/`)).status).toBe(401);
    expect(
      (
        await fetch(`${recovered}/`, {
          headers: { authorization: "Bearer restart-secret" },
        })
      ).status,
    ).toBe(200);
  }, 90_000);
});

describe("fetchWithTimeout", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("rejects a fetch implementation that never settles", async () => {
    vi.useFakeTimers();
    const request = fetchWithTimeout(
      (() => new Promise<Response>(() => {})) as typeof fetch,
      "http://127.0.0.1/ping",
      {},
      250,
    );
    const rejected = expect(request).rejects.toThrow(
      "request timed out after 250ms",
    );

    await vi.advanceTimersByTimeAsync(250);
    await rejected;
  });
});
