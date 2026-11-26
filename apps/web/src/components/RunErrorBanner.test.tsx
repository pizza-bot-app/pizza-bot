import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { RunErrorBanner } from "./RunErrorBanner.js";

describe("RunErrorBanner", () => {
  it("offers Retry only when the failed turn can be re-run", () => {
    expect(renderToStaticMarkup(<RunErrorBanner text="failed" />)).not.toContain("Retry");
    expect(
      renderToStaticMarkup(<RunErrorBanner text="failed" onRetry={async () => undefined} />),
    ).toContain("Retry</button>");
  });
});
