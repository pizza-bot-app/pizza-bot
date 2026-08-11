import type { McpServerRow, McpServerDoc, McpServerEntryWire } from "@/api-client";
import { Cable } from "lucide-react";
import { ProvenanceBadge } from "../ProvenanceBadge.js";
import { McpServerCard } from "./McpServerCard.js";
import { McpServerEditor } from "./McpServerEditor.js";
import { ResourceModule } from "../ResourceModule.js";
import { ResourceList } from "../ResourceList.js";
import { ResourceEditorSkeleton } from "../ResourceDetailSkeleton.js";
import { useKeyedDoc } from "../../use-keyed-doc.js";
import { L } from "../../lexicon.js";
import {
  CapabilityEnablement,
  CapabilityStatusDot,
  type CapabilityVisualState,
} from "../CapabilityControls.js";
import { McpDependents } from "./McpDependents.js";

export interface McpServersModuleProps {
  servers: McpServerRow[];
  onCreate: (id: string, entry: McpServerEntryWire) => Promise<McpServerRow>;
  onUpdate: (id: string, entry: McpServerEntryWire) => Promise<McpServerRow>;
  onSetEnabled: (id: string, enabled: boolean) => Promise<McpServerRow>;
  onDelete: (id: string) => Promise<boolean>;
  onGetDoc: (id: string) => Promise<McpServerDoc | undefined>;
}

function transportSummary(entry: McpServerRow["entry"]): string {
  if ("command" in entry) return `${entry.command} ${(entry.args ?? []).join(" ")}`.trim();
  return entry.url;
}

const matches = (s: McpServerRow, q: string) =>
  s.id.toLowerCase().includes(q) || transportSummary(s.entry).toLowerCase().includes(q);

function mcpVisualState(server: McpServerRow): CapabilityVisualState {
  if (!server.enabled || server.status === "disabled") return "disabled";
  if (server.status === "loading" || server.status === "retrying") return "loading";
  if (server.status === "connected") return "active";
  if (server.status === "crashed") return "crashed";
  return "unavailable";
}

export function McpServersModule({ servers, onCreate, onUpdate, onSetEnabled, onDelete, onGetDoc }: McpServersModuleProps) {
  return (
    <ResourceModule
      items={servers}
      getId={(s) => s.id}
      icon={<Cable size={18} />}
      emptyIcon={<Cable size={40} strokeWidth={1} />}
      title={L.mcpSection}
      newLabel={`New ${L.mcpServer}`}
      emptyText={`Select an ${L.mcpServer} to see its details, or add a new one.`}
      renderList={({ selectedId, onSelect }) => (
        <ResourceList
          items={servers}
          getId={(s) => s.id}
          selectedId={selectedId}
          onSelect={onSelect}
          matches={matches}
          label={L.mcpServers}
          searchPlaceholder={`Search ${L.mcpServers.toLowerCase()}...`}
          emptyTitle={L.noMcpServers}
          emptySub="No MCP servers are configured."
          noMatchSub={(q) => `No ${L.mcpServers.toLowerCase()} match “${q}”`}
          getRowClassName={(server) => (!server.enabled ? "disabled" : undefined)}
          renderRow={(s) => {
            const statusLabel =
              s.status === "connected"
                ? `Connected · ${s.toolCount} tool(s)`
                : s.status === "disabled"
                  ? "Disabled"
                  : "Not connected";
            return (
              <span className="resource-row-main">
                <span className="resource-row-line1">
                  <span className="resource-row-name">{s.id}</span>
                  <span className="resource-row-badges">
                    <ProvenanceBadge provenance={s.source} />
                    <CapabilityStatusDot state={mcpVisualState(s)} label={statusLabel} />
                  </span>
                </span>
                <span className="resource-row-desc">{transportSummary(s.entry)}</span>
              </span>
            );
          }}
        />
      )}
      renderDetail={({ selection, selected, setSelection, backToList, confirmAction }) => (
        <McpServerDetail
          selection={selection}
          selected={selected}
          setSelection={setSelection}
          backToList={backToList}
          confirmAction={confirmAction}
          onCreate={onCreate}
          onUpdate={onUpdate}
          onSetEnabled={onSetEnabled}
          onDelete={onDelete}
          onGetDoc={onGetDoc}
        />
      )}
    />
  );
}

function McpServerDetail({
  selection,
  selected,
  setSelection,
  backToList,
  confirmAction,
  onCreate,
  onUpdate,
  onSetEnabled,
  onDelete,
  onGetDoc,
}: {
  selection: import("../ResourceModule.js").ResourceSelection;
  selected: McpServerRow | null;
  setSelection: (next: import("../ResourceModule.js").ResourceSelection) => void;
  backToList?: () => void;
  confirmAction: import("../ResourceModule.js").ResourceDetailArgs<McpServerRow>["confirmAction"];
} & Pick<McpServersModuleProps, "onCreate" | "onUpdate" | "onSetEnabled" | "onDelete" | "onGetDoc">) {
  const isUser = selected?.source === "user";
  const doc = useKeyedDoc(
    selection?.mode === "view" && isUser && selected ? selected.id : null,
    onGetDoc,
  );

  const handleSave = async (id: string, entry: McpServerEntryWire) => {
    if (selection?.mode === "new") {
      const created = await onCreate(id, entry);
      setSelection({ mode: "view", id: created.id });
    } else if (selection?.mode === "view") {
      await onUpdate(id, entry);
    }
  };
  const enabledDependents =
    selected?.dependentSkills.filter((skill) => skill.enabled) ?? [];
  const blockedReason =
    selected?.enabled && enabledDependents.length > 0
      ? `Required by ${enabledDependents.map((skill) => skill.name).join(", ")}.`
      : undefined;
  const enablement = selected ? (
    <CapabilityEnablement
      enabled={selected.enabled}
      noun="MCP server"
      blockedReason={blockedReason}
      onChange={(enabled) => onSetEnabled(selected.id, enabled)}
    />
  ) : undefined;
  const dependents = selected ? <McpDependents skills={selected.dependentSkills} /> : undefined;

  if (selection?.mode === "new") {
    return <McpServerEditor key="new" server={null} onSave={handleSave} onCancel={() => setSelection(null)} />;
  }
  if (selected && isUser && !doc) {
    return (
      <ResourceEditorSkeleton
        sectionLabel={L.mcpSection}
        title={`Edit ${selected.id}`}
        onCancel={() => setSelection(null)}
      >
        {enablement}
        {dependents}
      </ResourceEditorSkeleton>
    );
  }
  if (selected && isUser && doc) {
    return (
      <McpServerEditor
        key={doc.id}
        server={doc}
        enablement={enablement}
        dependents={dependents}
        onSave={handleSave}
        onDelete={() =>
          confirmAction(
            "Delete this MCP server? This can’t be undone.",
            () => onDelete(doc.id),
            {
              title: "Delete MCP server?",
              confirmLabel: "Delete",
              destructive: true,
            },
          )
        }
        onCancel={() => setSelection(null)}
      />
    );
  }
  if (selected) {
    return (
      <McpServerCard
        server={selected}
        enablement={enablement}
        dependents={dependents}
        onBack={backToList}
      />
    );
  }
  return null;
}
