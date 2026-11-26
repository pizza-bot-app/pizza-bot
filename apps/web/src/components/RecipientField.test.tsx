import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { RecipientField } from "./RecipientField.js";
import { WelcomeState } from "./WelcomeState.js";

describe("RecipientField", () => {
  it("offers a picker with unavailable agents disabled", () => {
    const html = renderToStaticMarkup(
      <RecipientField
        name="Pizza Bot"
        options={[
          { name: "Pizza Bot" },
          { id: "research", name: "Research" },
          { id: "browser", name: "Browser", disabledReason: "playwright crashed" },
        ]}
        value="research"
        onChange={vi.fn()}
      />,
    );
    expect(html).toContain('aria-label="Send this conversation to"');
    expect(html).toContain('<option value="research" selected="">Research</option>');
    expect(html).toContain('disabled="" title="playwright crashed"');
    expect(html).toContain("Browser (playwright crashed)");
  });

  it("shows a fixed recipient as plain text", () => {
    const html = renderToStaticMarkup(<RecipientField name="Research" />);
    expect(html).not.toContain("<select");
    expect(html).toContain('<span class="recipient-name">Research</span>');
  });
});

describe("WelcomeState for an agent thread", () => {
  it("names the agent and says when it can't reply", () => {
    const html = renderToStaticMarkup(
      <WelcomeState
        agent={{
          id: "research",
          name: "Research",
          avatar: "",
          description: "Finds sources.",
          suggestedPrompts: [],
          unavailable: "Disabled",
        }}
        onPrefill={vi.fn()}
      />,
    );
    expect(html).toContain("Chat with Research");
    expect(html).toContain("Finds sources.");
    expect(html).toContain("Disabled");
    expect(html).not.toContain("welcome-suggestions");
  });
});
