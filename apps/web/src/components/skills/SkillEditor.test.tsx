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

  it("labels each granted tool with its source and a pattern with its match count", () => {
    const html = renderToStaticMarkup(
      <AppToastProvider>
        <SkillEditor
          skill={{
            id: "files",
            name: "Files",
            description: "Reads files.",
            body: "Read files.",
            files: [],
            source: "user",
            declaredTools: ["builtin:eval", "mcp:fs:read_file", "mcp:fs:list_*"],
            interruptOn: {},
          }}
          tools={{
            builtins: [{ ref: "builtin:eval", name: "eval" }],
            servers: [
              {
                server: "fs",
                wildcard: "mcp:fs:*",
                tools: ["read_file", "list_directory", "list_allowed_directories"].map((name) => ({
                  ref: `mcp:fs:${name}`,
                  name,
                })),
              },
            ],
          }}
          onSave={vi.fn()}
          onGenerate={vi.fn()}
          onCancel={vi.fn()}
        />
      </AppToastProvider>,
    );

    expect(html).toMatch(/<code>eval<\/code><span class="tool-source">Built-in<\/span>/);
    expect(html).toMatch(/<code>read_file<\/code><span class="tool-source">fs<\/span>/);
    expect(html).toMatch(/<code>list_\*<\/code><span class="tool-source">fs<\/span><span class="tool-chip-count">2 tools<\/span>/);
    expect(html).toContain('aria-label="Ask first before running mcp:fs:read_file"');
    expect(html).not.toContain(">Approval<");
  });

  it("locks Ask first on for a tool an asking wildcard already covers", () => {
    const html = renderToStaticMarkup(
      <AppToastProvider>
        <SkillEditor
          skill={{
            id: "files",
            name: "Files",
            description: "Reads files.",
            body: "Read files.",
            files: [],
            source: "user",
            declaredTools: ["mcp:fs:*", "mcp:fs:read_file"],
            interruptOn: { "mcp:fs:*": true },
          }}
          tools={{
            builtins: [],
            servers: [{ server: "fs", wildcard: "mcp:fs:*", tools: [{ ref: "mcp:fs:read_file", name: "read_file" }] }],
          }}
          onSave={vi.fn()}
          onGenerate={vi.fn()}
          onCancel={vi.fn()}
        />
      </AppToastProvider>,
    );

    expect(html).toMatch(/aria-label="Ask first before running mcp:fs:\*" checked=""\/>/);
    expect(html).toMatch(/aria-label="Ask first before running mcp:fs:read_file" disabled="" checked=""\/>/);
    expect(html).toContain('title="Asks first via mcp:fs:*"');
  });
});

