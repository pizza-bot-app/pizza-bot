import { describe, it, expect } from "vitest";
import {
  collectSkillFiles,
  collectSkillPaths,
  composeSkillMd,
  splitSkillMd,
  skillInfoOf,
  skillMcpServerIds,
  parseDeclaredTools,
  parseSkillInterruptOn,
  SKILLS_ROOT,
  toolRefSchema,
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
    declaredTools: [],
    interruptOn: {},
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

describe("skillMcpServerIds", () => {
  it("deduplicates exact and wildcard references by server", () => {
    expect(
      skillMcpServerIds({
        declaredTools: [
          "mcp:mail:send",
          "mcp:mail:*",
          "builtin:eval",
          "mcp:calendar:list",
        ],
      }),
    ).toEqual(["mail", "calendar"]);
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
      [],
      {},
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

  it("emits tool grants as a space-separated metadata string", () => {
    const md = composeSkillMd("n", "d", "# body", [
      "mcp:mcp-status:get_mcp_status",
      "builtin:eval",
    ]);
    expect(md).toBe(
      '---\nname: "n"\ndescription: "d"\nmetadata:\n' +
        '  pizza-bot-tools: "mcp:mcp-status:get_mcp_status builtin:eval"\n---\n\n# body\n',
    );
  });

  it("omits metadata when there is no display name, tool, or policy", () => {
    expect(composeSkillMd("n", "d", "x")).not.toContain("metadata:");
  });

  it("emits HITL policy under metadata, never as top-level fields", () => {
    const md = composeSkillMd(
      "mailer",
      "Sends mail",
      "# Mail",
      ["mcp:outlook:send_email", "mcp:outlook:delete_email", "mcp:outlook:archive"],
      {
        "mcp:outlook:send_email": { allowedDecisions: ["approve", "edit", "reject"] },
        "mcp:outlook:delete_email": { allowedDecisions: ["approve", "reject"] },
        "mcp:outlook:archive": true,
        "mcp:outlook:read": false,
      },
      "Mailer",
    );
    expect(md).toBe(
      '---\nname: "mailer"\ndescription: "Sends mail"\nmetadata:\n' +
        '  display-name: "Mailer"\n' +
        '  pizza-bot-tools: "mcp:outlook:send_email mcp:outlook:delete_email mcp:outlook:archive"\n' +
        '  pizza-bot-interrupt-on: "mcp:outlook:send_email mcp:outlook:delete_email=approve,reject ' +
        'mcp:outlook:archive=approve,edit,reject,respond"\n---\n\n# Mail\n',
    );
    expect(md).not.toMatch(/^(tools|mcp|interruptOn):/m);
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
      declaredTools: [],
      interruptOn: {},
    });
    expect(info).not.toHaveProperty("files");
  });

  it("preserves shipped provenance for user overrides", () => {
    expect(skillInfoOf({ ...entry("customized", []), source: "user", overrides: "builtin" }))
      .toMatchObject({ source: "user", overrides: "builtin" });
  });
});

describe("toolRefSchema", () => {
  it("rejects refs containing whitespace", () => {
    expect(toolRefSchema.safeParse("mcp:srv:tool").success).toBe(true);
    expect(toolRefSchema.safeParse("mcp:srv:search_*").success).toBe(true);
    for (const ref of ["mcp:srv:my tool", "mcp:my srv:tool", "mcp:srv:tool\t", "builtin:eval "]) {
      expect(toolRefSchema.safeParse(ref).success).toBe(false);
    }
  });
});

describe("parseDeclaredTools", () => {
  it("keeps a list-form ref containing whitespace so readiness can reject it", () => {
    expect(parseDeclaredTools({ tools: ["mcp:srv:my tool"] })).toEqual(["mcp:srv:my tool"]);
  });

  it("reads space-separated refs from metadata.pizza-bot-tools", () => {
    expect(
      parseDeclaredTools({
        metadata: { "pizza-bot-tools": "mcp:outlook:send_email  mcp:cal:create_event" },
      }),
    ).toEqual(["mcp:outlook:send_email", "mcp:cal:create_event"]);
  });

  it("prefers metadata over legacy top-level tools", () => {
    expect(
      parseDeclaredTools({
        metadata: { "pizza-bot-tools": "mcp:a:x" },
        tools: ["mcp:legacy:y"],
      }),
    ).toEqual(["mcp:a:x"]);
  });

  it("reads a legacy top-level `tools:` list of refs", () => {
    expect(parseDeclaredTools({ tools: ["mcp:outlook:send_email", "mcp:cal:create_event"] })).toEqual([
      "mcp:outlook:send_email",
      "mcp:cal:create_event",
    ]);
  });

  it("splits a comma/whitespace `tools:` string and dedupes", () => {
    expect(parseDeclaredTools({ tools: "a, b  a" })).toEqual(["a", "b"]);
  });

  it("falls back to `mcp:` and ignores non-string entries", () => {
    expect(parseDeclaredTools({ mcp: ["x", 3, null, "y"] as unknown[] })).toEqual(["x", "y"]);
  });

  it("returns [] when no key is present or the value is unusable", () => {
    expect(parseDeclaredTools({})).toEqual([]);
    expect(parseDeclaredTools({ tools: 42 })).toEqual([]);
    expect(parseDeclaredTools({ metadata: "x" })).toEqual([]);
  });

  it("translates a space-separated allowed-tools string", () => {
    expect(
      parseDeclaredTools({
        "allowed-tools": "mcp__outlook__send_email mcp__srv__tool__x Bash(git add:*) Read",
      }),
    ).toEqual(["mcp:outlook:send_email", "mcp:srv:tool__x", "Bash(git add:*)", "Read"]);
  });

  it("translates comma-separated and list allowed-tools, keeping unknown entries verbatim", () => {
    expect(parseDeclaredTools({ "allowed-tools": "Read, mcp__cal__list_events" })).toEqual([
      "Read",
      "mcp:cal:list_events",
    ]);
    expect(
      parseDeclaredTools({ "allowed-tools": ["mcp__cal__list_events", "mcp__cal", "Bash(git:*)", 7] }),
    ).toEqual(["mcp:cal:list_events", "mcp__cal", "Bash(git:*)"]);
  });

  it("unions allowed-tools into the declared tools and dedupes", () => {
    expect(
      parseDeclaredTools({
        metadata: { "pizza-bot-tools": "mcp:cal:list_events builtin:eval" },
        "allowed-tools": "mcp__cal__list_events mcp__cal__create_event",
      }),
    ).toEqual(["mcp:cal:list_events", "builtin:eval", "mcp:cal:create_event"]);
    expect(
      parseDeclaredTools({ tools: ["mcp:cal:list_events"], "allowed-tools": "mcp__cal__list_events" }),
    ).toEqual(["mcp:cal:list_events"]);
  });
});

describe("parseSkillInterruptOn", () => {
  it("reads bare metadata refs as the default approve/edit/reject decisions", () => {
    expect(
      parseSkillInterruptOn({
        metadata: { "pizza-bot-interrupt-on": "mcp:outlook:send_email mcp:cal:create_event" },
      }),
    ).toEqual({
      "mcp:outlook:send_email": { allowedDecisions: ["approve", "edit", "reject"] },
      "mcp:cal:create_event": { allowedDecisions: ["approve", "edit", "reject"] },
    });
  });

  it("narrows decisions after `=` and ignores invalid refs and decisions", () => {
    expect(
      parseSkillInterruptOn({
        metadata: {
          "pizza-bot-interrupt-on":
            "mcp:a:send=approve,reject mcp:a:del=approve,unknown,respond builtin:eval Read mcp::x",
        },
      }),
    ).toEqual({
      "mcp:a:send": { allowedDecisions: ["approve", "reject"] },
      "mcp:a:del": { allowedDecisions: ["approve", "respond"] },
    });
  });

  it("falls back to the default decisions when a valid ref has no usable decision", () => {
    expect(
      parseSkillInterruptOn({
        metadata: { "pizza-bot-interrupt-on": "mcp:a:typo=aprove mcp:a:empty= mcp:a:commas=,," },
      }),
    ).toEqual({
      "mcp:a:typo": { allowedDecisions: ["approve", "edit", "reject"] },
      "mcp:a:empty": { allowedDecisions: ["approve", "edit", "reject"] },
      "mcp:a:commas": { allowedDecisions: ["approve", "edit", "reject"] },
    });
  });

  it("ignores list-form refs containing whitespace", () => {
    expect(
      parseSkillInterruptOn({ metadata: { "pizza-bot-interrupt-on": ["mcp:a:b c", "mcp:a:ok"] } }),
    ).toEqual({ "mcp:a:ok": { allowedDecisions: ["approve", "edit", "reject"] } });
  });

  it("prefers metadata over legacy top-level interruptOn", () => {
    expect(
      parseSkillInterruptOn({
        metadata: { "pizza-bot-interrupt-on": "mcp:a:x=reject" },
        interruptOn: { "mcp:legacy:y": true },
      }),
    ).toEqual({ "mcp:a:x": { allowedDecisions: ["reject"] } });
  });

  it("reads legacy boolean and decision-list policies", () => {
    expect(
      parseSkillInterruptOn({
        interruptOn: {
          "mcp:outlook:send_email": {
            allowedDecisions: ["approve", "edit", "reject"],
          },
          "mcp:calendar:create_event": true,
        },
      }),
    ).toEqual({
      "mcp:outlook:send_email": {
        allowedDecisions: ["approve", "edit", "reject"],
      },
      "mcp:calendar:create_event": true,
    });
  });

  it("keeps approval with default decisions for malformed legacy policies", () => {
    expect(
      parseSkillInterruptOn({
        interruptOn: {
          "mcp:test:valid": { allowedDecisions: ["approve", "unknown", "reject"] },
          "mcp:test:typo": { allowedDecisions: ["aprove"] },
          "mcp:test:empty": { allowedDecisions: [] },
          "mcp:test:malformed": "yes",
          "mcp:test:off": false,
          "mcp:test:has space": true,
          "builtin:eval": true,
        },
      }),
    ).toEqual({
      "mcp:test:valid": { allowedDecisions: ["approve", "reject"] },
      "mcp:test:typo": { allowedDecisions: ["approve", "edit", "reject"] },
      "mcp:test:empty": { allowedDecisions: ["approve", "edit", "reject"] },
      "mcp:test:malformed": { allowedDecisions: ["approve", "edit", "reject"] },
      "mcp:test:off": false,
    });
  });
});
