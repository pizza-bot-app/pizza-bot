import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { AppToastProvider } from "../AppToast.js";
import { SkillEditor } from "./SkillEditor.js";

describe("SkillEditor", () => {
  it("renders installation enablement for an existing custom skill", () => {
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
          enablement={<div data-testid="skill-enablement">Enabled</div>}
          onCancel={vi.fn()}
        />
      </AppToastProvider>,
    );

    expect(html).toContain('data-testid="skill-enablement"');
  });
});
