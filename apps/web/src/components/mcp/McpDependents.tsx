import type { McpServerRow } from "@/api-client";
import { BookOpen, LockKeyhole } from "lucide-react";
import { ProvenanceBadge } from "../ProvenanceBadge.js";

export function McpDependents({
  skills,
}: {
  skills: McpServerRow["dependentSkills"];
}) {
  return (
    <section className="resource-card-section mcp-dependents">
      <h3 className="resource-card-section-title">
        <BookOpen size={14} /> Required by skills
      </h3>
      {skills.length === 0 ? (
        <p className="resource-card-empty">
          No skill uses this server’s tools yet. The assistant calls MCP tools only through a skill
          that lists them, so add one to put this server to work.
        </p>
      ) : (
        <ul className="mcp-dependent-list">
          {skills.map((skill) => (
            <li key={skill.id} className="mcp-dependent-row">
              <span className="mcp-dependent-name">
                {skill.enabled && <LockKeyhole size={12} aria-label="Prevents disabling this server" />}
                {skill.name}
              </span>
              <span className="mcp-dependent-meta">
                <span>{skill.enabled ? "Enabled" : "Disabled"}</span>
                <ProvenanceBadge provenance={skill.source} />
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
