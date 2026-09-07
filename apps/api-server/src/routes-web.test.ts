import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildApp, resolveWebDir } from "./index.js";
import type { AgentHost } from "./agent-host.js";

function fakeHost(): AgentHost {
  return {
    dataRoot: ":memory:",
    modelId: "fake:model",
    readiness: "ready",
    whenReady: async () => {},
    triggers: { get: () => undefined },
  } as unknown as AgentHost;
}

const HTML = { accept: "text/html,application/xhtml+xml" };

describe("api-server: browser app", () => {
  let webDir: string;

  beforeAll(() => {
    webDir = mkdtempSync(join(tmpdir(), "pizza-web-"));
    writeFileSync(join(webDir, "index.html"), "<!doctype html><title>Pizza Bot</title>");
    writeFileSync(join(webDir, "pizza-config.js"), "window.__PIZZA_CONFIG__ = {};");
    mkdirSync(join(webDir, "assets"));
    writeFileSync(join(webDir, "assets", "app.js"), "export const app = 1;");
    writeFileSync(join(webDir, "favicon.ico"), "icon-bytes");
  });

  afterAll(() => {
    rmSync(webDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  it("serves the app shell to a navigating browser", async () => {
    const app = buildApp(fakeHost(), {}, {}, { dir: webDir });
    const res = await app.request("/", { headers: HTML });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("<title>Pizza Bot</title>");
  });

  it("keeps the service identity at / for non-browser clients", async () => {
    const app = buildApp(fakeHost(), {}, {}, { dir: webDir });
    const res = await app.request("/");
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ service: "pizza-bot" });
  });

  it("serves built assets and leaves API paths to their routes", async () => {
    const app = buildApp(fakeHost(), {}, {}, { dir: webDir });
    expect((await app.request("/assets/app.js")).status).toBe(200);
    expect((await app.request("/assets/missing.js")).status).toBe(404);
    expect(await (await app.request("/ping")).json()).toEqual({ status: "Healthy" });
  });

  it("generates pizza-config.js instead of serving the placeholder on disk", async () => {
    const app = buildApp(fakeHost(), {}, {}, { dir: webDir });
    const res = await app.request("/pizza-config.js");
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = await res.text();
    expect(body).toContain('"apiBase":"/"');
    expect(body).not.toContain("apiToken");
  });

  it("publishes the bearer token to the browser and keeps the API authenticated", async () => {
    const app = buildApp(fakeHost(), { apiToken: "correct horse" }, {}, { dir: webDir });
    expect((await app.request("/", { headers: HTML })).status).toBe(200);
    expect((await app.request("/assets/app.js")).status).toBe(200);
    expect(await (await app.request("/pizza-config.js")).text()).toContain(
      '"apiToken":"correct horse"',
    );
    expect((await app.request("/")).status).toBe(401);
    expect((await app.request("/status")).status).toBe(401);
  });

  // A browser asks for the favicon before it has read the token out of
  // pizza-config.js, so it has to come back from the unauthenticated side.
  it("serves the favicon without a token", async () => {
    const app = buildApp(fakeHost(), { apiToken: "correct horse" }, {}, { dir: webDir });
    const res = await app.request("/favicon.ico");
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("icon-bytes");
  });

  it("serves nothing when no directory is configured", async () => {
    const app = buildApp(fakeHost());
    expect((await app.request("/", { headers: HTML })).status).toBe(200);
    expect(await (await app.request("/", { headers: HTML })).json()).toMatchObject({
      service: "pizza-bot",
    });
    expect((await app.request("/pizza-config.js")).status).toBe(404);
  });

  it("reads the directory from the environment", () => {
    expect(resolveWebDir({})).toBeUndefined();
    expect(resolveWebDir({ PIZZA_WEB_DIR: "  " })).toBeUndefined();
    expect(resolveWebDir({ PIZZA_WEB_DIR: " /opt/pizza-bot/web " })).toBe("/opt/pizza-bot/web");
  });
});
