import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { EditAction, PluginLink, ResourceView } from "./ResourceView.js";

describe("ResourceView", () => {
  it("puts the header action inside the header and renders no footer by default", () => {
    const html = renderToStaticMarkup(
      <ResourceView glyph={null} name="outlook" backLabel="MCP" headerAction={<a id="action" />}>
        <div id="body" />
      </ResourceView>,
    );
    expect(html).toMatch(/<header[^>]*>(?:(?!<\/header>)[\s\S])*id="action"[\s\S]*<\/header>/);
    expect(html).toContain('id="body"');
    expect(html).not.toContain("<footer");
  });
});

describe("EditAction", () => {
  it("labels the action Edit or Customize", () => {
    expect(renderToStaticMarkup(<EditAction onEdit={vi.fn()} />)).toMatch(/Edit<\/button>$/);
    expect(renderToStaticMarkup(<EditAction label="Customize" onEdit={vi.fn()} />)).toMatch(
      /Customize<\/button>$/,
    );
  });
});

describe("PluginLink", () => {
  it("names the plugin and links to it when navigation is available", () => {
    const html = renderToStaticMarkup(
      <PluginLink prefix="Managed by plugin" pluginName="outlook-suite" onOpenPlugin={vi.fn()} />,
    );
    expect(html).toContain("Managed by plugin <code>outlook-suite</code>");
    expect(html).not.toContain("disabled");
  });

  it("renders disabled without a navigation target", () => {
    expect(renderToStaticMarkup(<PluginLink pluginName="outlook-suite" />)).toContain("disabled");
  });
});
