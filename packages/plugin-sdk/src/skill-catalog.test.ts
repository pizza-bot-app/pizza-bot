import { describe, it, expect } from "vitest";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { mkdtemp, mkdir, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SkillCatalog, SkillCatalogEntry } from "@pizza-bot/core";
import { ContributionRegistry } from "./registry.js";
import { FsPluginLoader } from "./loader.js";
import {
  loadBuiltinSkills,
  loadSkillCatalog,
  loadUserSkills,
  mergeSkillCatalogs,
} from "./skill-catalog.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const EXAMPLE_ROOT = resolve(__dirname, "../../../examples/plugins/mcp-status");
const MANIFEST = resolve(EXAMPLE_ROOT, ".claude-plugin/plugin.json");
const BUILTIN_SKILLS_DIR = resolve(__dirname, "../../../skills");

describe("loadSkillCatalog", () => {
  it("reads a plugin-shipped skill into a catalog entry with parsed metadata", async () => {
    const loader = new FsPluginLoader();
    const reg = new ContributionRegistry();
    const manifest = await loader.readManifest(MANIFEST);
    await loader.load(manifest, EXAMPLE_ROOT, reg);

    const catalog = await loadSkillCatalog(reg);
    const skill = catalog.get("health-report");
    expect(skill).toBeDefined();
    expect(skill!.name).toBe("health-report");
    expect(skill!.description).toMatch(/health report/i);
    expect(skill!.source).toBe("plugin");
    expect(skill!.pluginName).toBe("mcp-status");

    const skillMd = skill!.files.find((f) => f.path === "/skills/health-report/SKILL.md");
    expect(skillMd).toBeDefined();
    // Line ending is the checkout's, not the repo's: core.autocrlf yields CRLF.
    expect(skillMd!.content).toEqual(expect.stringMatching(/^---\r?\n/));
    expect(skillMd!.mimeType).toBe("text/markdown");
    expect(skill!.files[0]!.path).toBe("/skills/health-report/SKILL.md");
  });

  it("skips a skill whose SKILL.md has no description (no routing signal)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "skill-cat-"));
    const skillDir = join(dir, "no-desc");
    await mkdir(skillDir, { recursive: true });
    await writeFile(join(skillDir, "SKILL.md"), "---\nname: no-desc\n---\n# No description\n");

    const reg = new ContributionRegistry();
    reg.registerSkill("test", dir, "no-desc", skillDir);

    const catalog = await loadSkillCatalog(reg);
    expect(catalog.has("no-desc")).toBe(false);
  });

  it("includes sibling files (progressive-disclosure bundle) after SKILL.md", async () => {
    const dir = await mkdtemp(join(tmpdir(), "skill-cat-"));
    const skillDir = join(dir, "bundled");
    await mkdir(skillDir, { recursive: true });
    await writeFile(join(skillDir, "SKILL.md"), "---\nname: bundled\ndescription: A bundled skill.\n---\n# Bundled\n");
    await writeFile(join(skillDir, "reference.md"), "# Reference\n");

    const reg = new ContributionRegistry();
    reg.registerSkill("test", dir, "bundled", skillDir);

    const catalog = await loadSkillCatalog(reg);
    const skill = catalog.get("bundled")!;
    expect(skill.files.map((f) => f.path)).toEqual([
      "/skills/bundled/SKILL.md",
      "/skills/bundled/reference.md",
    ]);
  });

  it("loads declared tools and their HITL policy from skill frontmatter", async () => {
    const dir = await mkdtemp(join(tmpdir(), "skill-cat-"));
    const skillDir = join(dir, "mailer");
    await mkdir(skillDir, { recursive: true });
    await writeFile(
      join(skillDir, "SKILL.md"),
      [
        "---",
        "name: Mailer",
        "description: Sends reviewed mail.",
        "tools:",
        "  - mcp:outlook:send_email",
        "interruptOn:",
        "  mcp:outlook:send_email:",
        "    allowedDecisions:",
        "      - approve",
        "      - edit",
        "      - reject",
        "---",
        "",
        "# Mailer",
        "",
      ].join("\n"),
    );

    const reg = new ContributionRegistry();
    reg.registerSkill("test", dir, "mailer", skillDir);

    const skill = (await loadSkillCatalog(reg)).get("mailer")!;
    expect(skill.declaredTools).toEqual(["mcp:outlook:send_email"]);
    expect(skill.interruptOn).toEqual({
      "mcp:outlook:send_email": {
        allowedDecisions: ["approve", "edit", "reject"],
      },
    });
  });

  it("recursively preserves scripts, references, and assets relative paths", async () => {
    const dir = await mkdtemp(join(tmpdir(), "skill-cat-"));
    const skillDir = join(dir, "recursive");
    await mkdir(join(skillDir, "scripts"), { recursive: true });
    await mkdir(join(skillDir, "references", "api"), { recursive: true });
    await mkdir(join(skillDir, "assets"), { recursive: true });
    await writeFile(join(skillDir, "SKILL.md"), "---\nname: recursive\ndescription: Uses bundled resources.\n---\n");
    await writeFile(join(skillDir, "scripts", "run.ts"), "export {};\n");
    await writeFile(join(skillDir, "references", "api", "contract.md"), "# Contract\n");
    await writeFile(join(skillDir, "assets", "template.txt"), "template\n");

    const reg = new ContributionRegistry();
    reg.registerSkill("test", dir, "recursive", skillDir);

    const files = (await loadSkillCatalog(reg)).get("recursive")!.files;
    expect(files.map((file) => file.path)).toEqual([
      "/skills/recursive/SKILL.md",
      "/skills/recursive/assets/template.txt",
      "/skills/recursive/references/api/contract.md",
      "/skills/recursive/scripts/run.ts",
    ]);
  });

  it("preserves binary assets as FileDataV2 bytes with MIME metadata", async () => {
    const dir = await mkdtemp(join(tmpdir(), "skill-cat-"));
    const skillDir = join(dir, "visual");
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    await mkdir(join(skillDir, "assets"), { recursive: true });
    await writeFile(
      join(skillDir, "SKILL.md"),
      "---\nname: visual\ndescription: Uses a bundled image.\n---\n",
    );
    await writeFile(join(skillDir, "assets", "sample.png"), png);

    const reg = new ContributionRegistry();
    reg.registerSkill("test", dir, "visual", skillDir);

    const file = (await loadSkillCatalog(reg))
      .get("visual")!
      .files.find((candidate) => candidate.path.endsWith("/assets/sample.png"))!;
    expect(file.mimeType).toBe("image/png");
    expect(file.content).toEqual(png);
  });

  it("preserves invalid UTF-8 with an unknown extension as opaque bytes", async () => {
    const dir = await mkdtemp(join(tmpdir(), "skill-cat-"));
    const skillDir = join(dir, "opaque");
    const bytes = new Uint8Array([0xff, 0x00, 0x80]);
    await mkdir(join(skillDir, "assets"), { recursive: true });
    await writeFile(
      join(skillDir, "SKILL.md"),
      "---\nname: opaque\ndescription: Uses opaque data.\n---\n",
    );
    await writeFile(join(skillDir, "assets", "payload.custom"), bytes);

    const reg = new ContributionRegistry();
    reg.registerSkill("test", dir, "opaque", skillDir);

    const file = (await loadSkillCatalog(reg))
      .get("opaque")!
      .files.find((candidate) => candidate.path.endsWith("/assets/payload.custom"))!;
    expect(file.mimeType).toBe("application/octet-stream");
    expect(file.content).toEqual(bytes);
  });

  // Creating a symlink needs elevated privilege on Windows (EPERM otherwise).
  it.skipIf(process.platform === "win32")("does not follow nested file or directory symlinks", async () => {
    const dir = await mkdtemp(join(tmpdir(), "skill-cat-"));
    const skillDir = join(dir, "contained");
    const outside = await mkdtemp(join(tmpdir(), "skill-outside-"));
    await mkdir(skillDir, { recursive: true });
    await writeFile(join(skillDir, "SKILL.md"), "---\nname: contained\ndescription: Safe bundle.\n---\n");
    await writeFile(join(outside, "secret.txt"), "outside\n");
    await symlink(join(outside, "secret.txt"), join(skillDir, "file-link.txt"));
    await symlink(outside, join(skillDir, "directory-link"));

    const reg = new ContributionRegistry();
    reg.registerSkill("test", dir, "contained", skillDir);

    expect((await loadSkillCatalog(reg)).get("contained")!.files.map((file) => file.path))
      .toEqual(["/skills/contained/SKILL.md"]);
  });
});

async function seedUserSkills(
  skills: Array<{ id: string; frontmatter: string; body?: string; siblings?: Record<string, string> }>,
): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "user-skills-test-"));
  for (const s of skills) {
    await mkdir(join(root, s.id), { recursive: true });
    await writeFile(join(root, s.id, "SKILL.md"), `---\n${s.frontmatter}\n---\n${s.body ?? ""}`);
    for (const [name, content] of Object.entries(s.siblings ?? {})) {
      const destination = join(root, s.id, name);
      await mkdir(dirname(destination), { recursive: true });
      await writeFile(destination, content);
    }
  }
  return root;
}

describe("loadUserSkills", () => {
  it("loads a skills/<id>/SKILL.md bundle as a source:user entry", async () => {
    const dir = await seedUserSkills([
      {
        id: "recipe",
        frontmatter:
          "name: recipe\ndescription: makes recipes\nmetadata:\n  display-name: Recipe",
        body: "# Steps\n1. cook\n",
      },
    ]);
    const recipe = (await loadUserSkills(dir)).get("recipe");
    expect(recipe?.source).toBe("user");
    expect(recipe?.name).toBe("Recipe");
    expect(recipe?.description).toBe("makes recipes");
    expect(recipe?.files[0]?.path).toBe("/skills/recipe/SKILL.md");
  });

  it("includes sibling files (progressive disclosure), SKILL.md first", async () => {
    const dir = await seedUserSkills([
      { id: "r", frontmatter: "name: R\ndescription: d", siblings: { "reference.md": "ref" } },
    ]);
    const files = (await loadUserSkills(dir)).get("r")!.files;
    expect(files.map((f) => f.path)).toEqual(["/skills/r/SKILL.md", "/skills/r/reference.md"]);
  });

  it("loads nested user skill resources without flattening them", async () => {
    const dir = await seedUserSkills([
      {
        id: "nested",
        frontmatter: "name: Nested\ndescription: d",
        siblings: {
          "scripts/check.sh": "exit 0\n",
          "references/details.md": "details\n",
        },
      },
    ]);
    expect((await loadUserSkills(dir)).get("nested")!.files.map((file) => file.path)).toEqual([
      "/skills/nested/SKILL.md",
      "/skills/nested/references/details.md",
      "/skills/nested/scripts/check.sh",
    ]);
  });

  it("skips a skill with no description, logging it", async () => {
    const dir = await seedUserSkills([{ id: "nodesc", frontmatter: "name: NoDesc" }]);
    const logs: string[] = [];
    const catalog = await loadUserSkills(dir, (m) => logs.push(m));
    expect(catalog.has("nodesc")).toBe(false);
    expect(logs.some((l) => l.includes("nodesc"))).toBe(true);
  });

  it("falls back to the directory basename when name is absent", async () => {
    const dir = await seedUserSkills([{ id: "unnamed", frontmatter: "description: has no name" }]);
    expect((await loadUserSkills(dir)).get("unnamed")?.name).toBe("unnamed");
  });

  it("returns an empty catalog for a missing directory", async () => {
    expect((await loadUserSkills(join(tmpdir(), "definitely-not-here-xyz"))).size).toBe(0);
  });

  it("parses frontmatter `tools:` into declaredTools", async () => {
    const dir = await mkdtemp(join(tmpdir(), "skill-cat-"));
    const skillDir = join(dir, "mailer");
    await mkdir(skillDir, { recursive: true });
    await writeFile(
      join(skillDir, "SKILL.md"),
      "---\nname: mailer\ndescription: Send mail.\ntools:\n  - mcp:outlook:send_email\n  - mcp:cal:create_event\n---\n# Mailer\n",
    );

    const catalog = await loadUserSkills(dir);
    expect(catalog.get("mailer")?.declaredTools).toEqual([
      "mcp:outlook:send_email",
      "mcp:cal:create_event",
    ]);
  });

  it("skips a skill using the reserved top-level agent id, logging why", async () => {
    const dir = await seedUserSkills([
      { id: "pizza-bot", frontmatter: "name: pizza-bot\ndescription: Tries to shadow the orchestrator." },
    ]);
    const logs: string[] = [];
    const catalog = await loadUserSkills(dir, (m) => logs.push(m));
    expect(catalog.has("pizza-bot")).toBe(false);
    expect(logs.some((l) => l.includes("pizza-bot") && l.includes("reserved"))).toBe(true);
  });

  it("defaults declaredTools to [] when no tools/mcp key is present", async () => {
    const dir = await mkdtemp(join(tmpdir(), "skill-cat-"));
    const skillDir = join(dir, "plain");
    await mkdir(skillDir, { recursive: true });
    await writeFile(join(skillDir, "SKILL.md"), "---\nname: plain\ndescription: Plain skill.\n---\n# Plain\n");

    const catalog = await loadUserSkills(dir);
    expect(catalog.get("plain")?.declaredTools).toEqual([]);
  });
});

describe("loadBuiltinSkills", () => {
  it("loads a skills directory with builtin provenance", async () => {
    const dir = await seedUserSkills([
      { id: "research", frontmatter: "name: Research\ndescription: Finds sources." },
    ]);

    expect((await loadBuiltinSkills(dir)).get("research")?.source).toBe("builtin");
  });

  it("loads the bundled Pizza Bot Guide and its references", async () => {
    const guide = (await loadBuiltinSkills(BUILTIN_SKILLS_DIR)).get("pizza-bot-guide");

    expect(guide).toMatchObject({
      name: "Pizza Bot Guide",
      source: "builtin",
      declaredTools: [],
    });
    expect(guide?.files.map((file) => file.path)).toEqual(
      expect.arrayContaining([
        "/skills/pizza-bot-guide/SKILL.md",
        "/skills/pizza-bot-guide/references/project.md",
        "/skills/pizza-bot-guide/references/workflows.md",
      ]),
    );
  });
});

describe("mergeSkillCatalogs", () => {
  const entry = (id: string, source: SkillCatalogEntry["source"]): SkillCatalogEntry =>
    source === "plugin"
      ? { id, name: id, description: "d", source, pluginName: "p", files: [], declaredTools: [], interruptOn: {} }
      : { id, name: id, description: "d", source, files: [], declaredTools: [], interruptOn: {} };

  it("unions plugin + user skills", () => {
    const plugin: SkillCatalog = new Map([["a", entry("a", "plugin")]]);
    const user: SkillCatalog = new Map([["b", entry("b", "user")]]);
    expect([...mergeSkillCatalogs(plugin, user).keys()].sort()).toEqual(["a", "b"]);
  });

  it("USER wins on an id collision, and logs it", () => {
    const plugin: SkillCatalog = new Map([["x", entry("x", "plugin")]]);
    const user: SkillCatalog = new Map([["x", entry("x", "user")]]);
    const logs: string[] = [];
    const merged = mergeSkillCatalogs(plugin, user, (m) => logs.push(m));
    expect(merged.get("x")?.source).toBe("user");
    expect(merged.get("x")?.overrides).toBe("plugin");
    expect(logs.some((l) => l.includes("x") && l.toLowerCase().includes("override"))).toBe(true);
  });

  it("does not mutate its inputs", () => {
    const plugin: SkillCatalog = new Map([["a", entry("a", "plugin")]]);
    const user: SkillCatalog = new Map([["a", entry("a", "user")]]);
    mergeSkillCatalogs(plugin, user);
    expect(plugin.get("a")?.source).toBe("plugin");
    expect(user.get("a")?.overrides).toBeUndefined();
  });

  it("records built-in provenance on a user override", () => {
    const builtin: SkillCatalog = new Map([["x", entry("x", "builtin")]]);
    const user: SkillCatalog = new Map([["x", entry("x", "user")]]);
    expect(mergeSkillCatalogs(builtin, user).get("x")?.overrides).toBe("builtin");
  });
});
