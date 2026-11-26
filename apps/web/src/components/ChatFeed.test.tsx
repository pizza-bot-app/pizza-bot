import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { UIPartLike } from "@/projection";
import { InterruptConfirmation, questionText } from "./ChatFeed.js";

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
  it("asks an agent's question with only an answer box when respond is the sole decision", () => {
    const html = renderToStaticMarkup(
      <InterruptConfirmation
        part={approvalPart({
          type: "tool-ask_user",
          input: { question: "Which passport office should I book?" },
          allowedDecisions: ["respond"],
        })}
      />,
    );

    expect(html).toContain("Question");
    expect(html).toContain("Which passport office should I book?");
    expect(html).toContain("Send answer");
    expect(html).not.toContain("Approve");
    expect(html).not.toContain("Reject");
  });

  it("offers only the decisions the interrupt allows", () => {
    const approveOnly = renderToStaticMarkup(
      <InterruptConfirmation part={approvalPart({ allowedDecisions: ["approve"] })} />,
    );
    expect(approveOnly).toContain(">Approve</button>");
    expect(approveOnly).not.toContain(">Reject</button>");
    expect(approveOnly).not.toContain(">Edit</button>");

    const rejectOrRespond = renderToStaticMarkup(
      <InterruptConfirmation part={approvalPart({ allowedDecisions: ["reject", "respond"] })} />,
    );
    expect(rejectOrRespond).toContain(">Reject</button>");
    expect(rejectOrRespond).toContain(">Respond</button>");
    expect(rejectOrRespond).not.toContain(">Approve</button>");
    expect(rejectOrRespond).toContain("Review <b>");
  });

  it("reads a question only from a non-blank string field", () => {
    expect(questionText({ question: "Why?" })).toBe("Why?");
    expect(questionText({ question: "  " })).toBeUndefined();
    expect(questionText({ question: 3 })).toBeUndefined();
    expect(questionText(null)).toBeUndefined();
  });

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
