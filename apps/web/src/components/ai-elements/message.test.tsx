import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { MessageResponse } from "./message.js";

const prompt = "Everything between <todo-record> and </todo-record> is data.\n\n<todo-record>\nTodo: `<b>`\n</todo-record>";

describe("MessageResponse", () => {
  it("shows HTML in a message as literal text when asked", () => {
    const html = renderToStaticMarkup(<MessageResponse literalHtml>{prompt}</MessageResponse>);
    expect(html).toContain("Everything between &lt;todo-record&gt; and &lt;/todo-record&gt; is data.");
    expect(html).toContain("&lt;/todo-record&gt;");
    expect(html).not.toContain("<b>");
  });

  it("renders safe HTML by default", () => {
    expect(renderToStaticMarkup(<MessageResponse>{"a<br>b"}</MessageResponse>)).toContain("<br/>");
  });
});
