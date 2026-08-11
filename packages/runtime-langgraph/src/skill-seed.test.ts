import { describe, expect, it } from "vitest";
import { Command } from "@langchain/langgraph";
import { SKILLS_ROOT, type SkillCatalog } from "@pizza-bot/core";
import { buildSkillSeed, withSkillSeed } from "./index.js";

const catalog: SkillCatalog = new Map([
  [
    "health-report",
    {
      id: "health-report",
      name: "health-report",
      description: "Produce a health report.",
      source: "plugin",
      pluginName: "mcp-status",
      files: [
        { path: `${SKILLS_ROOT}/health-report/SKILL.md`, content: ["---", "name: health-report"] },
        {
          path: `${SKILLS_ROOT}/health-report/assets/icon.png`,
          content: new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
          mimeType: "image/png",
        },
      ],
      declaredTools: [],
      interruptOn: {},
    },
  ],
  [
    "recipe",
    {
      id: "recipe",
      name: "recipe",
      description: "A recipe skill.",
      source: "user",
      files: [{ path: `${SKILLS_ROOT}/recipe/SKILL.md`, content: ["---", "name: recipe"] }],
      declaredTools: [],
      interruptOn: {},
    },
  ],
]);

describe("buildSkillSeed", () => {
  it("materializes the complete skill catalog into shared state", () => {
    const seed = buildSkillSeed({ skills: catalog });
    expect(Object.keys(seed).sort()).toEqual([
      "/skills/health-report/SKILL.md",
      "/skills/health-report/assets/icon.png",
      "/skills/recipe/SKILL.md",
    ]);
    expect(seed["/skills/health-report/SKILL.md"]!.content).toBe("---\nname: health-report");
    expect(seed["/skills/health-report/assets/icon.png"]!.content)
      .toEqual(new Uint8Array([0x89, 0x50, 0x4e, 0x47]));
    expect(typeof seed["/skills/recipe/SKILL.md"]!.created_at).toBe("string");
  });

  it("is empty when no catalog is present", () => {
    expect(buildSkillSeed({})).toEqual({});
  });
});

describe("withSkillSeed", () => {
  const seed = buildSkillSeed({ skills: catalog });

  it("attaches files to a message-turn input", () => {
    const out = withSkillSeed({ messages: [{ role: "user", content: "hi" }] }, seed) as {
      messages: unknown[];
      files: Record<string, unknown>;
    };
    expect(out.messages).toHaveLength(1);
    expect(out.files["/skills/health-report/SKILL.md"]).toBeDefined();
  });

  it("leaves a resume input untouched because state already holds the files", () => {
    const cmd = new Command({ resume: { decisions: [] } });
    expect(withSkillSeed(cmd, seed)).toBe(cmd);
  });
});
