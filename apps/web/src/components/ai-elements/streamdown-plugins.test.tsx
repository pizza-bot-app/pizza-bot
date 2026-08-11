import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

const diagram = "# Inbox\n\n```mermaid\ngraph TD; Agent-->Action\n```";

afterEach(() => {
  vi.doUnmock("@streamdown/mermaid");
  vi.restoreAllMocks();
  vi.resetModules();
});

describe("lazy Streamdown plugins", () => {
  it("enhances a rendered message after the shared plugin bundle loads", async () => {
    const { loadStreamdownPlugins } = await import("./streamdown-plugins.js");
    const plugins = await loadStreamdownPlugins();
    expect(Object.keys(plugins ?? {}).sort()).toEqual(["cjk", "code", "math", "mermaid"]);

    const { MessageResponse } = await import("./message.js");
    const html = renderToStaticMarkup(<MessageResponse>{diagram}</MessageResponse>);

    expect(html).toContain("Inbox");
    expect(html).toContain("animate-spin");
    expect(html).not.toContain('data-language="mermaid"');
    expect(html).not.toContain("graph TD");
  });

  it("keeps basic Markdown rendering available when an enhanced chunk fails", async () => {
    vi.doMock("@streamdown/mermaid", () => {
      throw new Error("chunk unavailable");
    });
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { loadStreamdownPlugins } = await import("./streamdown-plugins.js");

    await expect(loadStreamdownPlugins()).resolves.toBeUndefined();
    expect(error).toHaveBeenCalledWith(
      expect.stringContaining("using basic rendering"),
    );

    const { MessageResponse } = await import("./message.js");
    const html = renderToStaticMarkup(<MessageResponse>{diagram}</MessageResponse>);
    expect(html).toContain("Inbox");
    expect(html).toContain('data-language="mermaid"');
    expect(html).toContain("graph TD");
  });
});
