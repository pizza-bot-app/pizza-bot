import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { ToolPart } from "./tool.js";
import { ToolOutput } from "./tool.js";

function renderOutput(output: unknown): string {
  return renderToStaticMarkup(
    <ToolOutput
      output={output as ToolPart["output"]}
      errorText={undefined}
    />,
  );
}

describe("ToolOutput", () => {
  it.each([
    [0, "0"],
    [false, "false"],
  ])("renders the valid falsey result %s", (output, expected) => {
    expect(renderOutput(output)).toContain(`<div>${expected}</div>`);
  });

  it("keeps an empty-string result visible", () => {
    const html = renderOutput("");
    expect(html).toContain("Result");
    expect(html).toContain("<code></code>");
  });

  it("omits a result only when output and error are absent", () => {
    expect(renderOutput(undefined)).toBe("");
  });
});
