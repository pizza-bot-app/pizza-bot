import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { AppToastProvider } from "../AppToast.js";
import { McpServerEditor } from "./McpServerEditor.js";

const remote = {
  id: "remote",
  source: "user" as const,
  entry: {
    type: "http" as const,
    url: "https://example.com/mcp",
    headers: { Authorization: "Bearer secret-token" },
  },
};

function render(props: Partial<Parameters<typeof McpServerEditor>[0]> = {}): string {
  return renderToStaticMarkup(
    <AppToastProvider>
      <McpServerEditor server={remote} onSave={vi.fn()} onCancel={vi.fn()} {...props} />
    </AppToastProvider>,
  );
}

describe("McpServerEditor", () => {
  it("offers only transports supported by the server schema", () => {
    const html = render();
    expect(html).toContain('<option value="http" selected="">');
    expect(html).toContain('<option value="sse">');
    expect(html).not.toContain('value="ws"');
  });

  it("masks secret values by default with a per-row reveal toggle", () => {
    const html = render();
    expect(html).toContain('type="password"');
    expect(html).toContain('value="Bearer secret-token"');
    expect(html).toContain('aria-label="Show Authorization value"');
    expect(html).toContain('aria-pressed="false"');
  });

  it("keeps Save disabled until the draft differs from the stored entry", () => {
    const html = render();
    expect(html).toMatch(/<button[^>]*class="btn-primary"[^>]*disabled=""[^>]*>Save<\/button>/);
  });

  it("explains why the name cannot be changed on an existing server", () => {
    const html = render();
    expect(html).toContain("The ID is fixed once created");
    expect(renderToStaticMarkup(
      <AppToastProvider>
        <McpServerEditor server={null} onSave={vi.fn()} onCancel={vi.fn()} />
      </AppToastProvider>,
    )).not.toContain("The ID is fixed once created");
  });

  it("keeps destructive actions out of the form: only Cancel and Save in the footer", () => {
    const html = render();
    const footer = html.slice(html.indexOf('<footer class="resource-editor-actions"'));
    expect(footer).toContain(">Cancel</button>");
    expect(footer).toContain(">Save</button>");
    expect(footer).not.toContain("Delete");
  });
});
