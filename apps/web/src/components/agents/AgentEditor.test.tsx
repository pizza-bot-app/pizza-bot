import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { AppToastProvider } from "../AppToast.js";
import { HotkeyProvider } from "../../hotkeys/index.js";
import { AgentEditor } from "./AgentEditor.js";

const MODELS = {
  models: [{ id: "anthropic:claude-haiku-4-5", displayName: "Claude Haiku 4.5", provider: "anthropic" }],
};

describe("AgentEditor", () => {
  it("labels each granted tool with its source and a pattern with its match count", () => {
    const html = renderToStaticMarkup(
      <HotkeyProvider>
      <AppToastProvider>
        <AgentEditor
          agent={{
            id: "files",
            name: "Files",
            description: "Reads files.",
            systemPrompt: "Read files.",
            skills: [],
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
          models={{ models: [] }}
          skills={{ skills: [] }}
          onSave={vi.fn()}
          onGenerate={vi.fn()}
          onCancel={vi.fn()}
        />
      </AppToastProvider>
      </HotkeyProvider>,
    );

    expect(html).toMatch(/<code>eval<\/code><span class="tool-source">Built-in<\/span>/);
    expect(html).toMatch(/<code>read_file<\/code><span class="tool-source">fs<\/span>/);
    expect(html).toMatch(/<code>list_\*<\/code><span class="tool-source">fs<\/span><span class="tool-chip-count">2 tools<\/span>/);
    expect(html).toContain('aria-label="Ask first before running mcp:fs:read_file"');
    expect(html).not.toContain(">Approval<");
  });

  it("locks Ask first on for a tool an asking wildcard already covers", () => {
    const html = renderToStaticMarkup(
      <HotkeyProvider>
      <AppToastProvider>
        <AgentEditor
          agent={{
            id: "files",
            name: "Files",
            description: "Reads files.",
            systemPrompt: "Read files.",
            skills: [],
            source: "user",
            declaredTools: ["mcp:fs:*", "mcp:fs:read_file"],
            interruptOn: { "mcp:fs:*": true },
          }}
          tools={{
            builtins: [],
            servers: [{ server: "fs", wildcard: "mcp:fs:*", tools: [{ ref: "mcp:fs:read_file", name: "read_file" }] }],
          }}
          models={{ models: [] }}
          skills={{ skills: [] }}
          onSave={vi.fn()}
          onGenerate={vi.fn()}
          onCancel={vi.fn()}
        />
      </AppToastProvider>
      </HotkeyProvider>,
    );

    expect(html).toMatch(/aria-label="Ask first before running mcp:fs:\*" checked=""\/>/);
    expect(html).toMatch(
      /aria-label="Ask first before running mcp:fs:read_file, on because mcp:fs:\* asks first" disabled="" checked=""\/>/,
    );
    expect(html).toContain('title="Asks first via mcp:fs:*"');
  });

  it("defaults the model to the conversation's and names a pinned model it cannot list", () => {
    const base = {
      id: "planner",
      name: "Planner",
      description: "Plans.",
      systemPrompt: "",
      declaredTools: [],
      skills: [],
      interruptOn: {},
      source: "user" as const,
    };
    const inherit = renderToStaticMarkup(
      <HotkeyProvider>
      <AppToastProvider>
        <AgentEditor agent={base} tools={{ builtins: [], servers: [] }} models={MODELS} skills={{ skills: [] }}
          onSave={vi.fn()} onGenerate={vi.fn()} onCancel={vi.fn()} />
      </AppToastProvider>
      </HotkeyProvider>,
    );
    expect(inherit).toContain("Inherit conversation model");

    const pinned = renderToStaticMarkup(
      <HotkeyProvider>
      <AppToastProvider>
        <AgentEditor agent={{ ...base, model: "anthropic:claude-haiku-4-5" }} tools={{ builtins: [], servers: [] }}
          models={MODELS} skills={{ skills: [] }} onSave={vi.fn()} onGenerate={vi.fn()} onCancel={vi.fn()} />
      </AppToastProvider>
      </HotkeyProvider>,
    );
    expect(pinned).toContain("Claude Haiku 4.5");

    const missing = renderToStaticMarkup(
      <HotkeyProvider>
      <AppToastProvider>
        <AgentEditor agent={{ ...base, model: "nope:gone" }} tools={{ builtins: [], servers: [] }}
          models={MODELS} skills={{ skills: [] }} onSave={vi.fn()} onGenerate={vi.fn()} onCancel={vi.fn()} />
      </AppToastProvider>
      </HotkeyProvider>,
    );
    expect(missing).toContain("nope:gone (currently unavailable)");
  });

  it("shows mounted skills by name and offers only the unmounted ones", () => {
    const html = renderToStaticMarkup(
      <HotkeyProvider>
      <AppToastProvider>
        <AgentEditor
          agent={{
            id: "planner",
            name: "Planner",
            description: "Plans.",
            systemPrompt: "",
            declaredTools: [],
            skills: ["calendar"],
            interruptOn: {},
            source: "user",
          }}
          tools={{ builtins: [], servers: [] }}
          models={MODELS}
          skills={{
            skills: [
              { id: "calendar", name: "Calendar", description: "d", source: "plugin", enabled: true },
              { id: "email", name: "Email", description: "d", source: "plugin", enabled: true },
            ],
          }}
          onSave={vi.fn()}
          onGenerate={vi.fn()}
          onCancel={vi.fn()}
        />
      </AppToastProvider>
      </HotkeyProvider>,
    );

    expect(html).toContain('aria-label="Remove skill calendar"');
    expect(html).toMatch(/<option value="email">Email<\/option>/);
    expect(html).not.toMatch(/<option value="calendar">/);
  });
});
