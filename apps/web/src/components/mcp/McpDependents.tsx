import type { McpServerRow } from "@/api-client";
import { Bot, LockKeyhole } from "lucide-react";
import { ProvenanceBadge } from "../ProvenanceBadge.js";

export function McpDependents({
  agents,
}: {
  agents: McpServerRow["dependentAgents"];
}) {
  if (agents.length === 0) return null;
  return (
    <section className="resource-card-section mcp-dependents">
      <h3 className="resource-card-section-title">
        <Bot size={14} /> Required by agents
      </h3>
      <ul className="mcp-dependent-list">
        {agents.map((agent) => (
          <li key={agent.id} className="mcp-dependent-row">
            <span className="mcp-dependent-name">
              {agent.enabled && <LockKeyhole size={12} aria-label="Prevents disabling this server" />}
              {agent.name}
            </span>
            <span className="mcp-dependent-meta">
              <span>{agent.enabled ? "Enabled" : "Disabled"}</span>
              <ProvenanceBadge provenance={agent.source} />
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}
