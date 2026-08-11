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
import { ModuleHeader } from "../ModuleHeader.js";
import { ConfirmationDialog } from "../ConfirmationDialog.js";
import { useAppToast } from "../AppToast.js";

export interface PluginsModuleProps {
  plugins: PluginInfo[];
  onImport: (file: File) => Promise<{ name: string }>;
  onDelete: (name: string) => Promise<boolean>;
  onRefresh: (name: string) => Promise<void>;
}

export function PluginsModule({
  plugins,
  onImport,
  onDelete,
  onRefresh,
}: PluginsModuleProps) {
  const [pending, setPending] = useState<PluginInfo | null>(null);
  const [removing, setRemoving] = useState(false);
  const [refreshing, setRefreshing] = useState<string | null>(null);
  const notify = useAppToast();

  const confirmDelete = async () => {
    if (!pending || removing) return;
    setRemoving(true);
    try {
      await onDelete(pending.name);
      notify({ title: "Plugin removed", description: pending.displayName ?? pending.name, tone: "success" });
      setPending(null);
    } catch (cause) {
      notify({
        title: "Plugin removal failed",
        description: cause instanceof Error ? cause.message : undefined,
        tone: "error",
      });
    } finally {
      setRemoving(false);
    }
  };

  const refreshPlugin = async (plugin: PluginInfo) => {
    if (refreshing) return;
    setRefreshing(plugin.name);
    try {
      await onRefresh(plugin.name);
      notify({
        title: "Plugin refreshed",
        description: plugin.displayName ?? plugin.name,
        tone: "success",
      });
    } catch (cause) {
      notify({
        title: "Plugin refresh failed",
        description: cause instanceof Error ? cause.message : undefined,
        tone: "error",
      });
    } finally {
      setRefreshing(null);
    }
  };

  return (
    <div className="module">
      <ModuleHeader icon={<Puzzle size={18} />} title={L.pluginsSection} count={plugins.length}>
        <span className="module-header-spacer" />
        <PluginImportControl onImport={onImport} />
      </ModuleHeader>
      <div className="plugins-body">
        {plugins.length === 0 ? (
          <div className="module-detail-empty">
            <Puzzle size={40} strokeWidth={1} />
            <p>{L.noPlugins}</p>
          </div>
        ) : (
          <ul className="plugin-list">
            {plugins.map((plugin) => {
              const contributions = [
                { singular: "MCP server", plural: "MCP servers", count: plugin.contributions.mcpServers, icon: Cable },
                { singular: "Skill", plural: "Skills", count: plugin.contributions.skills, icon: BookOpen },
              ].filter((entry) => entry.count > 0);

              return (
                <li className="plugin-card" key={plugin.name}>
                  <div className="plugin-card-icon" aria-hidden="true">
                    <Puzzle size={20} />
                  </div>
                  <div className="plugin-card-main">
                    <div className="plugin-card-heading">
                      <h2>{plugin.displayName ?? plugin.name}</h2>
                      {plugin.version && <span className="plugin-version">v{plugin.version}</span>}
                    </div>
                    {plugin.description && <p>{plugin.description}</p>}
                    <div className="plugin-card-meta">
                      {plugin.author && <span>{plugin.author}</span>}
                      {plugin.homepage && (
                        <a href={plugin.homepage} target="_blank" rel="noreferrer">
                          Homepage
                        </a>
                      )}
                    </div>
                    {contributions.length > 0 && (
                      <div className="plugin-contributions">
                        {contributions.map(({ singular, plural, count, icon: Icon }) => (
                          <span key={singular}>
                            <Icon size={13} /> {count} {count === 1 ? singular : plural}
                          </span>
                        ))}
                      </div>
                    )}
                    {plugin.materialization && (
                      <div
                        className={`plugin-sync-status ${plugin.materialization.state}`}
                        title={plugin.materialization.detail}
                      >
                        {plugin.materialization.state === "synced"
                          ? "Synced"
                          : plugin.materialization.state === "stale"
                            ? "Using last successful sync"
                            : "Sync failed"}
                      </div>
                    )}
                  </div>
                  <div className="plugin-card-actions">
                    {plugin.materialization && (
                      <button
                        type="button"
                        className="plugin-card-action"
                        aria-label={`Refresh ${plugin.displayName ?? plugin.name}`}
                        title="Refresh generated contributions"
                        disabled={refreshing !== null}
                        onClick={() => void refreshPlugin(plugin)}
                      >
                        <RefreshCw
                          className={
                            refreshing === plugin.name ? "spin" : undefined
                          }
                          size={15}
                        />
                      </button>
                    )}
                    {plugin.removable && (
                      <button
                        type="button"
                        className="plugin-card-action plugin-card-remove"
                        aria-label={`Remove ${plugin.displayName ?? plugin.name}`}
                        onClick={() => setPending(plugin)}
                      >
                        <Trash2 size={15} />
                      </button>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>
      {pending && (
        <ConfirmationDialog
          title="Remove plugin"
          message={`Remove "${pending.displayName ?? pending.name}"? Its skills and MCP servers will no longer be available.`}
          confirmLabel="Remove"
          destructive
          busy={removing}
          onCancel={() => !removing && setPending(null)}
          onConfirm={() => void confirmDelete()}
        />
      )}
    </div>
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
