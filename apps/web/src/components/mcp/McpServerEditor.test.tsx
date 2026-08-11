import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { AppToastProvider } from "../AppToast.js";
import { McpServerEditor } from "./McpServerEditor.js";

describe("McpServerEditor", () => {
  it("offers only transports supported by the server schema", () => {
    const html = renderToStaticMarkup(
      <AppToastProvider>
        <McpServerEditor
          server={{
            id: "remote",
            source: "user",
            entry: { type: "http", url: "https://example.com/mcp" },
          }}
          onSave={vi.fn()}
          onCancel={vi.fn()}
        />
      </AppToastProvider>,
    );

    expect(html).toContain('<option value="http" selected="">');
    expect(html).toContain('<option value="sse">');
    expect(html).not.toContain('value="ws"');
  });
});
