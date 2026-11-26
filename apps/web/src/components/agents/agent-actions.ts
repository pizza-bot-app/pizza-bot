import type { AgentCatalogEntryInfo } from "@/api-client";
import type { SkillRemovalPresentation } from "../skills/skill-actions.js";

export function agentRemovalPresentation(
  agent: Pick<AgentCatalogEntryInfo, "overrides">,
): SkillRemovalPresentation {
  if (agent.overrides) {
    const source = agent.overrides === "builtin" ? "built-in" : "plugin";
    return {
      title: "Revert agent?",
      label: `Revert to ${source}`,
      confirmLabel: "Revert",
      confirmation: `Revert this agent to the ${source} version? Your customizations will be removed.`,
      mode: "revert",
    };
  }
  return {
    title: "Delete agent?",
    label: "Delete",
    confirmLabel: "Delete",
    confirmation: "Delete this agent? This can’t be undone.",
    mode: "delete",
  };
}
