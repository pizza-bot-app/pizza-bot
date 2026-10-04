import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  ApprovalArgumentEditor,
  ApprovalArguments,
  formatArgumentLabel,
  parseArgumentDraft,
  updateArgumentAtPath,
  type GroundingView,
} from "./ApprovalArguments.js";

describe("ApprovalArguments", () => {
  it("presents argument names and values without serialized JSON", () => {
    const html = renderToStaticMarkup(
      <ApprovalArguments
        value={{
          recipient_email: "avery@example.com",
          sendCopy: true,
          details: { message: "A long value that should wrap naturally." },
        }}
      />,
    );

    expect(html).toContain("Recipient email");
    expect(html).toContain("Send copy");
    expect(html).toContain("avery@example.com");
    expect(html).toContain(">Yes<");
    expect(html).not.toContain(">Boolean<");
    expect(html).not.toContain("&quot;recipient_email&quot;");
  });

  it("keeps empty and scalar values distinguishable in the approval summary", () => {
    const html = renderToStaticMarkup(
      <ApprovalArguments
        value={{
          empty: "",
          numericText: "2",
          numericValue: 2,
          missing: null,
          tags: [],
        }}
      />,
    );

    expect(html).toContain("Empty text");
    expect(html).toContain(">Text<");
    expect(html).toContain(">Null<");
    expect(html).toContain(">None<");
    expect(html).not.toContain(">Number<");
  });

  it("renders top-level primitive and array values", () => {
    const primitive = renderToStaticMarkup(<ApprovalArguments value="ready" />);
    const array = renderToStaticMarkup(<ApprovalArguments value={["one", 2]} />);

    expect(primitive).toContain(">ready<");
    expect(primitive).not.toContain(">Text<");
    expect(array).toContain(">one<");
    expect(array).not.toContain(">Number<");
  });

  it("renders a field-first editor with JSON available as a secondary view", () => {
    const html = renderToStaticMarkup(
      <ApprovalArgumentEditor
        value={{ subject: "Hello", retries: 2 }}
        rawDraft={'{\n  "subject": "Hello",\n  "retries": 2\n}'}
        rawError={null}
        onChange={() => undefined}
        onRawChange={() => undefined}
      />,
    );

    expect(html).toContain('role="group"');
    expect(html).toContain('aria-pressed="true"');
    expect(html).toContain(">Fields<");
    expect(html).toContain(">JSON<");
    expect(html).toContain(">Hello</textarea>");
    expect(html).not.toContain("approval-json-editor");
  });

  it("falls back to JSON for an empty argument object", () => {
    const html = renderToStaticMarkup(
      <ApprovalArgumentEditor
        value={{}}
        rawDraft="{}"
        rawError={null}
        onChange={() => undefined}
        onRawChange={() => undefined}
      />,
    );

    expect(html).toContain("approval-json-editor");
    expect(html).not.toContain(">Fields<");
    expect(html).not.toContain('role="group"');
  });

  it("keeps an invalid Fields control focusable and associates its error", () => {
    const html = renderToStaticMarkup(
      <ApprovalArgumentEditor
        value={{ retries: 2 }}
        rawDraft='{ "retries":'
        rawError="Unexpected end of JSON input"
        onChange={() => undefined}
        onRawChange={() => undefined}
      />,
    );

    const fieldsButton = html.match(/<button[^>]*>Fields<\/button>/)?.[0];
    expect(fieldsButton).toBeDefined();
    expect(html).toContain('aria-disabled="true"');
    expect(html).toContain("aria-describedby=");
    expect(fieldsButton).not.toMatch(/\sdisabled=/);
    expect(html).toContain("Unexpected end of JSON input");
  });

  it("offers typed values for a null argument", () => {
    const html = renderToStaticMarkup(
      <ApprovalArgumentEditor
        value={{ note: null }}
        rawDraft='{ "note": null }'
        rawError={null}
        onChange={() => undefined}
        onRawChange={() => undefined}
      />,
    );

    expect(html).toContain('<option value="null" selected="">Not set</option>');
    expect(html).toContain('<option value="string">Text</option>');
    expect(html).toContain('<option value="number">Number</option>');
    expect(html).toContain('<option value="boolean">Yes / no</option>');
  });
});

function groundingView(
  spans: GroundingView["spans"],
  status: GroundingView["status"] = "ready",
): GroundingView {
  return { status, spans, hoveredId: null, onHover: () => undefined, onSelect: () => undefined };
}

const cited = { arg: "body", text: "renews on March 4th", evidenceId: "ev_1" };
const graded = (tier: GroundingView["spans"][number]["tier"], extra: Partial<GroundingView["spans"][number]> = {}) => ({
  ...cited,
  tier,
  ...extra,
});

describe("ApprovalArguments citations", () => {
  it("marks a span the judge verified, shows what the source says, and hides the citation argument", () => {
    const html = renderToStaticMarkup(
      <ApprovalArguments
        value={{ body: "Your plan renews on March 4th.", _grounding: [cited] }}
        grounding={groundingView([
          graded("verifiable", { judge: "test:judge", lines: [2], support: [{ line: 2, text: "renews 2027-03-04" }] }),
        ])}
      />,
    );

    expect(html).toContain("grounding-verifiable");
    expect(html).toContain(">renews on March 4th</span>");
    expect(html).toContain("The source says:");
    expect(html).toContain("[2] renews 2027-03-04");
    expect(html).toContain("Your plan ");
    expect(html).not.toContain("Grounding");
    expect(html).not.toContain("ev_1");
  });

  it("names the figures a cited source does not contain", () => {
    const html = renderToStaticMarkup(
      <ApprovalArguments
        value={{ body: "We waived the $12 fee.", _grounding: [{ ...cited, text: "waived the $12 fee" }] }}
        grounding={groundingView([
          { ...cited, text: "waived the $12 fee", tier: "asserted", gap: { reason: "figures", tokens: ["$12"] } },
        ])}
      />,
    );

    expect(html).toContain("grounding-asserted");
    expect(html).toContain("Not in the cited lines: $12");
  });

  it("says when the judge found the source does not support the span", () => {
    const html = renderToStaticMarkup(
      <ApprovalArguments
        value={{ body: "Your plan renews on March 4th.", _grounding: [cited] }}
        grounding={groundingView([graded("asserted", { gap: { reason: "refuted" }, judge: "test:judge" })])}
      />,
    );

    expect(html).toContain("grounding-asserted");
    expect(html).toContain("do not support this");
  });

  it("says claim checking is off instead of implying the span was checked", () => {
    const html = renderToStaticMarkup(
      <ApprovalArguments
        value={{ body: "Your plan renews on March 4th.", _grounding: [cited] }}
        grounding={groundingView([graded("inconclusive", { gap: { reason: "unjudged" } })])}
      />,
    );

    expect(html).toContain("grounding-inconclusive");
    expect(html).toContain("Claim checking is off");
    expect(html).not.toContain("grounding-verifiable");
  });

  it("refuses to trust a supported verdict whose lines did not check out", () => {
    const html = renderToStaticMarkup(
      <ApprovalArguments
        value={{ body: "Your plan renews on March 4th.", _grounding: [cited] }}
        grounding={groundingView([graded("inconclusive", { gap: { reason: "unverified-support" } })])}
      />,
    );

    expect(html).toContain("was not trusted");
  });

  it("says a citation naming lines the source does not have points at nothing", () => {
    const html = renderToStaticMarkup(
      <ApprovalArguments
        value={{ body: "Your plan renews on March 4th.", _grounding: [cited] }}
        grounding={groundingView([graded("asserted", { gap: { reason: "bad-lines" } })])}
      />,
    );

    expect(html).toContain("grounding-asserted");
    expect(html).toContain("points at nothing");
  });

  it("marks cited spans as being checked until the server's grading arrives", () => {
    const html = renderToStaticMarkup(
      <ApprovalArguments
        value={{ body: "Your plan renews on March 4th.", _grounding: [cited] }}
        grounding={groundingView([], "checking")}
      />,
    );

    expect(html).toContain("grounding-pending");
    expect(html).toContain(">renews on March 4th</span>");
    expect(html).not.toContain("grounding-asserted");
  });

  it("says a grading it could not load went unchecked instead of checking forever", () => {
    const html = renderToStaticMarkup(
      <ApprovalArguments
        value={{ body: "Your plan renews on March 4th.", _grounding: [cited] }}
        grounding={groundingView([], "unavailable")}
      />,
    );

    expect(html).toContain("grounding-unchecked");
    expect(html).toContain("could not be loaded");
    expect(html).not.toContain("grounding-pending");
    expect(html).not.toContain("grounding-asserted");
  });

  it("leaves arguments unannotated when no citation view is supplied", () => {
    const html = renderToStaticMarkup(
      <ApprovalArguments value={{ body: "Your plan renews on March 4th.", _grounding: [cited] }} />,
    );

    expect(html).not.toContain("grounding-span");
    expect(html).not.toContain("ev_1");
  });

  it("keeps the citation argument out of the fields editor", () => {
    const value = { body: "Hello", _grounding: [cited] };
    const html = renderToStaticMarkup(
      <ApprovalArgumentEditor
        value={value}
        rawDraft={JSON.stringify(value, null, 2)}
        rawError={null}
        onChange={() => undefined}
        onRawChange={() => undefined}
      />,
    );

    expect(html).toContain(">Hello</textarea>");
    expect(html).not.toContain("ev_1");
  });
});

describe("argument editing helpers", () => {
  it("formats machine-oriented keys as readable field labels", () => {
    expect(formatArgumentLabel("delivery_address")).toBe("Delivery address");
    expect(formatArgumentLabel("sendCopy")).toBe("Send copy");
    expect(formatArgumentLabel("aws_outlook_mcp_email_send")).toBe(
      "AWS outlook MCP email send",
    );
  });

  it("updates a nested value without mutating the original arguments", () => {
    const original = {
      message: { recipients: [{ email: "old@example.com" }] },
      urgent: false,
    };

    const updated = updateArgumentAtPath(
      original,
      ["message", "recipients", 0, "email"],
      "new@example.com",
    );

    expect(updated).toEqual({
      message: { recipients: [{ email: "new@example.com" }] },
      urgent: false,
    });
    expect(original.message.recipients[0]!.email).toBe("old@example.com");
  });

  it("parses valid drafts and reports invalid drafts", () => {
    expect(parseArgumentDraft('{ "retries": 2 }')).toEqual({
      ok: true,
      value: { retries: 2 },
      error: null,
    });
    expect(parseArgumentDraft('{ "retries":')).toMatchObject({
      ok: false,
    });
  });
});
