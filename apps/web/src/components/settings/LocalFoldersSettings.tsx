import { useEffect, useState } from "react";
import { FolderOpen, LockKeyhole, Plus, Trash2 } from "lucide-react";
import type { LocalFolder, LocalFolderList } from "@pizza-bot/core";
import type { ApiClient } from "@/api-client";
import { ConfirmationDialog } from "../ConfirmationDialog.js";
import { BackendDirectoryPicker } from "./BackendDirectoryPicker.js";

interface LocalFoldersSettingsProps {
  client: ApiClient;
  canPickDirectory: boolean;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function LocalFoldersSettings({
  client,
  canPickDirectory,
}: LocalFoldersSettingsProps) {
  const [snapshot, setSnapshot] = useState<LocalFolderList>();
  const [folderPath, setFolderPath] = useState("");
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [showBackendPicker, setShowBackendPicker] = useState(false);
  const [confirmAdd, setConfirmAdd] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState<LocalFolder>();

  const load = async () => {
    setSnapshot(await client.listLocalFolders());
  };

  useEffect(() => {
    let active = true;
    void client
      .listLocalFolders()
      .then((next) => {
        if (active) setSnapshot(next);
      })
      .catch((cause) => {
        if (active) setError(message(cause));
      });
    return () => {
      active = false;
    };
  }, [client]);

  const pickDirectory = async () => {
    setError(undefined);
    if (!canPickDirectory || !window.__PIZZA_LOCAL_FOLDERS__) {
      setShowBackendPicker(true);
      return;
    }
    try {
      const selected = await window.__PIZZA_LOCAL_FOLDERS__.pickDirectory();
      if (!selected) return;
      setFolderPath(selected);
    } catch (cause) {
      setError(message(cause));
    }
  };

  const add = async () => {
    setBusy(true);
    setError(undefined);
    try {
      await client.createLocalFolder({ path: folderPath.trim() });
      await load();
      setFolderPath("");
      setConfirmAdd(false);
    } catch (cause) {
      setError(message(cause));
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!confirmRemove) return;
    setBusy(true);
    setError(undefined);
    try {
      await client.deleteLocalFolder(confirmRemove.id);
      await load();
      setConfirmRemove(undefined);
    } catch (cause) {
      setError(message(cause));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <section className="settings-group settings-stack">
        <h2 className="settings-group-title">Local folders</h2>
        {snapshot?.folders.length ? (
          <div className="local-folder-list">
            {snapshot.folders.map((folder) => (
              <div className="settings-row local-folder-row" key={folder.id}>
                <FolderOpen size={18} aria-hidden="true" />
                <div className="settings-row-text">
                  <div className="settings-row-label">{folder.label}</div>
                  <div className="settings-row-hint local-folder-path">
                    {folder.path}
                  </div>
                  <code className="local-folder-virtual">{folder.virtualPath}</code>
                </div>
                <span className="local-folder-read-only">
                  <LockKeyhole size={13} /> Read only
                </span>
                {snapshot.configurable && (
                  <button
                    type="button"
                    className="icon-btn local-folder-remove"
                    title={`Remove ${folder.label}`}
                    aria-label={`Remove ${folder.label}`}
                    onClick={() => setConfirmRemove(folder)}
                  >
                    <Trash2 size={15} />
                  </button>
                )}
              </div>
            ))}
          </div>
        ) : snapshot ? (
          <div className="settings-connection-notice">No local folders configured.</div>
        ) : (
          <div className="settings-connection-notice">Loading local folders...</div>
        )}

        {snapshot && !snapshot.configurable && (
          <div className="settings-connection-notice">
            Folder access is managed by the backend operator.
          </div>
        )}
      </section>

      {snapshot?.configurable && (
        <section className="settings-group">
          <h2 className="settings-group-title">Add folder</h2>
          <div className="settings-row settings-row-stacked">
            <label className="field">
              <span className="field-label">Folder path on backend</span>
              <div className="local-folder-path-input">
                <input
                  value={folderPath}
                  onChange={(event) => setFolderPath(event.target.value)}
                  placeholder={
                    navigator.platform.startsWith("Win")
                      ? "C:\\Users\\name\\Documents"
                      : "/home/name/Documents"
                  }
                />
                {(
                  (canPickDirectory && window.__PIZZA_LOCAL_FOLDERS__) ||
                  snapshot.browseAvailable
                ) && (
                  <button
                    type="button"
                    className="btn-secondary"
                    onClick={() => void pickDirectory()}
                  >
                    <FolderOpen size={15} /> Browse
                  </button>
                )}
              </div>
            </label>
            <div className="local-folder-form-actions">
              <button
                type="button"
                className="btn-primary"
                disabled={!folderPath.trim()}
                onClick={() => setConfirmAdd(true)}
              >
                <Plus size={15} /> Add folder
              </button>
            </div>
          </div>
        </section>
      )}

      {showBackendPicker && (
        <BackendDirectoryPicker
          client={client}
          onCancel={() => setShowBackendPicker(false)}
          onSelect={(selected) => {
            setFolderPath(selected);
            setShowBackendPicker(false);
          }}
        />
      )}

      {error && (
        <div className="settings-group schedule-editor-error" role="alert">
          {error}
        </div>
      )}

      {confirmAdd && (
        <ConfirmationDialog
          title="Allow folder access?"
          message="Pizza Bot and delegated workers will be able to read every accessible file in this folder during conversations and background runs. File contents may be sent to your configured model providers."
          confirmLabel="Allow read access"
          busy={busy}
          error={error}
          onCancel={() => {
            setConfirmAdd(false);
            setError(undefined);
          }}
          onConfirm={() => void add()}
        />
      )}

      {confirmRemove && (
        <ConfirmationDialog
          title={`Remove ${confirmRemove.label}?`}
          message="Pizza Bot will immediately lose access to this folder. Content already included in conversations or sent to a model is not removed."
          confirmLabel="Remove"
          destructive
          busy={busy}
          error={error}
          onCancel={() => {
            setConfirmRemove(undefined);
            setError(undefined);
          }}
          onConfirm={() => void remove()}
        />
      )}
    </>
  );
}
