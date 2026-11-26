import { describe, expect, it } from "vitest";
import { Command } from "@langchain/langgraph";
import { SKILLS_ROOT, type SkillCatalog } from "@pizza-bot/core";
import type { BackendProtocolV2 } from "deepagents";
import { buildBackend } from "./backend.js";
import { withSkillReload } from "./index.js";

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
        {
          path: `${SKILLS_ROOT}/health-report/SKILL.md`,
          content: "---\nname: health-report\ndescription: Produce a health report.\n---\n\nReport.",
        },
        {
          path: `${SKILLS_ROOT}/health-report/assets/icon.png`,
          content: new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
          mimeType: "image/png",
        },
      ],
    },
  ],
]);

function backend(): BackendProtocolV2 {
  return buildBackend({ skills: catalog }) as BackendProtocolV2;
}

describe("read-only /skills/ backend", () => {
  it("serves every catalog file beneath /skills/", async () => {
    const listing = await backend().ls("/skills/health-report/");
    expect(listing.files?.map((file) => file.path).sort()).toEqual([
      "/skills/health-report/SKILL.md",
      "/skills/health-report/assets/",
    ]);
    const read = await backend().read("/skills/health-report/SKILL.md");
    expect(read.content).toContain("Report.");
    const raw = await backend().readRaw("/skills/health-report/assets/icon.png");
    expect(raw.data?.content).toEqual(new Uint8Array([0x89, 0x50, 0x4e, 0x47]));
  });

  it("refuses every mutation and never emits a state update", async () => {
    const write = await backend().write("/skills/health-report/new.md", "x");
    expect(write).toEqual({ error: "Skills are read-only." });
    expect(write).not.toHaveProperty("filesUpdate");
    const edit = await backend().edit("/skills/health-report/SKILL.md", "Report.", "Other.");
    expect(edit).toEqual({ error: "Skills are read-only." });
    const uploads = await backend().uploadFiles!([["/skills/health-report/x.bin", new Uint8Array([1])]]);
    expect(uploads).toEqual([{ path: "/skills/health-report/x.bin", error: "permission_denied" }]);
  });
});

describe("withSkillReload", () => {
  it("clears loaded skill metadata on a message turn so edits reach the thread", () => {
    expect(withSkillReload({ messages: [{ role: "user", content: "hi" }] }, true)).toEqual({
      messages: [{ role: "user", content: "hi" }],
      skillsMetadata: null,
    });
  });

  it("leaves input untouched when the graph mounts no root skills", () => {
    const input = { messages: [] };
    expect(withSkillReload(input, false)).toBe(input);
  });

  it("leaves a resume input untouched", () => {
    const cmd = new Command({ resume: { decisions: [] } });
    expect(withSkillReload(cmd, true)).toBe(cmd);
  });
});
