import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { AgentCatalogEntryInfo } from "@/api-client";
import { AgentView } from "./AgentView.js";

const agent: AgentCatalogEntryInfo = {
  id: "research",
  name: "Research",
  description: "Finds sources.",
  source: "user",
  declaredTools: ["builtin:task"],
  skills: [],
  interruptOn: {},
  enabled: true,
  status: "ready",
  mcpDependencies: [],
};

function render(onMessage?: () => Promise<void>): string {
  return renderToStaticMarkup(
    <AgentView
      agent={agent}
      definition={null}
      tools={{ builtins: [{ ref: "builtin:task", name: "task" }], servers: [] }}
      models={{ models: [] }}
      skills={{ skills: [] } as never}
      visualState="active"
      statusLabel="Ready"
      onEdit={vi.fn()}
      {...(onMessage ? { onMessage } : {})}
    />,
  );
}

describe("AgentView", () => {
  it("offers to message the agent when the host can open its conversation", () => {
    expect(render(vi.fn(async () => {}))).toContain("Message");
    expect(render()).not.toContain("Message");
  });

  it("names the delegation grant", () => {
    expect(render()).toContain("task");
  });
});
