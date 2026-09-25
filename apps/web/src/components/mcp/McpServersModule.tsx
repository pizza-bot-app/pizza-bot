import type { McpServerRow, McpServerDoc, McpServerEntryWire } from "@/api-client";
import { useState } from "react";
import { AlertTriangle, Cable, Pencil, Puzzle, RefreshCw, Trash2 } from "lucide-react";
import { ProvenanceBadge } from "../ProvenanceBadge.js";
import { McpServerCard, mcpStatusLabel, mcpVisualState } from "./McpServerCard.js";
import { McpServerEditor } from "./McpServerEditor.js";
import { ResourceModule, type ResourceDetailArgs } from "../ResourceModule.js";
import { ResourceList } from "../ResourceList.js";
import { ResourceEditorSkeleton } from "../ResourceDetailSkeleton.js";
import { useKeyedDoc } from "../../use-keyed-doc.js";
import { L } from "../../lexicon.js";
import { CapabilityEnablement, CapabilityStatusDot } from "../CapabilityControls.js";
import { McpDependents } from "./McpDependents.js";
import { McpReconnectControl } from "./McpReconnectControl.js";

export interface McpServersModuleProps {
  servers: McpServerRow[];
  onCreate: (id: string, entry: McpServerEntryWire) => Promise<McpServerRow>;
  onUpdate: (id: string, entry: McpServerEntryWire) => Promise<McpServerRow>;
  onSetEnabled: (id: string, enabled: boolean) => Promise<McpServerRow>;
  onReconnect: (id: string) => Promise<McpServerRow>;
  onDelete: (id: string) => Promise<boolean>;
  onGetDoc: (id: string) => Promise<McpServerDoc | undefined>;
  onOpenPlugins?: () => void;
}

function transportSummary(entry: McpServerRow["entry"]): string {
  if ("command" in entry) return `${entry.command} ${(entry.args ?? []).join(" ")}`.trim();
  return entry.url;
}

const matches = (s: McpServerRow, q: string) =>
  s.id.toLowerCase().includes(q) || transportSummary(s.entry).toLowerCase().includes(q);

export function McpServersModule({
  servers,
  onCreate,
  onUpdate,
  onSetEnabled,
  onReconnect,
  onDelete,
  onGetDoc,
  onOpenPlugins,
}: McpServersModuleProps) {
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
          renderRow={(s) => (
            <span className="resource-row-main">
              <span className="resource-row-line1">
                <span className="resource-row-name">{s.id}</span>
                <span className="resource-row-badges">
                  <ProvenanceBadge provenance={s.source} />
                  <CapabilityStatusDot state={mcpVisualState(s)} label={mcpStatusLabel(s)} />
                </span>
              </span>
              <span className="resource-row-desc">{transportSummary(s.entry)}</span>
            </span>
          )}
        />
      )}
      renderDetail={(args) => (
        <McpServerDetail
          {...args}
          onCreate={onCreate}
          onUpdate={onUpdate}
          onSetEnabled={onSetEnabled}
          onReconnect={onReconnect}
          onDelete={onDelete}
          onGetDoc={onGetDoc}
          onOpenPlugins={onOpenPlugins}
        />
      )}
    />
  );
}

export function McpServerActions({
  server,
  deleteBlockedReason,
  onEdit,
  onDelete,
  onOpenPlugins,
}: {
  server: McpServerRow;
  deleteBlockedReason?: string;
  onEdit: () => void;
  onDelete: () => void;
  onOpenPlugins?: () => void;
}) {
  const managed = server.source === "plugin";
  const managedReason = `Managed by the ${server.pluginName ?? "plugin"} plugin`;
  return (
    <>
      {managed && (
        <button
          type="button"
          className="resource-card-link mcp-managed-link"
          onClick={onOpenPlugins}
          disabled={!onOpenPlugins}
        >
          <Puzzle size={13} /> Managed by plugin
        </button>
      )}
      <button
        type="button"
        className="plugin-card-action"
        aria-label={`Edit ${server.id}`}
        title={managed ? managedReason : "Edit"}
        onClick={onEdit}
        disabled={managed}
      >
        <Pencil size={15} />
      </button>
      <button
        type="button"
        className="plugin-card-action plugin-card-remove"
        aria-label={`Delete ${server.id}`}
        title={managed ? managedReason : deleteBlockedReason ?? "Delete"}
        onClick={onDelete}
        disabled={managed || Boolean(deleteBlockedReason)}
      >
        <Trash2 size={15} />
      </button>
    </>
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
  onReconnect,
  onDelete,
  onGetDoc,
  onOpenPlugins,
}: ResourceDetailArgs<McpServerRow> &
  Pick<
    McpServersModuleProps,
    "onCreate" | "onUpdate" | "onSetEnabled" | "onReconnect" | "onDelete" | "onGetDoc" | "onOpenPlugins"
  >) {
  const isUser = selected?.source === "user";
  const editing = selection?.mode === "edit" && isUser;
  const [reloadToken, setReloadToken] = useState(0);
  const doc = useKeyedDoc(editing && selected ? selected.id : null, onGetDoc, reloadToken);

  const handleSave = async (id: string, entry: McpServerEntryWire) => {
    if (selection?.mode === "new") {
      const created = await onCreate(id, entry);
      setSelection({ mode: "view", id: created.id });
    } else if (selection?.mode === "edit") {
      await onUpdate(id, entry);
      setSelection({ mode: "view", id });
    }
  };

  const leaveEditor = (dirty: boolean) => {
    const back = () => setSelection(selected ? { mode: "view", id: selected.id } : null);
    if (!dirty) return back();
    void confirmAction(
      selected
        ? `Discard your changes to ${selected.id}? Anything you edited will be lost.`
        : "Discard this new server? Anything you entered will be lost.",
      async () => back(),
      {
        title: "Discard changes?",
        confirmLabel: "Discard",
        destructive: true,
        preserveSelection: true,
        successMessage: null,
      },
    );
  };

  const enabledDependents =
    selected?.dependentSkills.filter((skill) => skill.enabled) ?? [];
  const dependentNames = enabledDependents.map((skill) => skill.name).join(", ");
  const blockedReason =
    selected?.enabled && enabledDependents.length > 0 ? `Required by ${dependentNames}.` : undefined;
  const deleteBlockedReason =
    enabledDependents.length > 0
      ? `Required by ${dependentNames}. Disable ${enabledDependents.length === 1 ? "that skill" : "those skills"} first.`
      : undefined;

  const requestDelete = (server: McpServerRow) =>
    confirmAction(
      `Pizza Bot will lose access to ${
        server.status === "connected"
          ? `its ${server.toolCount} tool${server.toolCount === 1 ? "" : "s"}`
          : "this server"
      } immediately. This removes the entry from .mcp.json and can’t be undone.`,
      () => onDelete(server.id),
      {
        title: `Delete “${server.id}”?`,
        confirmLabel: "Delete",
        destructive: true,
        successMessage: `${server.id} deleted`,
      },
    );

  const enablement = selected ? (
    <CapabilityEnablement
      enabled={selected.enabled}
      noun="MCP server"
      blockedReason={blockedReason}
      onChange={(enabled) => onSetEnabled(selected.id, enabled)}
    />
  ) : undefined;
  const reconnectControl = selected ? (
    <McpReconnectControl server={selected} onReconnect={onReconnect} />
  ) : undefined;
  const dependents = selected ? <McpDependents skills={selected.dependentSkills} /> : undefined;

  if (selection?.mode === "new") {
    return <McpServerEditor key="new" server={null} onSave={handleSave} onCancel={leaveEditor} />;
  }
  if (editing && selected && doc === undefined) {
    return (
      <ResourceEditorSkeleton
        sectionLabel={L.mcpSection}
        title={`Edit ${selected.id}`}
        onCancel={() => leaveEditor(false)}
      >
        {enablement}
        {dependents}
      </ResourceEditorSkeleton>
    );
  }
  if (editing && selected && doc) {
    return (
      <McpServerEditor
        key={`${doc.id}:${reloadToken}`}
        server={doc}
        enablement={enablement}
        reconnectControl={reconnectControl}
        dependents={dependents}
        onSave={handleSave}
        onCancel={leaveEditor}
      />
    );
  }
  if (selected) {
    const loadFailed = editing && doc === null;
    return (
      <McpServerCard
        server={selected}
        enablement={enablement}
        reconnectControl={reconnectControl}
        dependents={dependents}
        onBack={backToList}
        actions={
          <McpServerActions
            server={selected}
            deleteBlockedReason={deleteBlockedReason}
            onEdit={() => setSelection({ mode: "edit", id: selected.id })}
            onDelete={() => void requestDelete(selected)}
            onOpenPlugins={onOpenPlugins}
          />
        }
        loadError={
          loadFailed ? (
            <div className="mcp-load-error" role="alert">
              <AlertTriangle size={16} />
              <span className="mcp-load-error-copy">
                Couldn’t load this server’s configuration for editing.
              </span>
              <button
                type="button"
                className="btn-secondary"
                onClick={() => setReloadToken((token) => token + 1)}
              >
                <RefreshCw size={14} /> Retry
              </button>
            </div>
          ) : undefined
        }
      />
    );
  }
  return null;
}
