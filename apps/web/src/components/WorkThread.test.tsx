import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { ModelsInfo } from "@/api-client";
import { WorkThreadNotice } from "./ChatPane.js";
import { pinnedModelLabel } from "./Composer.js";

describe("WorkThreadNotice", () => {
  it("points the user to the agent's own conversation", () => {
    const html = renderToStaticMarkup(<WorkThreadNotice agentName="Researcher" onOpenConversation={vi.fn()} />);
    expect(html).toContain("This is Researcher&#x27;s work on a Todo.");
    expect(html).toContain("Message Researcher");
    expect(html).toContain('role="note"');
  });
});

describe("pinnedModelLabel", () => {
  const models = {
    models: [{ id: "bedrock:opus", displayName: "Claude Opus 5", provider: "bedrock" }],
  } as unknown as ModelsInfo;

  it("names a known model and falls back to the id", () => {
    expect(pinnedModelLabel("bedrock:opus", models)).not.toBe("bedrock:opus");
    expect(pinnedModelLabel("litellm:mock", models)).toBe("litellm:mock");
  });
});
