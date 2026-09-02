import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { DelegationInfo } from "@/projection";
import { ActivityRail } from "./ActivityRail.js";

function delegation(overrides: Partial<DelegationInfo> = {}): DelegationInfo {
  return {
    delegationId: "task-1",
    subagent: "mail-assistant",
    title: "send the note",
    status: "running",
    depth: 0,
    parentId: null,
    ...overrides,
  };
}

function render(delegations: DelegationInfo[], isRunning = false): string {
  return renderToStaticMarkup(
    <ActivityRail
      delegations={Object.fromEntries(delegations.map((d) => [d.delegationId, d]))}
      isRunning={isRunning}
    />,
  );
}

describe("ActivityRail delegation status", () => {
  it("shows a delegation waiting on approval as awaiting input, not failed", () => {
    const html = render([delegation({ status: "awaiting-input" })]);

    expect(html).toContain("activity-icon-await");
    expect(html).toContain("Awaiting approval");
    expect(html).not.toContain("activity-icon-error");
  });

  it("still marks a genuinely failed delegation with the error icon", () => {
    const html = render([delegation({ status: "error", errorText: "worker crashed" })]);

    expect(html).toContain("activity-icon-error");
    expect(html).not.toContain("activity-icon-await");
  });

  it("reports a batch as awaiting input when any member waits on approval", () => {
    const html = render([
      delegation({ delegationId: "task-1", status: "awaiting-input", batchId: "b1" }),
      delegation({ delegationId: "task-2", subagent: "sfdc-assistant", status: "running", batchId: "b1" }),
    ]);

    expect(html).toContain("activity-icon-await");
    expect(html).not.toContain("activity-icon-error");
  });

  it("keeps an errored batch member from turning the batch into a failure while one waits", () => {
    const awaiting = render([
      delegation({ delegationId: "task-1", status: "awaiting-input", batchId: "b1" }),
      delegation({ delegationId: "task-2", status: "error", errorText: "boom", batchId: "b1" }),
    ]);

    // The batch head reads awaiting; only the failed child keeps its error icon.
    expect(awaiting.indexOf("activity-icon-await")).toBeLessThan(awaiting.indexOf("activity-icon-error"));
  });
});
