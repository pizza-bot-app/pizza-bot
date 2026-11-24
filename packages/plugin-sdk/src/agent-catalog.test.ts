import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  composeAgentMd,
  loadAgentCatalog,
  loadUserAgents,
  mergeAgentCatalogs,
  parseAgentMd,
} from "./agent-catalog.js";
import { ContributionRegistry } from "./registry.js";
import { migrateSkillToolGrants } from "./skill-tool-migration.js";

const PLANNER = [
  "---",
  "name: planner",
  "description: Plans the user's week.",
  "model: anthropic:claude-haiku-4-5",
  "tools:",
  "  - mcp:calendar:list_events",
  "  - mcp:calendar:create_event",
  "skills: [calendar]",
  "interruptOn:",
  "  mcp:calendar:create_event: true",
  "metadata:",
  "  display-name: Week Planner",
  "---",
  "",
  "You plan weeks.",
  "",
].join("\n");

describe("parseAgentMd", () => {
  it("reads Claude Code subagent frontmatter plus approvals, with the body as the prompt", () => {
    expect(parseAgentMd("planner", PLANNER, { source: "user" })).toEqual({
      id: "planner",
      name: "Week Planner",
      description: "Plans the user's week.",
      systemPrompt: "You plan weeks.",
      model: "anthropic:claude-haiku-4-5",
      declaredTools: ["mcp:calendar:list_events", "mcp:calendar:create_event"],
      skills: ["calendar"],
      interruptOn: { "mcp:calendar:create_event": true },
      source: "user",
    });
  });

  it("returns null without a description and rejects the reserved id", () => {
    expect(parseAgentMd("x", "---\nname: x\n---\nbody", { source: "user" })).toBeNull();
    expect(() => parseAgentMd("pizza-bot", PLANNER, { source: "user" })).toThrow(/reserved/);
  });

  it("refuses frontmatter it can only partly recover, so approvals are never dropped", () => {
    const broken = "---\nname: x\ndescription: d\ninterruptOn: [unclosed\n---\nbody";
    expect(() => parseAgentMd("x", broken, { source: "user" })).toThrow(/invalid frontmatter/);
  });

  it("round-trips through composeAgentMd", () => {
    const parsed = parseAgentMd("planner", PLANNER, { source: "user" })!;
    const again = parseAgentMd("planner", composeAgentMd(parsed), { source: "user" });
    expect(again).toEqual(parsed);
  });
});

describe("agent catalogs", () => {
  it("loads <id>.md files from a directory and skips other entries", async () => {
    const dir = await mkdtemp(join(tmpdir(), "agents-"));
    await writeFile(join(dir, "planner.md"), PLANNER);
    await writeFile(join(dir, "notes.txt"), "ignored");
    await mkdir(join(dir, "nested"));
    const catalog = await loadUserAgents(dir);
    expect([...catalog.keys()]).toEqual(["planner"]);
  });

  it("loads plugin contributions with plugin provenance", async () => {
    const dir = await mkdtemp(join(tmpdir(), "agents-"));
    const file = join(dir, "planner.md");
    await writeFile(file, PLANNER);
    const registry = new ContributionRegistry();
    registry.registerAgent("workspace", dir, "planner", file);
    expect((await loadAgentCatalog(registry)).get("planner")).toMatchObject({
      source: "plugin",
      pluginName: "workspace",
    });
  });

  it("lets a user agent override a shipped one and records what it hides", () => {
    const shipped = parseAgentMd("planner", PLANNER, { source: "plugin", pluginName: "p" })!;
    const user = parseAgentMd("planner", PLANNER, { source: "user" })!;
    const merged = mergeAgentCatalogs(new Map([["planner", shipped]]), new Map([["planner", user]]));
    expect(merged.get("planner")).toMatchObject({ source: "user", overrides: "plugin" });
  });
});

describe("migrateSkillToolGrants", () => {
  it("moves a user skill's tool grants into an agent that mounts it", async () => {
    const root = await mkdtemp(join(tmpdir(), "migrate-"));
    const skillsDir = join(root, "skills");
    const agentsDir = join(root, "agents");
    await mkdir(join(skillsDir, "mailer"), { recursive: true });
    await writeFile(
      join(skillsDir, "mailer", "SKILL.md"),
      "---\nname: mailer\ndescription: Sends mail.\nlicense: MIT\ntools:\n  - mcp:mail:send\n" +
        "interruptOn:\n  mcp:mail:send: true\n---\n# Mailer\n",
    );

    expect(await migrateSkillToolGrants(skillsDir, agentsDir)).toEqual(["mailer"]);
    const agent = parseAgentMd("mailer", await readFile(join(agentsDir, "mailer.md"), "utf8"), {
      source: "user",
    });
    expect(agent).toMatchObject({
      description: "Sends mail.",
      declaredTools: ["mcp:mail:send"],
      skills: ["mailer"],
      interruptOn: { "mcp:mail:send": true },
    });
    const skill = await readFile(join(skillsDir, "mailer", "SKILL.md"), "utf8");
    expect(skill).toMatch(/^---\r?\nname: mailer\r?\ndescription: Sends mail\.\r?\nlicense: MIT\r?\n---\r?\n# Mailer/);
    expect(await migrateSkillToolGrants(skillsDir, agentsDir)).toEqual([]);
  });

  it("leaves the skill alone when an agent with its id already exists", async () => {
    const root = await mkdtemp(join(tmpdir(), "migrate-"));
    const skillsDir = join(root, "skills");
    const agentsDir = join(root, "agents");
    await mkdir(join(skillsDir, "mailer"), { recursive: true });
    await mkdir(agentsDir);
    const original = "---\nname: mailer\ndescription: Sends mail.\ntools: mcp:mail:send\n---\n";
    await writeFile(join(skillsDir, "mailer", "SKILL.md"), original);
    await writeFile(join(agentsDir, "mailer.md"), PLANNER);
    expect(await migrateSkillToolGrants(skillsDir, agentsDir)).toEqual([]);
    expect(await readFile(join(skillsDir, "mailer", "SKILL.md"), "utf8")).toBe(original);
  });
});

describe("shipped plugin agents", () => {
  it("loads the Google Workspace agent with both skills and its approval", async () => {
    const { FsPluginLoader } = await import("./loader.js");
    const root = join(import.meta.dirname, "../../../plugins/google-workspace");
    const loader = new FsPluginLoader();
    const registry = new ContributionRegistry();
    await loader.load(await loader.readManifest(join(root, ".claude-plugin/plugin.json")), root, registry);
    const agent = (await loadAgentCatalog(registry)).get("google-workspace");
    expect(agent).toMatchObject({
      name: "Google Workspace",
      skills: ["email", "calendar"],
      interruptOn: {
        "mcp:google-workspace:create_event": { allowedDecisions: ["approve", "edit", "reject"] },
      },
    });
    expect(registry.skills.has("calendar") && registry.skills.has("email")).toBe(true);
  });
});
