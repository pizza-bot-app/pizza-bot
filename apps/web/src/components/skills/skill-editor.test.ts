import { describe, expect, it } from "vitest";
import { prepareSkillFiles } from "./skill-editor-files.js";

describe("SkillEditor file preparation", () => {
  it("preserves binary transport metadata while trimming paths", () => {
    expect(
      prepareSkillFiles([
        {
          path: "  assets/payload.custom  ",
          content: "/wCA",
          encoding: "base64",
          mimeType: "application/octet-stream",
        },
        { path: "   ", content: "ignored" },
      ]),
    ).toEqual([
      {
        path: "assets/payload.custom",
        content: "/wCA",
        encoding: "base64",
        mimeType: "application/octet-stream",
      },
    ]);
  });
});
