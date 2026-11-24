import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { AppToastProvider } from "../AppToast.js";
import { SkillEditor } from "./SkillEditor.js";

describe("SkillEditor", () => {
  it("explains that customizing a shipped skill saves a user copy", () => {
    const html = renderToStaticMarkup(
      <AppToastProvider>
        <SkillEditor
          skill={{
            id: "notes",
            name: "Notes",
            description: "Works with notes.",
            body: "Use the notes tools.",
            files: [],
            source: "user",
            declaredTools: [],
            interruptOn: {},
          }}
          tools={{ builtins: [], servers: [] }}
          onSave={vi.fn()}
          onGenerate={vi.fn()}
          customizing
          onCancel={vi.fn()}
        />
      </AppToastProvider>,
    );

    expect(html).toContain("Customize Notes");
    expect(html).toContain("Saving creates your own copy of this skill.");
  });
});
