import { describe, expect, it } from "vitest";
import { PluginImportError, parsePluginArchive } from "./plugin-import.js";
import { storedZip as zip } from "./test-utils/stored-zip.js";

const manifest = (name: string) =>
  JSON.stringify({ name, displayName: "Weather", mcpServers: ".mcp.json" });

describe("parsePluginArchive", () => {
  it("parses a plugin directory and strips its top-level root", async () => {
    const plugin = await parsePluginArchive(zip([
      { path: "weather/.claude-plugin/plugin.json", content: manifest("weather") },
      { path: "weather/.mcp.json", content: '{"mcpServers":{}}' },
      { path: "weather/skills/forecast/SKILL.md", content: "---\nname: forecast\ndescription: x\n---\n\n# Forecast\n" },
    ]));

    expect(plugin.name).toBe("weather");
    expect(plugin.manifest.displayName).toBe("Weather");
    expect(plugin.files.map((f) => f.path)).toEqual([
      ".claude-plugin/plugin.json",
      ".mcp.json",
      "skills/forecast/SKILL.md",
    ]);
  });

  it("accepts a manifest at the archive root", async () => {
    const plugin = await parsePluginArchive(zip([
      { path: ".claude-plugin/plugin.json", content: manifest("weather") },
    ]));
    expect(plugin.name).toBe("weather");
    expect(plugin.files[0]!.path).toBe(".claude-plugin/plugin.json");
  });

  it.each([
    {
      label: "missing manifest",
      files: [{ path: "weather/README.md", content: "hi" }],
      code: "invalid_bundle",
    },
    {
      label: "two manifests",
      files: [
        { path: "a/.claude-plugin/plugin.json", content: manifest("a") },
        { path: "b/.claude-plugin/plugin.json", content: manifest("b") },
      ],
      code: "invalid_bundle",
    },
    {
      label: "non-kebab name",
      files: [{ path: ".claude-plugin/plugin.json", content: manifest("Weather_Plugin") }],
      code: "invalid_manifest",
    },
    {
      label: "malformed JSON",
      files: [{ path: ".claude-plugin/plugin.json", content: "{ not json" }],
      code: "invalid_manifest",
    },
  ])("rejects $label", async ({ files, code }) => {
    await expect(parsePluginArchive(zip(files))).rejects.toMatchObject({ code });
  });

  it("rejects files outside the plugin directory", async () => {
    await expect(parsePluginArchive(zip([
      { path: "weather/.claude-plugin/plugin.json", content: manifest("weather") },
      { path: "other/rogue.txt", content: "x" },
    ]))).rejects.toBeInstanceOf(PluginImportError);
  });
});
