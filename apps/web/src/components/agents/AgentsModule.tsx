import type {
  AgentCatalogInfo,
  AgentDefinition,
  AgentDraft,
  ModelsInfo,
  SkillCatalogInfo,
  ToolCatalogInfo,
} from "@/api-client";
import { useState } from "react";
import { Bot } from "lucide-react";
import { ProvenanceBadge } from "../ProvenanceBadge.js";
import { AgentEditor } from "./AgentEditor.js";
import { AgentView } from "./AgentView.js";
import { ResourceModule, type ResourceDetailArgs } from "../ResourceModule.js";
import { ResourceList } from "../ResourceList.js";
import { ResourceEditorSkeleton } from "../ResourceDetailSkeleton.js";
import { useKeyedDoc } from "../../use-keyed-doc.js";
import { L } from "../../lexicon.js";
import { agentRemovalPresentation } from "./agent-actions.js";
import {
  CapabilityEnablement,
  CapabilityStatusDot,
  type CapabilityVisualState,
} from "../CapabilityControls.js";

export interface AgentsModuleProps {
  agents: AgentCatalogInfo;
  tools: ToolCatalogInfo;
  models: Pick<ModelsInfo, "models">;
  skills: SkillCatalogInfo;
  onCreate: (definition: AgentDefinition) => Promise<AgentDefinition>;
  onUpdate: (id: string, definition: AgentDefinition) => Promise<AgentDefinition>;
  onSetEnabled: (id: string, enabled: boolean) => Promise<AgentEntry>;
  onDelete: (id: string) => Promise<boolean>;
  onGetDefinition: (id: string) => Promise<AgentDefinition | undefined>;
  onGenerate: (prompt: string) => Promise<AgentDraft>;
  onOpenPlugin?: (pluginName: string) => void;
  /** Opens the agent's own conversation in the Inbox. */
  onMessage?: (id: string) => Promise<void>;
}

type AgentEntry = AgentCatalogInfo["agents"][number];

const matches = (a: AgentEntry, q: string) =>
  a.name.toLowerCase().includes(q) ||
  a.id.toLowerCase().includes(q) ||
  a.description.toLowerCase().includes(q);

export function agentVisualState(agent: AgentEntry): CapabilityVisualState {
  if (!agent.enabled || agent.status === "disabled") return "disabled";
  if (agent.status === "loading") return "loading";
  if (agent.status === "unavailable") return "unavailable";
  return "active";
}

export function agentStatusLabel(agent: AgentEntry): string {
  if (!agent.enabled || agent.status === "disabled") return "Disabled";
  if (agent.status === "loading") return agent.statusDetail ?? "Loading";
  if (agent.status === "unavailable") return agent.statusDetail ?? "Unavailable";
  return "Ready";
}

export function AgentsModule(props: AgentsModuleProps) {
  const catalog = props.agents.agents;
  return (
    <ResourceModule
      items={catalog}
      getId={(a) => a.id}
      icon={<Bot size={18} />}
      emptyIcon={<Bot size={40} strokeWidth={1} />}
      title={L.agentsSection}
      newLabel={`New ${L.agent}`}
      emptyText={`Select an ${L.agent.toLowerCase()} to see its details, or create a new one.`}
      renderList={({ selectedId, onSelect }) => (
        <ResourceList
          items={catalog}
          getId={(a) => a.id}
          selectedId={selectedId}
          onSelect={onSelect}
          matches={matches}
          label={L.agents}
          searchPlaceholder={`Search ${L.agents.toLowerCase()}...`}
          emptyTitle={L.noAgents}
          emptySub="Create an agent to give Pizza Bot a specialist to delegate to."
          noMatchSub={(q) => `No ${L.agents.toLowerCase()} match “${q}”`}
          getRowClassName={(agent) => (!agent.enabled ? "disabled" : undefined)}
          renderRow={(a) => (
            <span className="resource-row-main">
              <span className="resource-row-line1">
                <span className="resource-row-name">{a.name}</span>
                <span className="resource-row-badges">
                  {a.status === "loading" || a.status === "unavailable" ? (
                    <span className={`capability-status-text ${a.status}`} title={a.statusDetail}>
                      {a.status === "loading" ? "Loading" : "Unavailable"}
                    </span>
                  ) : null}
                  <ProvenanceBadge provenance={a.source} overrides={a.overrides} />
                  <CapabilityStatusDot state={agentVisualState(a)} label={agentStatusLabel(a)} />
                </span>
              </span>
              <span className="resource-row-desc">{a.description}</span>
            </span>
          )}
        />
      )}
      renderDetail={(args) => <AgentDetail {...args} {...props} />}
    />
  );
}

function AgentDetail({
  selection,
  selected,
  setSelection,
  backToList,
  confirmAction,
  tools,
  models,
  skills,
  onCreate,
  onUpdate,
  onSetEnabled,
  onDelete,
  onGetDefinition,
  onGenerate,
  onOpenPlugin,
  onMessage,
}: ResourceDetailArgs<AgentEntry> & AgentsModuleProps) {
  const [savedRevision, setSavedRevision] = useState(0);
  const definition = useKeyedDoc(
    selected && selection?.mode !== "new" ? selected.id : null,
    onGetDefinition,
    selected ? `${selected.source}:${selected.overrides ?? ""}:${savedRevision}` : "",
  );
  const backToView = () => setSelection(selected ? { mode: "view", id: selected.id } : null);

  const handleSave = async (d: AgentDefinition) => {
    if (selection?.mode === "new") {
      const created = await onCreate(d);
      setSelection({ mode: "view", id: created.id });
    } else if (selection?.mode === "edit") {
      await onUpdate(d.id, d);
      setSavedRevision((revision) => revision + 1);
      setSelection({ mode: "view", id: d.id });
    }
  };
  const missingDependencies =
    selected?.mcpDependencies.filter((dependency) => dependency.status === "missing") ?? [];
  const disabledDependencies =
    selected?.mcpDependencies.filter((dependency) => dependency.status === "disabled") ?? [];
  const dependencyActions = [
    ...(missingDependencies.length > 0
      ? [`Configure ${missingDependencies.map((dependency) => dependency.id).join(", ")} first.`]
      : []),
    ...(disabledDependencies.length > 0
      ? [`Enable ${disabledDependencies.map((dependency) => dependency.id).join(", ")} first.`]
      : []),
  ];
  const blockedReason =
    selected && !selected.enabled && dependencyActions.length > 0
      ? dependencyActions.join(" ")
      : undefined;
  const stateDescription =
    selected?.enabled && selected.status !== "ready"
      ? selected.statusDetail ?? "Enabled, but currently unavailable"
      : undefined;
  const editorProps = { tools, models, skills, onSave: handleSave, onGenerate };

  if (selection?.mode === "new") {
    return <AgentEditor key="new" agent={null} {...editorProps} onCancel={() => setSelection(null)} />;
  }
  if (!selected) return null;

  if (selection?.mode === "edit") {
    const customizing = selected.source !== "user";
    if (!definition) {
      return (
        <ResourceEditorSkeleton
          sectionLabel={L.agentsSection}
          title={`${customizing ? "Customize" : "Edit"} ${selected.name}`}
          onCancel={backToView}
        />
      );
    }
    const removal = selected.source === "user" ? agentRemovalPresentation(selected) : undefined;
    return (
      <AgentEditor
        key={definition.id}
        agent={definition}
        {...editorProps}
        customizing={customizing}
        {...(removal
          ? {
              removalAction: {
                label: removal.label,
                mode: removal.mode,
                run: () =>
                  confirmAction(
                    removal.confirmation,
                    async () => {
                      await onDelete(definition.id);
                      if (removal.mode === "revert") backToView();
                    },
                    {
                      title: removal.title,
                      confirmLabel: removal.confirmLabel,
                      destructive: removal.mode === "delete",
                      preserveSelection: removal.mode === "revert",
                    },
                  ),
              },
            }
          : {})}
        onCancel={backToView}
      />
    );
  }

  return (
    <AgentView
      agent={selected}
      definition={definition}
      tools={tools}
      models={models}
      skills={skills}
      visualState={agentVisualState(selected)}
      statusLabel={agentStatusLabel(selected)}
      enablement={
        <CapabilityEnablement
          enabled={selected.enabled}
          noun="Agent"
          blockedReason={blockedReason}
          stateDescription={stateDescription}
          onChange={(enabled) => onSetEnabled(selected.id, enabled)}
        />
      }
      onEdit={() => setSelection({ mode: "edit", id: selected.id })}
      {...(onMessage ? { onMessage: () => onMessage(selected.id) } : {})}
      onOpenPlugin={onOpenPlugin}
      onBack={backToList}
    />
  );
}
