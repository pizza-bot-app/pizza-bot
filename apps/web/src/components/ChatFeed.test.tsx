import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { UIPartLike } from "@/projection";
import { InterruptConfirmation } from "./ChatFeed.js";

type ApprovalPart = Extract<UIPartLike, { type: `tool-${string}` }>;

function approvalPart(overrides: Partial<ApprovalPart> = {}): ApprovalPart {
  return {
    type: "tool-mcp__outlook__send_email",
    toolCallId: "interrupt-1",
    state: "approval-requested",
    input: { recipient_email: "avery@example.com" },
    allowedDecisions: ["approve", "edit", "reject"],
    ...overrides,
  } as ApprovalPart;
}

describe("InterruptConfirmation", () => {
  it("shows a readable tool label without hiding its exact identifier", () => {
    const html = renderToStaticMarkup(<InterruptConfirmation part={approvalPart()} />);

    expect(html).toContain("MCP outlook send email");
    expect(html).toContain("mcp__outlook__send_email");
    expect(html).toContain("avery@example.com");
  });

  it("shows every call and exact tool identifier in a batch", () => {
    const html = renderToStaticMarkup(
      <InterruptConfirmation
        part={approvalPart({
          batch: [
            { toolName: "send_email", args: { subject: "First" } },
            { toolName: "calendar__create_event", args: { title: "Review" } },
          ],
        })}
      />,
    );

    expect(html).toContain("approval-batch");
    expect(html).toContain("send_email");
    expect(html).toContain("calendar__create_event");
    expect(html).toContain("First");
    expect(html).toContain("Review");
  });
});
