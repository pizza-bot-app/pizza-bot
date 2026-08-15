import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  ApprovalArgumentEditor,
  ApprovalArguments,
  formatArgumentLabel,
  parseArgumentDraft,
  updateArgumentAtPath,
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
