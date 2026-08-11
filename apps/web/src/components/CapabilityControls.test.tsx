import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { AppToastProvider } from "./AppToast.js";
import { CapabilityEnablement, CapabilityStatusDot } from "./CapabilityControls.js";

describe("CapabilityControls", () => {
  it("renders a fixed semantic state marker", () => {
    const html = renderToStaticMarkup(
      <CapabilityStatusDot state="crashed" label="Server crashed" />,
    );
    expect(html).toContain("capability-status-dot crashed");
    expect(html).toContain('aria-label="Server crashed"');
  });

  it("shows why the next transition is blocked", () => {
    const html = renderToStaticMarkup(
      <AppToastProvider>
        <CapabilityEnablement
          enabled
          noun="MCP server"
          blockedReason="Required by Calendar review."
          onChange={vi.fn()}
        />
      </AppToastProvider>,
    );
    expect(html).toContain('role="switch"');
    expect(html).toContain("disabled");
    expect(html).toContain("Required by Calendar review.");
  });
});
