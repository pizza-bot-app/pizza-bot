import type { AgentCatalogEntryInfo, AgentDefinition, ModelsInfo, SkillCatalogInfo, ToolCatalogInfo } from "@/api-client";
import { useState, type ReactNode } from "react";
import { BookOpen, Bot, Cable, Cpu, Hand, MessageSquare, ScrollText, Wrench } from "lucide-react";
import { ProvenanceBadge } from "../ProvenanceBadge.js";
import { CapabilityStatusDot, type CapabilityVisualState } from "../CapabilityControls.js";
import { EditAction, PluginLink, ResourceSection, ResourceView } from "../ResourceView.js";
import { SkeletonLines } from "../ResourceDetailSkeleton.js";
import { L } from "../../lexicon.js";
import { describeGrantedTool } from "../tools/tool-catalog.js";
import { ToolChip } from "../tools/ToolList.js";

export function AgentView({
  agent,
  definition,
  tools,
  models,
  skills,
  visualState,
  statusLabel,
  enablement,
  onEdit,
  onMessage,
  onOpenPlugin,
  onBack,
}: {
  agent: AgentCatalogEntryInfo;
  definition: AgentDefinition | null | undefined;
  tools: ToolCatalogInfo;
  models: Pick<ModelsInfo, "models">;
  skills: SkillCatalogInfo;
  visualState: CapabilityVisualState;
  statusLabel: string;
  enablement?: ReactNode;
  onEdit: () => void;
  onMessage?: () => Promise<void>;
  onOpenPlugin?: (pluginName: string) => void;
  onBack?: () => void;
}) {
  const shipped = agent.source !== "user";
  const shippedFrom = agent.overrides ?? (shipped ? agent.source : undefined);
  const provenance =
    agent.pluginName && shippedFrom === "plugin" ? (
      <PluginLink
        prefix={agent.overrides ? "customized from plugin" : "from plugin"}
        pluginName={agent.pluginName}
        onOpenPlugin={onOpenPlugin}
      />
    ) : shippedFrom === "builtin" ? (
      <span>{agent.overrides ? "Customized from the built-in version" : "Built in to Pizza Bot"}</span>
    ) : undefined;
  const interruptRefs = Object.entries(agent.interruptOn)
    .filter(([, config]) => config !== false)
    .map(([ref]) => ref);
  const modelLabel = agent.model
    ? models.models.find((model) => model.id === agent.model)?.displayName ?? agent.model
    : "Inherits the conversation model";
  const skillName = (id: string) => skills.skills.find((skill) => skill.id === id)?.name ?? id;

  return (
    <ResourceView
      glyph={<Bot size={28} strokeWidth={1.5} />}
      name={agent.name}
      badge={<ProvenanceBadge provenance={agent.source} overrides={agent.overrides} />}
      status={
        <>
          <CapabilityStatusDot state={visualState} label={statusLabel} /> {statusLabel}
        </>
      }
      provenance={provenance}
      headerAction={
        <>
          {onMessage && <MessageAgentAction onMessage={onMessage} />}
          <EditAction label={shipped ? "Customize" : "Edit"} onEdit={onEdit} />
        </>
      }
      backLabel={L.agentsSection}
      onBack={onBack}
    >
      <p className="resource-card-lede">{agent.description}</p>
      {enablement}
      <ResourceSection title="Instructions" icon={<ScrollText size={14} />}>
        {definition === undefined ? (
          <div className="skill-card-body pending">
            <SkeletonLines count={6} />
          </div>
        ) : (
          <pre className="skill-card-body">{definition?.systemPrompt.trim() || "(no instructions)"}</pre>
        )}
      </ResourceSection>
      <ResourceSection title="Model" icon={<Cpu size={14} />}>
        <p className="resource-card-empty">{modelLabel}</p>
      </ResourceSection>
      <ResourceSection title="Tools" icon={<Wrench size={14} />}>
        {agent.declaredTools.length === 0 ? (
          <p className="resource-card-empty">This agent uses only the filesystem tools.</p>
        ) : (
          <ul className="resource-chip-list">
            {agent.declaredTools.map((ref) => (
              <li key={ref}>
                <ToolChip tool={describeGrantedTool(ref, tools)} />
              </li>
            ))}
          </ul>
        )}
      </ResourceSection>
      {interruptRefs.length > 0 && (
        <ResourceSection title="Asks before running" icon={<Hand size={14} />}>
          <ul className="resource-chip-list">
            {interruptRefs.map((ref) => (
              <li key={ref}>
                <ToolChip tool={describeGrantedTool(ref, tools)} />
              </li>
            ))}
          </ul>
        </ResourceSection>
      )}
      {agent.skills.length > 0 && (
        <ResourceSection title="Skills" icon={<BookOpen size={14} />}>
          <ul className="resource-chip-list">
            {agent.skills.map((id) => (
              <li key={id}>
                <span className="resource-tool-chip">{skillName(id)}</span>
              </li>
            ))}
          </ul>
        </ResourceSection>
      )}
      {agent.mcpDependencies.length > 0 && (
        <ResourceSection title="Requires MCP servers" icon={<Cable size={14} />}>
          <ul className="skill-card-files">
            {agent.mcpDependencies.map((dependency) => (
              <li key={dependency.id} className="skill-card-file">
                <code>{dependency.id}</code>
                <span>{dependency.status === "missing" ? "not configured" : dependency.status}</span>
              </li>
            ))}
          </ul>
        </ResourceSection>
      )}
    </ResourceView>
  );
}

function MessageAgentAction({ onMessage }: { onMessage: () => Promise<void> }) {
  const [opening, setOpening] = useState(false);
  const [failed, setFailed] = useState(false);
  const open = async () => {
    setOpening(true);
    setFailed(false);
    try {
      await onMessage();
    } catch (error) {
      console.error("open agent conversation failed", error);
      setFailed(true);
    } finally {
      setOpening(false);
    }
  };
  return (
    <button
      type="button"
      className="btn-secondary"
      onClick={() => void open()}
      disabled={opening}
      title={failed ? "Couldn't open the conversation. Try again." : undefined}
      aria-invalid={failed || undefined}
    >
      <MessageSquare size={14} /> {L.messageAgent}
    </button>
  );
}
