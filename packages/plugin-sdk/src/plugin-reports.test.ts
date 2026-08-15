import { afterEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadPlugins } from "./plugin-host.js";
import { createPluginHostContract } from "./compatibility.js";

const roots: string[] = [];
const hostContract = createPluginHostContract("1.0.0");

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) =>
      rm(root, {
        recursive: true,
        force: true,
        maxRetries: 3,
        retryDelay: 100,
      }),
    ),
  );
});

async function writePlugin(
  directory: string,
  manifest: unknown,
): Promise<void> {
  await mkdir(join(directory, ".claude-plugin"), { recursive: true });
  await writeFile(
    join(directory, ".claude-plugin", "plugin.json"),
    typeof manifest === "string"
      ? manifest
      : `${JSON.stringify(manifest)}\n`,
  );
}

async function pluginRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "plugin-reports-"));
  roots.push(root);
  return root;
}

describe("plugin load reports", () => {
  it("retains loaded, disabled, incompatible, and failed discoveries", async () => {
    const root = await pluginRoot();
    await writePlugin(join(root, "loaded"), {
      apiVersion: "pizza-bot/v1",
      name: "loaded",
      engines: { pizzaBot: ">=1 <2" },
      capabilities: { required: ["skills/v1"] },
    });
    await writePlugin(join(root, "disabled"), {
      apiVersion: "pizza-bot/v1",
      name: "disabled",
      enabled: false,
    });
    await writePlugin(join(root, "future-api"), {
      apiVersion: "pizza-bot/v2",
      name: "future-api",
    });
    await writePlugin(join(root, "unsafe-folder"), {
      apiVersion: "pizza-bot/v3",
      name: "../../../escape",
    });
    await writePlugin(join(root, "future-engine"), {
      apiVersion: "pizza-bot/v1",
      name: "future-engine",
      engines: { pizzaBot: ">=2" },
    });
    await writePlugin(join(root, "missing-capability"), {
      apiVersion: "pizza-bot/v1",
      name: "missing-capability",
      capabilities: { required: ["mcp-apps/v1"] },
    });
    await writePlugin(join(root, "malformed"), "{not-json");

    const logs: string[] = [];
    const result = await loadPlugins({
      pluginsDir: root,
      hostContract,
      connectMcp: false,
      log: (message) => logs.push(message),
    });
    const byName = new Map(
      result.pluginReports.map((report) => [report.name, report]),
    );

    expect(byName.get("loaded")).toMatchObject({ status: "loaded" });
    expect(byName.get("disabled")).toMatchObject({
      status: "disabled",
      detail: "Disabled by plugin manifest",
    });
    expect(byName.get("future-api")).toMatchObject({
      apiVersion: "pizza-bot/v2",
      status: "incompatible",
    });
    expect(byName.get("unsafe-folder")).toMatchObject({
      apiVersion: "pizza-bot/v3",
      status: "incompatible",
    });
    expect(byName.has("../../../escape")).toBe(false);
    expect(byName.get("future-engine")).toMatchObject({
      status: "incompatible",
      detail: expect.stringContaining("Requires Pizza Bot"),
    });
    expect(byName.get("missing-capability")).toMatchObject({
      status: "incompatible",
      detail: expect.stringContaining("mcp-apps/v1"),
    });
    expect(byName.get("malformed")).toMatchObject({
      apiVersion: "unknown",
      status: "failed",
    });
    expect(logs).toEqual(
      expect.arrayContaining([
        expect.stringContaining("Disabled by plugin manifest"),
        expect.stringContaining("Requires Pizza Bot"),
        expect.stringContaining("Missing required plugin capabilities"),
      ]),
    );
  });

  it("reports contribution load failures without partially registering them", async () => {
    const root = await pluginRoot();
    await mkdir(join(root, "outside"));
    await writePlugin(join(root, "broken-path"), {
      apiVersion: "pizza-bot/v1",
      name: "broken-path",
      skills: "../outside",
    });

    const result = await loadPlugins({
      pluginsDir: root,
      hostContract,
      connectMcp: false,
    });

    expect(result.pluginReports).toContainEqual(
      expect.objectContaining({
        name: "broken-path",
        status: "failed",
        detail: expect.stringContaining("escapes the plugin root"),
      }),
    );
    expect(result.registry.skills.size).toBe(0);
  });
});
