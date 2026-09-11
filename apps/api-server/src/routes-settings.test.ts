import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_SETTINGS } from "@pizza-bot/core";
import { buildApp } from "./index.js";
import { AgentHost } from "./agent-host.js";

describe("settings routes: GET/PUT /settings", () => {
  let dataRoot: string;
  let pluginsDir: string;
  let host: AgentHost;
  let app: ReturnType<typeof buildApp>;

  beforeEach(async () => {
    dataRoot = mkdtempSync(join(tmpdir(), "route-settings-data-"));
    pluginsDir = mkdtempSync(join(tmpdir(), "route-settings-plugins-"));
    host = await AgentHost.create({ dataRoot, pluginsDir });
    app = buildApp(host);
  });

  afterEach(async () => {
    await host.close();
    for (const d of [dataRoot, pluginsDir]) rmSync(d, { recursive: true, force: true });
  });

  const put = (body: unknown) =>
    app.request("/settings", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });

  it("returns the defaults before anything is written", async () => {
    const res = await app.request("/settings");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(DEFAULT_SETTINGS);
  });

  it("PUT persists a theme and GET reflects it", async () => {
    const put1 = await put({ theme: "light" });
    expect(put1.status).toBe(200);
    expect(((await put1.json()) as { theme: string }).theme).toBe("light");

    const get = await app.request("/settings");
    expect(((await get.json()) as { theme: string }).theme).toBe("light");
  });

  it("ignores an invalid theme value (keeps the prior value)", async () => {
    await put({ theme: "light" });
    const res = await put({ theme: "neon" });
    expect(((await res.json()) as { theme: string }).theme).toBe("light");
  });

  it("an empty body leaves settings untouched", async () => {
    await put({ theme: "system" });
    const res = await put({});
    expect(((await res.json()) as { theme: string }).theme).toBe("system");
  });

  it("PUT persists the persona addendum and GET reflects it", async () => {
    const res = await put({ customPromptAddendum: "Always answer in metric units." });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { customPromptAddendum: string }).customPromptAddendum).toBe(
      "Always answer in metric units.",
    );
    const get = await app.request("/settings");
    expect(((await get.json()) as { customPromptAddendum: string }).customPromptAddendum).toBe(
      "Always answer in metric units.",
    );
  });

  it("ignores an over-long persona addendum (keeps the prior value)", async () => {
    await put({ customPromptAddendum: "short" });
    const res = await put({ customPromptAddendum: "x".repeat(8001) });
    expect(((await res.json()) as { customPromptAddendum: string }).customPromptAddendum).toBe("short");
  });

  it("PUT persists the boolean feature flags and ignores non-booleans", async () => {
    const firstAgent = host.agent;
    const res = await put({ enableMemories: true, enableAutomations: "yes" });
    const body = (await res.json()) as { enableMemories: boolean; enableAutomations: boolean };
    expect(body.enableMemories).toBe(true);
    expect(body.enableAutomations).toBe(false);
    expect(host.agent).not.toBe(firstAgent);
    expect(await host.memoriesDirectory()).toBe(join(dataRoot, "memories"));

    const enabledAgent = host.agent;
    await put({ enableMemories: false });
    expect(host.agent).not.toBe(enabledAgent);
    expect(await host.memoriesDirectory()).toBe(false);
  });

  it("persists a tool-call limit and rebuilds the warm graph", async () => {
    const firstAgent = host.agent;
    const res = await put({ maxToolCalls: -1 });
    expect(((await res.json()) as { maxToolCalls: number }).maxToolCalls).toBe(-1);
    expect(host.agent).not.toBe(firstAgent);

    const invalid = await put({ maxToolCalls: 0 });
    expect(((await invalid.json()) as { maxToolCalls: number }).maxToolCalls).toBe(-1);
  });

  it("refreshes scheduler state when the automations setting changes", async () => {
    const reload = vi.spyOn(host.triggerService, "reload");

    await put({ enableAutomations: true });
    expect(reload).toHaveBeenCalledTimes(1);

    await put({ enableAutomations: true });
    await put({ theme: "light" });
    expect(reload).toHaveBeenCalledTimes(1);

    await put({ enableAutomations: false });
    expect(reload).toHaveBeenCalledTimes(2);
  });
});
