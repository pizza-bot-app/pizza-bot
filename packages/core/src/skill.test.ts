import { describe, it, expect } from "vitest";
import {
  collectSkillFiles,
  collectSkillPaths,
  composeSkillMd,
  splitSkillMd,
  skillInfoOf,
  SKILLS_ROOT,
  type SkillCatalog,
  type SkillCatalogEntry,
} from "./skill.js";

function entry(id: string, files: string[]): SkillCatalogEntry {
  return {
    id,
    name: id,
    description: `${id} description`,
    source: "plugin",
    pluginName: "demo",
    files: files.map((rel) => ({ path: `${SKILLS_ROOT}/${id}/${rel}`, content: [`# ${rel}`] })),
  };
}

const catalog: SkillCatalog = new Map([
  ["alpha", entry("alpha", ["SKILL.md", "reference.md"])],
  ["beta", entry("beta", ["SKILL.md"])],
]);

describe("collectSkillFiles", () => {
  it("returns every file of each equipped skill, keyed by backend path", () => {
    const out = collectSkillFiles(["alpha"], catalog);
    expect(Object.keys(out).sort()).toEqual([
      "/skills/alpha/SKILL.md",
      "/skills/alpha/reference.md",
    ]);
    expect(out["/skills/alpha/SKILL.md"]).toEqual({
      content: "# SKILL.md",
      mimeType: "text/plain",
    });
  });

  it("preserves V2 binary content and MIME metadata", () => {
    const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
    const binaryCatalog: SkillCatalog = new Map([
      [
        "visual",
        {
          id: "visual",
          name: "visual",
          description: "Uses an image.",
          source: "user",
          declaredTools: [],
          interruptOn: {},
          files: [
            {
              path: `${SKILLS_ROOT}/visual/assets/example.png`,
              content: bytes,
              mimeType: "image/png",
            },
          ],
        },
      ],
    ]);

    const file = collectSkillFiles(["visual"], binaryCatalog)[
      "/skills/visual/assets/example.png"
    ]!;
    expect(file.mimeType).toBe("image/png");
    expect(file.content).toEqual(bytes);
    expect(file.content).not.toBe(bytes);
  });

  it("merges multiple equipped skills", () => {
    const out = collectSkillFiles(["alpha", "beta"], catalog);
    expect(Object.keys(out)).toContain("/skills/beta/SKILL.md");
    expect(Object.keys(out)).toHaveLength(3);
  });

  it("drops ids with no catalog match (resolve-or-drop, like tool refs)", () => {
    const out = collectSkillFiles(["alpha", "does-not-exist"], catalog);
    expect(Object.keys(out)).toEqual(["/skills/alpha/SKILL.md", "/skills/alpha/reference.md"]);
  });

  it("dedupes repeated ids", () => {
    const out = collectSkillFiles(["beta", "beta"], catalog);
    expect(Object.keys(out)).toEqual(["/skills/beta/SKILL.md"]);
  });

  it("returns an empty map for no ids or no catalog", () => {
    expect(collectSkillFiles(undefined, catalog)).toEqual({});
    expect(collectSkillFiles([], catalog)).toEqual({});
    expect(collectSkillFiles(["alpha"], undefined)).toEqual({});
  });
});

describe("collectSkillPaths", () => {
  it("returns /skills/<id>/ paths for resolvable ids, deduped + sorted", () => {
    expect(collectSkillPaths(["beta", "alpha", "beta"], catalog)).toEqual([
      "/skills/alpha/",
      "/skills/beta/",
    ]);
  });

  it("drops ids with no catalog match (resolve-or-drop)", () => {
    expect(collectSkillPaths(["alpha", "nope"], catalog)).toEqual(["/skills/alpha/"]);
  });

  it("returns [] for no ids / no catalog", () => {
    expect(collectSkillPaths(undefined, catalog)).toEqual([]);
    expect(collectSkillPaths(["alpha"], undefined)).toEqual([]);
  });

  it("agrees with collectSkillFiles on which ids resolve", () => {
    const paths = collectSkillPaths(["alpha", "nope"], catalog);
    const files = collectSkillFiles(["alpha", "nope"], catalog);
    expect(Object.keys(files).every((p) => paths.some((base) => p.startsWith(base)))).toBe(true);
    expect(paths).toEqual(["/skills/alpha/"]);
  });
});

describe("splitSkillMd / composeSkillMd", () => {
  it.each(["", "\uFEFF"])("splits frontmatter from body with prefix %j", (prefix) => {
    const raw = `${prefix}---\nname: x\ndescription: does x\n---\n\n# Body\n\nstep 1\n`;
    const { frontmatter, body } = splitSkillMd(raw);
    expect(frontmatter).toBe("name: x\ndescription: does x");
    expect(body).toBe("# Body\n\nstep 1\n");
  });

  it("treats a body-only file (no frontmatter) as all body", () => {
    expect(splitSkillMd("just text").body).toBe("just text");
  });

  it("composes name+description frontmatter above the body", () => {
    const md = composeSkillMd("My Skill", "does things", "# Title\n\nstep");
    expect(md).toBe(
      '---\nname: "My Skill"\ndescription: "does things"\n---\n\n# Title\n\nstep\n',
    );
  });

  it("quotes YAML-sensitive values and preserves a separate display name", () => {
    const md = composeSkillMd(
      "web-researcher",
      "Use for web: searching and extraction.",
      "",
      "Web Researcher",
    );
    expect(md).toBe(
      '---\nname: "web-researcher"\n' +
        'description: "Use for web: searching and extraction."\n' +
        'metadata:\n  display-name: "Web Researcher"\n---\n',
    );
  });

  it("preserves body content through compose -> split (up to a trailing newline)", () => {
    const body = "# Playbook\n\n1. do a\n2. do b";
    expect(splitSkillMd(composeSkillMd("n", "d", body)).body.trimEnd()).toBe(body);
  });

  it("compose is idempotent: re-composing a split body doesn't drift", () => {
    const once = composeSkillMd("n", "d", "# Title\n\nstep\n");
    const twice = composeSkillMd("n", "d", splitSkillMd(once).body);
    expect(twice).toBe(once);
  });

  it("removes repeated leading CRLFs before composing the body", () => {
    expect(composeSkillMd("n", "d", "\r\n\r\n# Title\r\n")).toBe(
      '---\nname: "n"\ndescription: "d"\n---\n\n# Title\n',
    );
  });

  it("omits the trailing block for an empty body", () => {
    expect(composeSkillMd("n", "d", "")).toBe('---\nname: "n"\ndescription: "d"\n---\n');
  });
});

describe("skillInfoOf", () => {
  it("projects to the presentation slice, dropping file bodies", () => {
    const info = skillInfoOf(catalog.get("alpha")!);
    expect(info).toEqual({
      id: "alpha",
      name: "alpha",
      description: "alpha description",
      source: "plugin",
      pluginName: "demo",
    });
    expect(info).not.toHaveProperty("files");
  });

  it("preserves shipped provenance for user overrides", () => {
    expect(skillInfoOf({ ...entry("customized", []), source: "user", overrides: "builtin" }))
      .toMatchObject({ source: "user", overrides: "builtin" });
  });
});
