import { describe, expect, it } from "vitest";
import {
  SkillImportError,
  parseSkillArchive,
} from "./skill-import.js";
import { storedZip as zip } from "./test-utils/stored-zip.js";

describe("parseSkillArchive", () => {
  it("imports a spec-shaped skill directory and preserves every file", async () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const archive = zip([
      {
        path: "review-change/SKILL.md",
        content: [
          "---",
          "name: review-change",
          "description: Review a code change and report actionable findings.",
          "license: Apache-2.0",
          "---",
          "",
          "# Review change",
          "",
          "Inspect the diff and report findings.",
          "",
        ].join("\n"),
      },
      { path: "review-change/references/checklist.md", content: "# Checklist\n" },
      { path: "review-change/assets/icon.png", content: png },
    ]);

    const skill = await parseSkillArchive(archive);

    expect(skill).toMatchObject({
      id: "review-change",
      name: "review-change",
      description: "Review a code change and report actionable findings.",
      body: "# Review change\n\nInspect the diff and report findings.\n",
    });
    expect(skill.files.map((file) => file.path)).toEqual([
      "SKILL.md",
      "assets/icon.png",
      "references/checklist.md",
    ]);
    expect(skill.files[0]!.content).toEqual(
      new TextEncoder().encode([
        "---",
        "name: review-change",
        "description: Review a code change and report actionable findings.",
        "license: Apache-2.0",
        "---",
        "",
        "# Review change",
        "",
        "Inspect the diff and report findings.",
        "",
      ].join("\n")),
    );
    expect(skill.files[1]!.content).toEqual(png);
  });

  it("accepts SKILL.md at archive root and uses its name as the custom skill id", async () => {
    const skill = await parseSkillArchive(zip([
      {
        path: "SKILL.md",
        content: "---\nname: root-skill\ndescription: A root skill.\n---\n\n# Instructions\n",
      },
    ]));

    expect(skill.id).toBe("root-skill");
  });

  it.each([
    {
      label: "missing SKILL.md",
      files: [{ path: "review-change/reference.md", content: "none" }],
      code: "invalid_bundle",
    },
    {
      label: "directory mismatch",
      files: [{
        path: "wrong/SKILL.md",
        content: "---\nname: review-change\ndescription: Reviews changes.\n---\n\n# Review\n",
      }],
      code: "name_mismatch",
    },
    {
      label: "non-spec name",
      files: [{
        path: "SKILL.md",
        content: "---\nname: Review_Change\ndescription: Reviews changes.\n---\n\n# Review\n",
      }],
      code: "invalid_skill_name",
    },
    {
      label: "empty instructions",
      files: [{
        path: "review-change/SKILL.md",
        content: "---\nname: review-change\ndescription: Reviews changes.\n---\n",
      }],
      code: "invalid_skill_md",
    },
  ])("rejects $label", async ({ files, code }) => {
    await expect(parseSkillArchive(zip(files))).rejects.toMatchObject({ code });
  });

  it("rejects traversal entries before reading their content", async () => {
    await expect(parseSkillArchive(zip([
      { path: "../SKILL.md", content: "unsafe" },
    ]))).rejects.toMatchObject({ code: "unsafe_path" });
  });

  it("rejects control characters in skill paths", async () => {
    await expect(parseSkillArchive(zip([
      {
        path: "review-\tchange/SKILL.md",
        content: "---\nname: review-change\ndescription: Reviews changes.\n---\n\n# Review\n",
      },
    ]))).rejects.toMatchObject({ code: "unsafe_path" });
  });

  it("rejects case-insensitive duplicate file paths", async () => {
    await expect(parseSkillArchive(zip([
      {
        path: "review-change/SKILL.md",
        content: "---\nname: review-change\ndescription: Reviews changes.\n---\n\n# Review\n",
      },
      { path: "review-change/Notes.md", content: "one" },
      { path: "review-change/notes.md", content: "two" },
    ]))).rejects.toMatchObject({ code: "duplicate_entry" });
  });

  it("rejects inconsistent ZIP size metadata as a malformed archive", async () => {
    const archive = zip([
      {
        path: "SKILL.md",
        content: "---\nname: review-change\ndescription: Reviews changes.\n---\n\n# Review\n",
        declaredSize: 1024,
      },
    ]);

    await expect(parseSkillArchive(archive)).rejects.toBeInstanceOf(SkillImportError);
    await expect(parseSkillArchive(archive)).rejects.toMatchObject({ code: "invalid_archive" });
  });
});
