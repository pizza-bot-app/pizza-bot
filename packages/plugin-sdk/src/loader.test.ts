import { describe, it, expect } from "vitest";
import { fileURLToPath } from "node:url";
import { dirname, resolve, join } from "node:path";
import { mkdtemp, mkdir, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import {
  ContributionRegistry,
  PluginContributionCollisionError,
} from "./registry.js";
import { FsPluginLoader, PluginPathError } from "./loader.js";
import { pluginManifestSchema } from "@pizza-bot/plugin-api";

async function writeEnvExpansionPluginFixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "plugin-env-fixture-"));
  await mkdir(join(root, ".claude-plugin"), { recursive: true });
  await writeFile(
    join(root, ".claude-plugin/plugin.json"),
    JSON.stringify({ name: "env-fixture", version: "1.0.0", mcpServers: "./.mcp.json" }),
  );
  await writeFile(
    join(root, ".mcp.json"),
    JSON.stringify({
      mcpServers: {
        "remote-status": {
          type: "http",
          url: "https://status.example/mcp",
          headers: { Authorization: "Bearer ${STATUS_API_KEY}" },
        },
      },
    }),
  );
  return root;
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const EXAMPLES_DIR = resolve(__dirname, "../../../examples/plugins");
const EXAMPLE_ROOT = resolve(__dirname, "../../../examples/plugins/mcp-status");
const MANIFEST = resolve(EXAMPLE_ROOT, ".claude-plugin/plugin.json");

describe("FsPluginLoader", () => {
  it("loads the example plugin and registers its supported contributions", async () => {
    const loader = new FsPluginLoader();
    const reg = new ContributionRegistry();
    const manifest = await loader.readManifest(MANIFEST);
    await loader.load(manifest, EXAMPLE_ROOT, reg);

    expect(reg.skills.has("health-report")).toBe(true);

    expect(reg.mcpServers.has("mcp-status")).toBe(true);
    expect(reg.mcpServers.get("mcp-status")?.qualifiedId).toBe(
      "mcp-status/mcp-status",
    );
    const server = reg.mcpServers.get("mcp-status")!.value;
    expect(server).toMatchObject({ command: "node" });
    const args = (server as { args: string[] }).args;
    const serverArg = args[0]!;
    expect(serverArg).toContain("/src/server.js");
    expect(serverArg).not.toContain("${CLAUDE_PLUGIN_ROOT}");
    expect(serverArg.startsWith(EXAMPLE_ROOT)).toBe(true);
  });

  it("finds plugins under a directory for explicit host loading", async () => {
    const loader = new FsPluginLoader();
    const reg = new ContributionRegistry();
    const sources = await loader.find(EXAMPLES_DIR);
    for (const source of sources) {
      await loader.load(source.manifest, source.root, reg);
    }
    expect(sources.map(({ manifest }) => manifest.name)).toEqual(["mcp-status"]);
    expect(reg.skills.has("health-report")).toBe(true);
    expect(reg.mcpServers.has("mcp-status")).toBe(true);
  });

  it("expands ${ENV_VAR} in an MCP entry (plugin .mcp.json bearer token)", async () => {
    const root = await writeEnvExpansionPluginFixture();
    process.env.STATUS_API_KEY = "test-token-123";
    try {
      const loader = new FsPluginLoader();
      const reg = new ContributionRegistry();
      const manifest = await loader.readManifest(resolve(root, ".claude-plugin/plugin.json"));
      await loader.load(manifest, root, reg);
      const server = reg.mcpServers.get("remote-status")!.value as {
        headers: Record<string, string>;
      };
      expect(server.headers.Authorization).toBe("Bearer test-token-123");
    } finally {
      delete process.env.STATUS_API_KEY;
    }
  });

  it("expands an unset ${ENV_VAR} to empty string", async () => {
    const root = await writeEnvExpansionPluginFixture();
    delete process.env.STATUS_API_KEY;
    const loader = new FsPluginLoader();
    const reg = new ContributionRegistry();
    const manifest = await loader.readManifest(resolve(root, ".claude-plugin/plugin.json"));
    await loader.load(manifest, root, reg);
    const server = reg.mcpServers.get("remote-status")!.value as {
      headers: Record<string, string>;
    };
    expect(server.headers.Authorization).toBe("Bearer ");
  });

  it("rejects a manifest with a non-kebab-case name", async () => {
    const root = await mkdtemp(join(tmpdir(), "plugin-name-fixture-"));
    const manifestPath = join(root, ".claude-plugin/plugin.json");
    await mkdir(join(root, ".claude-plugin"), { recursive: true });
    await writeFile(manifestPath, JSON.stringify({ name: "Bad Name" }));

    await expect(
      new FsPluginLoader().readManifest(manifestPath),
    ).rejects.toThrow(/kebab-case name/);
  });

  it("reports malformed manifests while ignoring directories without one", async () => {
    const pluginsDir = await mkdtemp(join(tmpdir(), "plugin-discovery-"));
    const brokenRoot = join(pluginsDir, "broken");
    await mkdir(join(brokenRoot, ".claude-plugin"), { recursive: true });
    await writeFile(join(brokenRoot, ".claude-plugin/plugin.json"), "{not-json");
    await mkdir(join(pluginsDir, "ordinary-directory"));

    const errors: Array<{ root: string; error: unknown }> = [];
    const sources = await new FsPluginLoader().find(
      pluginsDir,
      (root, error) => errors.push({ root, error }),
    );

    expect(sources).toEqual([]);
    expect(errors).toHaveLength(1);
    expect(errors[0]?.root).toBe(brokenRoot);
    expect(String(errors[0]?.error)).toContain("Invalid plugin manifest");
  });

  it("does not mutate the registry when a late contribution is invalid", async () => {
    const root = await mkdtemp(join(tmpdir(), "plugin-atomic-invalid-"));
    const skill = join(root, "skill.md");
    await writeFile(skill, "# skill");
    const manifest = pluginManifestSchema.parse({
      name: "invalid-late",
      skills: ["./skill.md"],
      mcpServers: {
        escaped: { command: "node", cwd: ".." },
      },
    });
    const registry = new ContributionRegistry();

    await expect(new FsPluginLoader().load(manifest, root, registry)).rejects.toBeInstanceOf(
      PluginPathError,
    );
    expect(registry.skills.size).toBe(0);
    expect(registry.mcpServers.size).toBe(0);
  });

  it("rejects collisions without partially merging the incoming plugin", async () => {
    const loader = new FsPluginLoader();
    const registry = new ContributionRegistry();
    const firstRoot = await mkdtemp(join(tmpdir(), "plugin-collision-first-"));
    const secondRoot = await mkdtemp(join(tmpdir(), "plugin-collision-second-"));
    await writeFile(join(secondRoot, "unique.md"), "# skill");

    await loader.load(
      pluginManifestSchema.parse({
        name: "first-plugin",
        mcpServers: {
          shared: { type: "http", url: "https://example.com/first" },
        },
      }),
      firstRoot,
      registry,
    );

    await expect(
      loader.load(
        pluginManifestSchema.parse({
          name: "second-plugin",
          skills: ["./unique.md"],
          mcpServers: {
            shared: { type: "http", url: "https://example.com/second" },
          },
        }),
        secondRoot,
        registry,
      ),
    ).rejects.toMatchObject({
      name: "PluginContributionCollisionError",
      id: "shared",
      existingPlugin: "first-plugin",
      incomingPlugin: "second-plugin",
    } satisfies Partial<PluginContributionCollisionError>);

    expect(registry.mcpServers.get("shared")?.pluginName).toBe("first-plugin");
    expect(registry.skills.has("unique")).toBe(false);
  });

  it("rejects declared paths outside the plugin root", async () => {
    const parent = await mkdtemp(join(tmpdir(), "plugin-path-parent-"));
    const root = join(parent, "plugin");
    await mkdir(root);
    await writeFile(join(parent, "outside.md"), "# outside");
    const manifest = pluginManifestSchema.parse({
      name: "escaping-plugin",
      skills: ["../outside.md"],
    });

    await expect(
      new FsPluginLoader().load(manifest, root, new ContributionRegistry()),
    ).rejects.toThrow(/escapes the plugin root/);
  });

  // Creating a symlink needs elevated privilege on Windows (EPERM otherwise).
  it.skipIf(process.platform === "win32")("rejects contribution symlinks that escape the plugin root", async () => {
    const parent = await mkdtemp(join(tmpdir(), "plugin-symlink-parent-"));
    const root = join(parent, "plugin");
    await mkdir(root);
    const outside = join(parent, "outside.md");
    await writeFile(outside, "# outside");
    await symlink(outside, join(root, "linked.md"));
    const manifest = pluginManifestSchema.parse({
      name: "symlink-plugin",
      skills: ["./linked.md"],
    });

    await expect(
      new FsPluginLoader().load(manifest, root, new ContributionRegistry()),
    ).rejects.toThrow(/escapes the plugin root/);
  });

  it("accepts an absolute cwd inside a plugin root reached through a symlinked ancestor", async () => {
    // macOS `tmpdir()` is /var/... but realpath is /private/var/..., so an
    // absolute declared path only stays inside `root` once both are canonical.
    const parent = await mkdtemp(join(tmpdir(), "plugin-symlinked-root-"));
    const root = join(parent, "plugin");
    await mkdir(root);
    const manifest = pluginManifestSchema.parse({
      name: "abs-cwd-plugin",
      mcpServers: {
        inside: { command: "node", cwd: root },
      },
    });

    const registry = new ContributionRegistry();
    await new FsPluginLoader().load(manifest, root, registry);
    expect(registry.mcpServers.has("inside")).toBe(true);
  });

  it("confines MCP working directories to the plugin root", async () => {
    const parent = await mkdtemp(join(tmpdir(), "plugin-mcp-cwd-parent-"));
    const root = join(parent, "plugin");
    await mkdir(root);
    const manifest = pluginManifestSchema.parse({
      name: "mcp-cwd-plugin",
      mcpServers: {
        escaped: { command: "node", cwd: ".." },
      },
    });

    await expect(
      new FsPluginLoader().load(manifest, root, new ContributionRegistry()),
    ).rejects.toThrow(/escapes the plugin root/);
  });
});
