import type { AgentCatalogEntryInfo, AgentInfo } from "@/api-client";
import { L } from "../lexicon.js";

export interface ThreadAgent extends AgentInfo {
  /** Why the agent can't reply right now; absent when it can. */
  unavailable?: string;
  /** A model the agent pins; it runs on this whatever the composer picks. */
  model?: string;
}

export interface RecipientOption {
  /** Absent for Pizza Bot, the default recipient. */
  id?: string;
  name: string;
  disabledReason?: string;
}

function unavailableReason(entry: AgentCatalogEntryInfo): string | undefined {
  if (!entry.enabled || entry.status === "disabled") return "Disabled";
  if (entry.status === "loading") return entry.statusDetail ?? "Loading";
  if (entry.status === "unavailable") return entry.statusDetail ?? "Unavailable";
  return undefined;
}

/** Who a thread talks to: Pizza Bot unless the thread names an agent. */
export function threadAgent(
  agentId: string | undefined,
  catalog: readonly AgentCatalogEntryInfo[],
  assistant: AgentInfo,
): ThreadAgent {
  if (!agentId) return assistant;
  const entry = catalog.find((agent) => agent.id === agentId);
  if (!entry) {
    return {
      id: agentId,
      name: `${agentId} (${L.agentUnavailable})`,
      avatar: "",
      description: L.agentMissingDescription,
      suggestedPrompts: [],
      unavailable: L.agentMissingDescription,
    };
  }
  const reason = unavailableReason(entry);
  return {
    id: entry.id,
    name: entry.name,
    avatar: "",
    description: entry.description,
    suggestedPrompts: [],
    ...(entry.model ? { model: entry.model } : {}),
    ...(reason ? { unavailable: reason } : {}),
  };
}

/** Pizza Bot first, then enabled agents by name; agents that can't reply yet are listed but not choosable. */
export function recipientOptions(
  catalog: readonly AgentCatalogEntryInfo[],
  assistantName: string,
): RecipientOption[] {
  const agents = catalog
    .filter((agent) => agent.enabled)
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((agent): RecipientOption => {
      const reason = unavailableReason(agent);
      return { id: agent.id, name: agent.name, ...(reason ? { disabledReason: reason } : {}) };
    });
  return [{ name: assistantName }, ...agents];
}
