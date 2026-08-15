import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadPlugins } from "./plugin-host.js";
import { materializePlugin } from "./materializer.js";
import {
  pluginManifestSchema,
  type PluginManifest,
} from "@pizza-bot/plugin-api";
import { createPluginHostContract } from "./compatibility.js";

const roots: string[] = [];

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

async function tempRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

async function createPlugin(options?: {
  sync?: Array<"install" | "startup" | "manual">;
  timeoutMs?: number;
  entrypoint?: string;
}): Promise<{
  cacheRoot: string;
  manifest: PluginManifest;
  pluginRoot: string;
  pluginsDir: string;
  sourceRoot: string;
}> {
  const root = await tempRoot("plugin-materializer-");
  const pluginsDir = join(root, "plugins");
  const pluginRoot = join(pluginsDir, "generated-tools");
  const sourceRoot = join(root, "source");
  const cacheRoot = join(root, "cache");
  await mkdir(join(pluginRoot, ".claude-plugin"), { recursive: true });
  await mkdir(sourceRoot, { recursive: true });
  await writeFile(join(sourceRoot, "description.txt"), "from source\n");

  const rawManifest = {
    name: "generated-tools",
    displayName: "Generated Tools",
    extensions: {
      "dev.pizzabot.materializer": {
        entrypoint: options?.entrypoint ?? "./materialize.mjs",
        sourceRoots: [sourceRoot],
        ...(options?.sync ? { sync: options.sync } : {}),
        ...(options?.timeoutMs ? { timeoutMs: options.timeoutMs } : {}),
      },
    },
  };
  const manifest = pluginManifestSchema.parse(rawManifest);
  await writeFile(
    join(pluginRoot, ".claude-plugin", "plugin.json"),
    `${JSON.stringify(rawManifest, null, 2)}\n`,
  );
  await writeFile(join(pluginRoot, "materialize.mjs"), successScript());
  return { cacheRoot, manifest, pluginRoot, pluginsDir, sourceRoot };
}

function successScript(): string {
  return `
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const output = process.env.PIZZA_MATERIALIZER_OUTPUT_DIR;
const name = process.env.PIZZA_MATERIALIZER_PLUGIN_NAME;
const source = process.argv[2];
const description = readFileSync(join(source, "description.txt"), "utf8").trim();
mkdirSync(join(output, ".claude-plugin"), { recursive: true });
mkdirSync(join(output, "skills", "generated"), { recursive: true });
writeFileSync(
  join(output, ".claude-plugin", "plugin.json"),
  JSON.stringify({ name, skills: "./skills", mcpServers: "./.mcp.json" }),
);
writeFileSync(
  join(output, "skills", "generated", "SKILL.md"),
  "---\\nname: generated\\ndescription: " + description + "\\n---\\n\\nGenerated instructions.\\n",
);
writeFileSync(
  join(output, ".mcp.json"),
  JSON.stringify({ mcpServers: { generated: { command: "node", args: ["server.mjs"] } } }),
);
`;
}

describe("plugin materializers", () => {
  it("loads generated skills and MCP entries under the source plugin identity", async () => {
    const fixture = await createPlugin();

    const loaded = await loadPlugins({
      pluginsDir: fixture.pluginsDir,
      hostContract: createPluginHostContract("1.0.0"),
      materializationCacheDir: fixture.cacheRoot,
      materializationReason: "install",
      connectMcp: false,
    });

    expect(loaded.pluginReports).toContainEqual(
      expect.objectContaining({
        name: "generated-tools",
        status: "loaded",
      }),
    );
    expect(loaded.materializations["generated-tools"]).toMatchObject({
      state: "synced",
      sourceRoots: [fixture.sourceRoot],
    });
    expect(loaded.skills.get("generated")).toMatchObject({
      description: "from source",
      source: "plugin",
      pluginName: "generated-tools",
    });
    expect(loaded.registry.mcpServers.get("generated")).toMatchObject({
      pluginName: "generated-tools",
      value: { command: "node", args: ["server.mjs"] },
    });
  });

  it("does not run for a lifecycle reason omitted by the manifest", async () => {
    const fixture = await createPlugin({ sync: ["manual"] });

    const result = await materializePlugin({
      pluginRoot: fixture.pluginRoot,
      manifest: fixture.manifest,
      cacheRoot: fixture.cacheRoot,
      reason: "startup",
    });

    expect(result.root).toBeUndefined();
    expect(result.status).toMatchObject({
      state: "error",
      detail: expect.stringContaining("not configured for startup"),
    });
  });

  it("rejects an entrypoint outside the plugin root", async () => {
    const fixture = await createPlugin({ entrypoint: "../outside.mjs" });
    await writeFile(join(fixture.pluginsDir, "outside.mjs"), successScript());

    const result = await materializePlugin({
      pluginRoot: fixture.pluginRoot,
      manifest: fixture.manifest,
      cacheRoot: fixture.cacheRoot,
      reason: "manual",
    });

    expect(result.root).toBeUndefined();
    expect(result.status).toMatchObject({
      state: "error",
      detail: "Materializer entrypoint escapes the plugin root",
    });
  });

  it("rejects generated output with an unusable skill", async () => {
    const fixture = await createPlugin();
    await writeFile(
      join(fixture.pluginRoot, "materialize.mjs"),
      `
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const output = process.env.PIZZA_MATERIALIZER_OUTPUT_DIR;
mkdirSync(join(output, ".claude-plugin"), { recursive: true });
mkdirSync(join(output, "skills", "broken"), { recursive: true });
writeFileSync(join(output, ".claude-plugin", "plugin.json"), JSON.stringify({
  name: process.env.PIZZA_MATERIALIZER_PLUGIN_NAME,
  skills: "./skills"
}));
writeFileSync(join(output, "skills", "broken", "SKILL.md"), "# Missing frontmatter\\n");
`,
    );

    const result = await materializePlugin({
      pluginRoot: fixture.pluginRoot,
      manifest: fixture.manifest,
      cacheRoot: fixture.cacheRoot,
      reason: "manual",
    });

    expect(result.root).toBeUndefined();
    expect(result.status).toMatchObject({
      state: "error",
      detail: expect.stringContaining('skipping skill "broken"'),
    });
  });

  it("times out a materializer process", async () => {
    const fixture = await createPlugin({ timeoutMs: 25 });
    await writeFile(
      join(fixture.pluginRoot, "materialize.mjs"),
      "setInterval(() => {}, 1000);\n",
    );

    const result = await materializePlugin({
      pluginRoot: fixture.pluginRoot,
      manifest: fixture.manifest,
      cacheRoot: fixture.cacheRoot,
      reason: "manual",
    });

    expect(result.root).toBeUndefined();
    expect(result.status).toMatchObject({
      state: "error",
      detail: "Materializer timed out after 25ms",
    });
  });

  it("keeps the last successful snapshot when a later sync fails", async () => {
    const fixture = await createPlugin();
    const first = await materializePlugin({
      pluginRoot: fixture.pluginRoot,
      manifest: fixture.manifest,
      cacheRoot: fixture.cacheRoot,
      reason: "install",
    });
    expect(first.status.state).toBe("synced");
    await writeFile(
      join(fixture.pluginRoot, "materialize.mjs"),
      'throw new Error("source unavailable");\n',
    );

    const second = await materializePlugin({
      pluginRoot: fixture.pluginRoot,
      manifest: fixture.manifest,
      cacheRoot: fixture.cacheRoot,
      reason: "startup",
    });

    expect(second.root).toBe(first.root);
    expect(second.status).toMatchObject({
      state: "stale",
      lastSyncedAt: first.status.lastSyncedAt,
      detail: expect.stringContaining("source unavailable"),
    });
    expect(
      await readFile(
        join(second.root!, "skills", "generated", "SKILL.md"),
        "utf8",
      ),
    ).toContain("description: from source");
  });
});
