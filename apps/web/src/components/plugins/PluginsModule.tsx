import { useRef, useState, type ChangeEvent } from "react";
import {
  BookOpen,
  Cable,
  LoaderCircle,
  Puzzle,
  RefreshCw,
  Trash2,
  Upload,
} from "lucide-react";
import type { PluginInfo } from "@/api-client";
import { L } from "../../lexicon.js";
import { ConfirmationDialog } from "../ConfirmationDialog.js";
import { ResourceModule } from "../ResourceModule.js";
import { ResourceList } from "../ResourceList.js";
import { ResourceSection, ResourceView } from "../ResourceView.js";
import { CapabilityStatusDot, type CapabilityVisualState } from "../CapabilityControls.js";
import { useAppToast } from "../AppToast.js";

export interface PluginsModuleProps {
  plugins: PluginInfo[];
  focusName?: string;
  onImport: (file: File) => Promise<{ name: string }>;
  onDelete: (name: string) => Promise<boolean>;
  onRefresh: (name: string) => Promise<void>;
  onOpenSkills?: () => void;
  onOpenMcpServers?: () => void;
}

const matches = (plugin: PluginInfo, q: string) =>
  plugin.name.toLowerCase().includes(q) ||
  (plugin.displayName ?? "").toLowerCase().includes(q) ||
  (plugin.description ?? "").toLowerCase().includes(q);

function pluginVisualState(plugin: PluginInfo): CapabilityVisualState {
  if (!plugin.status || plugin.status === "loaded") return "active";
  return "unavailable";
}

export function PluginsModule({
  plugins,
  focusName,
  onImport,
  onDelete,
  onRefresh,
  onOpenSkills,
  onOpenMcpServers,
}: PluginsModuleProps) {
  return (
    <ResourceModule
      items={plugins}
      getId={(plugin) => plugin.name}
      focusId={focusName}
      icon={<Puzzle size={18} />}
      emptyIcon={<Puzzle size={40} strokeWidth={1} />}
      title={L.pluginsSection}
      newLabel=""
      canCreate={false}
      emptyText={plugins.length === 0 ? L.noPlugins : "Select a plugin to see what it adds."}
      renderHeaderActions={() => <PluginImportControl onImport={onImport} />}
      renderList={({ selectedId, onSelect }) => (
        <ResourceList
          items={plugins}
          getId={(plugin) => plugin.name}
          selectedId={selectedId}
          onSelect={onSelect}
          matches={matches}
          label={L.pluginsSection}
          searchPlaceholder="Search plugins..."
          emptyTitle={L.noPlugins}
          emptySub="Import a plugin ZIP to add skills and MCP servers."
          noMatchSub={(q) => `No plugins match “${q}”`}
          renderRow={(plugin) => (
            <span className="resource-row-main">
              <span className="resource-row-line1">
                <span className="resource-row-name">{plugin.displayName ?? plugin.name}</span>
                <span className="resource-row-badges">
                  {plugin.version && <span className="plugin-version">v{plugin.version}</span>}
                  <CapabilityStatusDot
                    state={pluginVisualState(plugin)}
                    label={plugin.status ?? "loaded"}
                  />
                </span>
              </span>
              <span className="resource-row-desc">{plugin.description}</span>
            </span>
          )}
        />
      )}
      renderDetail={({ selected, backToList, confirmAction }) =>
        selected ? (
          <PluginView
            plugin={selected}
            onBack={backToList}
            onRefresh={onRefresh}
            onOpenSkills={onOpenSkills}
            onOpenMcpServers={onOpenMcpServers}
            onRemove={() =>
              void confirmAction(
                `Remove “${selected.displayName ?? selected.name}”? Its skills and MCP servers will no longer be available.${
                  selected.linked ? " Only the link is removed; the linked folder stays in place." : ""
                }`,
                () => onDelete(selected.name),
                {
                  title: "Remove plugin?",
                  confirmLabel: "Remove",
                  destructive: true,
                  successMessage: `${selected.displayName ?? selected.name} removed`,
                },
              )
            }
          />
        ) : null
      }
    />
  );
}

function PluginView({
  plugin,
  onBack,
  onRefresh,
  onRemove,
  onOpenSkills,
  onOpenMcpServers,
}: {
  plugin: PluginInfo;
  onBack?: () => void;
  onRefresh: (name: string) => Promise<void>;
  onRemove: () => void;
  onOpenSkills?: () => void;
  onOpenMcpServers?: () => void;
}) {
  const [refreshing, setRefreshing] = useState(false);
  const notify = useAppToast();
  const label = plugin.displayName ?? plugin.name;
  const loaded = !plugin.status || plugin.status === "loaded";
  const contributions = [
    { singular: "skill", plural: "skills", count: plugin.contributions.skills, icon: BookOpen, open: onOpenSkills },
    {
      singular: "MCP server",
      plural: "MCP servers",
      count: plugin.contributions.mcpServers,
      icon: Cable,
      open: onOpenMcpServers,
    },
  ].filter((entry) => entry.count > 0);

  const refresh = async () => {
    if (refreshing) return;
    setRefreshing(true);
    try {
      await onRefresh(plugin.name);
      notify({ title: "Plugin refreshed", description: label, tone: "success" });
    } catch (cause) {
      notify({
        title: "Plugin refresh failed",
        description: cause instanceof Error ? cause.message : undefined,
        tone: "error",
      });
    } finally {
      setRefreshing(false);
    }
  };

  return (
    <ResourceView
      glyph={<Puzzle size={28} strokeWidth={1.5} />}
      name={label}
      badge={plugin.version ? <span className="plugin-version">v{plugin.version}</span> : undefined}
      status={
        <>
          <CapabilityStatusDot state={pluginVisualState(plugin)} label={plugin.status ?? "loaded"} />{" "}
          {loaded ? "Loaded" : plugin.status}
          {plugin.author ? ` · ${plugin.author}` : ""}
        </>
      }
      provenance={
        plugin.linked ? (
          <span>Linked from {plugin.linkTarget ?? "another folder"}</span>
        ) : plugin.removable ? (
          plugin.homepage ? (
            <a className="resource-card-link" href={plugin.homepage} target="_blank" rel="noreferrer">
              Homepage ↗
            </a>
          ) : undefined
        ) : (
          <span>Bundled with Pizza Bot</span>
        )
      }
      backLabel={L.pluginsSection}
      onBack={onBack}
      footer={
        plugin.removable ? (
          <button type="button" className="btn-secondary resource-editor-delete" onClick={onRemove}>
            <Trash2 size={14} /> Remove
          </button>
        ) : undefined
      }
    >
      {plugin.description && <p className="resource-card-lede">{plugin.description}</p>}
      {!loaded && plugin.detail && (
        <p className={`plugin-load-detail ${plugin.status}`}>{plugin.detail}</p>
      )}
      {plugin.materialization && (
        <section className="resource-inline-action">
          <div className="resource-inline-action-copy">
            <div className="resource-inline-action-title">
              {plugin.materialization.state === "synced"
                ? "Synced"
                : plugin.materialization.state === "stale"
                  ? "Using last successful sync"
                  : "Sync failed"}
            </div>
            <div className="resource-inline-action-detail">
              {plugin.materialization.detail ?? "Regenerate this plugin’s skills and MCP servers from its sources."}
            </div>
          </div>
          <button type="button" className="btn-secondary" onClick={() => void refresh()} disabled={refreshing}>
            <RefreshCw className={refreshing ? "spin" : undefined} size={14} /> Refresh
          </button>
        </section>
      )}
      <ResourceSection title="Adds" icon={<Puzzle size={14} />}>
        {contributions.length === 0 ? (
          <p className="resource-card-empty">This plugin doesn’t add any skills or MCP servers.</p>
        ) : (
          <ul className="skill-card-files">
            {contributions.map(({ singular, plural, count, icon: Icon, open }) => (
              <li key={singular} className="skill-card-file">
                <Icon size={13} />
                <button type="button" className="resource-card-link" onClick={open} disabled={!open}>
                  {count} {count === 1 ? singular : plural} ↗
                </button>
              </li>
            ))}
          </ul>
        )}
      </ResourceSection>
    </ResourceView>
  );
}

function PluginImportControl({ onImport }: { onImport: (file: File) => Promise<{ name: string }> }) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [importing, setImporting] = useState(false);
  const [selected, setSelected] = useState<File | null>(null);
  const notify = useAppToast();

  const handleFile = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file || importing) return;
    setSelected(file);
  };

  const importSelected = async () => {
    if (!selected || importing) return;
    setImporting(true);
    try {
      const imported = await onImport(selected);
      notify({ title: "Plugin installed", description: imported.name, tone: "success" });
      setSelected(null);
    } catch (cause) {
      notify({
        title: "Plugin import failed",
        description: cause instanceof Error ? cause.message : undefined,
        tone: "error",
      });
    } finally {
      setImporting(false);
    }
  };

  return (
    <div className="skill-import-control">
      <input
        ref={inputRef}
        hidden
        type="file"
        accept=".zip,application/zip"
        aria-label="Choose a plugin ZIP file"
        onChange={(event) => void handleFile(event)}
      />
      <button
        type="button"
        className="btn-secondary"
        disabled={importing}
        aria-busy={importing}
        onClick={() => inputRef.current?.click()}
      >
        {importing ? <LoaderCircle className="spin" size={15} /> : <Upload size={15} />}
        <span className="skill-import-label">Import</span>
      </button>
      {selected && (
        <ConfirmationDialog
          title="Install plugin"
          message={`Install "${selected.name}"? Plugins may run trusted local code and access files available to your user account.`}
          confirmLabel="Install"
          busy={importing}
          onCancel={() => !importing && setSelected(null)}
          onConfirm={() => void importSelected()}
        />
      )}
    </div>
  );
}
