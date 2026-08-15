import { describe, expect, it } from "vitest";
import { pluginManifestSchema } from "@pizza-bot/plugin-api";
import { readFile, readdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createPluginHostContract,
  evaluatePluginCompatibility,
  type PluginHostContract,
} from "./compatibility.js";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const productPackages = {
  root: "package.json",
  apiServer: "apps/api-server/package.json",
  desktopShell: "apps/desktop-shell/package.json",
  web: "apps/web/package.json",
} as const;

const host: PluginHostContract = {
  version: "1.4.0",
  capabilities: new Set(["skills/v1", "mcp-servers/v1"]),
};

async function packageVersion(relativePath: string): Promise<string> {
  const parsed = JSON.parse(
    await readFile(join(repoRoot, relativePath), "utf8"),
  ) as { version: string };
  return parsed.version;
}

describe("plugin compatibility", () => {
  it("accepts matching engine and required capability declarations", () => {
    const manifest = pluginManifestSchema.parse({
      name: "compatible",
      engines: { pizzaBot: ">=1.2.0 <2" },
      capabilities: {
        required: ["skills/v1"],
        optional: ["mcp-apps/v1"],
      },
    });

    expect(evaluatePluginCompatibility(manifest, host)).toEqual({
      compatible: true,
    });
  });

  it("rejects unsatisfied engine ranges", () => {
    const manifest = pluginManifestSchema.parse({
      name: "future-host",
      engines: { pizzaBot: ">=2" },
    });

    expect(evaluatePluginCompatibility(manifest, host)).toMatchObject({
      compatible: false,
      detail: expect.stringContaining("this host is 1.4.0"),
    });
  });

  it("rejects unknown required capabilities but ignores unknown optional ones", () => {
    const required = pluginManifestSchema.parse({
      name: "required-apps",
      capabilities: { required: ["mcp-apps/v1"] },
    });
    const optional = pluginManifestSchema.parse({
      name: "optional-apps",
      capabilities: { optional: ["mcp-apps/v1"] },
    });

    expect(evaluatePluginCompatibility(required, host)).toMatchObject({
      compatible: false,
      detail: expect.stringContaining("mcp-apps/v1"),
    });
    expect(evaluatePluginCompatibility(optional, host)).toEqual({
      compatible: true,
    });
  });

  it("keeps product package versions aligned with the plugin host", async () => {
    const apiVersion = await packageVersion(productPackages.apiServer);
    const versions = Object.fromEntries(
      await Promise.all(
        Object.entries(productPackages).map(async ([name, relativePath]) => [
          name,
          await packageVersion(relativePath),
        ]),
      ),
    );

    expect(versions).toEqual({
      root: apiVersion,
      apiServer: apiVersion,
      desktopShell: apiVersion,
      web: apiVersion,
    });
  });

  it("keeps shipped and example plugins compatible with the current host release", async () => {
    const currentHost = createPluginHostContract(
      await packageVersion(productPackages.apiServer),
    );

    for (const relativeRoot of ["plugins", "examples/plugins"]) {
      const pluginsDir = join(repoRoot, relativeRoot);
      const pluginDirs = (await readdir(pluginsDir, { withFileTypes: true }))
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name);
      let checked = 0;

      for (const pluginDir of pluginDirs) {
        const manifestPath = join(
          pluginsDir,
          pluginDir,
          ".claude-plugin/plugin.json",
        );
        let raw: string;
        try {
          raw = await readFile(manifestPath, "utf8");
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
          throw error;
        }

        const manifest = pluginManifestSchema.parse(JSON.parse(raw));
        expect(
          evaluatePluginCompatibility(manifest, currentHost),
          `${relativeRoot}/${pluginDir}`,
        ).toEqual({ compatible: true });
        checked++;
      }

      expect(checked, relativeRoot).toBeGreaterThan(0);
    }
  });
});
