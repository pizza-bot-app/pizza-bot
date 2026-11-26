import { describe, expect, it } from "vitest";
import type { AgentCatalogEntryInfo, AgentInfo } from "@/api-client";
import { recipientOptions, threadAgent } from "./thread-agent.js";

const assistant: AgentInfo = {
  id: "pizza-bot",
  name: "Pizza Bot",
  avatar: "🍕",
  description: "Your assistant.",
  suggestedPrompts: [{ suggestion: "Hi", prompt: "Hello" }],
};

function entry(id: string, fields: Partial<AgentCatalogEntryInfo> = {}): AgentCatalogEntryInfo {
  return {
    id,
    name: id[0]!.toUpperCase() + id.slice(1),
    description: `${id} does things`,
    source: "user",
    declaredTools: [],
    skills: [],
    interruptOn: {},
    enabled: true,
    status: "ready",
    mcpDependencies: [],
    ...fields,
  };
}

describe("threadAgent", () => {
  it("is Pizza Bot when the thread names no agent", () => {
    expect(threadAgent(undefined, [entry("research")], assistant)).toBe(assistant);
  });

  it("uses the catalog entry, without Pizza Bot's suggestions", () => {
    expect(threadAgent("research", [entry("research")], assistant)).toEqual({
      id: "research",
      name: "Research",
      avatar: "",
      description: "research does things",
      suggestedPrompts: [],
    });
  });

  it("carries the model an agent pins", () => {
    expect(threadAgent("research", [entry("research", { model: "bedrock:opus" })], assistant).model).toBe("bedrock:opus");
    expect(threadAgent("research", [entry("research")], assistant).model).toBeUndefined();
  });

  it("says why an agent can't reply", () => {
    expect(threadAgent("research", [entry("research", { enabled: false })], assistant).unavailable).toBe("Disabled");
    expect(
      threadAgent("research", [entry("research", { status: "unavailable", statusDetail: "fs is not configured" })], assistant)
        .unavailable,
    ).toBe("fs is not configured");
  });

  it("names a missing agent by id and marks it unavailable", () => {
    const missing = threadAgent("gone", [], assistant);
    expect(missing.name).toBe("gone (unavailable)");
    expect(missing.unavailable).toBeDefined();
    expect(missing.suggestedPrompts).toEqual([]);
  });
});

describe("recipientOptions", () => {
  it("lists Pizza Bot first, then enabled agents by name, disabling those that can't reply", () => {
    const options = recipientOptions(
      [
        entry("writer"),
        entry("archived", { enabled: false }),
        entry("analyst", { status: "loading" }),
        entry("browser", { status: "unavailable", statusDetail: "playwright crashed" }),
      ],
      "Pizza Bot",
    );
    expect(options).toEqual([
      { name: "Pizza Bot" },
      { id: "analyst", name: "Analyst", disabledReason: "Loading" },
      { id: "browser", name: "Browser", disabledReason: "playwright crashed" },
      { id: "writer", name: "Writer" },
    ]);
  });
});
