import { useEffect, useState } from "react";
import {
  FolderOpen,
  LockKeyhole,
  PencilLine,
  Plus,
  Trash2,
} from "lucide-react";
import { Dialog as DialogPrimitive } from "radix-ui";
import type { LocalFolder, LocalFolderList } from "@pizza-bot/core";
import { ApiError, type ApiClient } from "@/api-client";
import { ConfirmationDialog } from "../ConfirmationDialog.js";
import { BackendDirectoryPicker } from "./BackendDirectoryPicker.js";

interface LocalFoldersSettingsProps {
  client: ApiClient;
  canPickDirectory: boolean;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

interface AddFolderDialogProps {
  client: ApiClient;
  canPickDirectory: boolean;
  browseAvailable: boolean;
  onAdded: () => Promise<void>;
  onClose: () => void;
}

function AddFolderDialog({
  client,
  canPickDirectory,
  browseAvailable,
  onAdded,
  onClose,
}: AddFolderDialogProps) {
  const [path, setPath] = useState("");
  const [readOnly, setReadOnly] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [dataRootWarning, setDataRootWarning] = useState(false);
  const [showBackendPicker, setShowBackendPicker] = useState(false);

  const updatePath = (nextPath: string) => {
    setPath(nextPath);
    setDataRootWarning(false);
  };

  const pickDirectory = async () => {
    setError(undefined);
    if (!canPickDirectory || !window.__PIZZA_LOCAL_FOLDERS__) {
      setShowBackendPicker(true);
      return;
    }
    try {
      const selected = await window.__PIZZA_LOCAL_FOLDERS__.pickDirectory();
      if (!selected) return;
      updatePath(selected);
    } catch (cause) {
      setError(message(cause));
    }
  };

  const add = async () => {
    setBusy(true);
    setError(undefined);
    try {
      await client.createLocalFolder({
        path: path.trim(),
        readOnly,
        ...(dataRootWarning ? { acknowledgeDataRootAccess: true } : {}),
      });
      await onAdded();
      onClose();
    } catch (cause) {
      if (
        cause instanceof ApiError &&
        cause.code === "data_root_access_requires_confirmation"
      ) {
        setDataRootWarning(true);
      } else {
        setError(message(cause));
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <DialogPrimitive.Root
        open
        onOpenChange={(open) => {
          if (!open && !busy) onClose();
        }}
      >
        <DialogPrimitive.Portal>
          <DialogPrimitive.Overlay className="sidebar-modal-backdrop" />
          <DialogPrimitive.Content className="sidebar-modal">
            <DialogPrimitive.Title className="sidebar-modal-title">
              Add local folder
            </DialogPrimitive.Title>
            <DialogPrimitive.Description className="sr-only">
              Choose a backend folder and the access Pizza Bot has to it.
            </DialogPrimitive.Description>

            <div className="local-folder-dialog-path">
              <input
                aria-label="Folder path on backend"
                value={path}
                onChange={(event) => updatePath(event.target.value)}
                placeholder="Absolute path on backend"
              />
              {((canPickDirectory && window.__PIZZA_LOCAL_FOLDERS__) ||
                browseAvailable) && (
                <button
                  type="button"
                  className="btn-secondary"
                  onClick={() => void pickDirectory()}
                >
                  <FolderOpen size={15} /> Browse
                </button>
              )}
            </div>

            <div
              role="radiogroup"
              aria-label="Folder access"
              className="local-folder-access-options"
            >
              <label
                className={`local-folder-access-option${readOnly ? " selected" : ""}`}
              >
                <input
                  type="radio"
                  name="local-folder-access"
                  checked={readOnly}
                  onChange={() => setReadOnly(true)}
                />
                <LockKeyhole size={15} aria-hidden="true" />
                <span>
                  <strong>Read only</strong>
                  <small>The agent can read files in this folder.</small>
                </span>
              </label>
              <label
                className={`local-folder-access-option${readOnly ? "" : " selected write"}`}
              >
                <input
                  type="radio"
                  name="local-folder-access"
                  checked={!readOnly}
                  onChange={() => setReadOnly(false)}
                />
                <PencilLine size={15} aria-hidden="true" />
                <span>
                  <strong>Read and write</strong>
                  <small>The agent can also create, modify, and delete files.</small>
                </span>
              </label>
            </div>

            {readOnly ? (
              <p className="local-folder-read-note">
                File contents may be sent to your model provider.
              </p>
            ) : (
              <p className="local-folder-write-warning" role="note">
                File contents may be sent to your model provider. Assume the
                agent may modify or delete anything in this folder.
              </p>
            )}

            {dataRootWarning && (
              <p className="local-folder-write-warning" role="note">
                This folder overlaps Pizza Bot&apos;s private data. The agent may
                access conversations, memories, attachments, configuration, logs,
                and stored credentials
                {readOnly
                  ? "."
                  : ", and may corrupt or delete application state."}
              </p>
            )}

            {error && (
              <div className="sidebar-modal-error" role="alert">
                {error}
              </div>
            )}
            <div className="sidebar-modal-actions">
              <DialogPrimitive.Close asChild>
                <button type="button" className="sidebar-modal-btn" disabled={busy}>
                  Cancel
                </button>
              </DialogPrimitive.Close>
              <button
                type="button"
                className="sidebar-modal-btn primary"
                disabled={busy || !path.trim()}
                onClick={() => void add()}
              >
                {dataRootWarning ? "Add anyway" : "Add folder"}
              </button>
            </div>
          </DialogPrimitive.Content>
        </DialogPrimitive.Portal>
      </DialogPrimitive.Root>

      {showBackendPicker && (
        <BackendDirectoryPicker
          client={client}
          onCancel={() => setShowBackendPicker(false)}
          onSelect={(selected) => {
            updatePath(selected);
            setShowBackendPicker(false);
          }}
        />
      )}
    </>
  );
}

export function LocalFoldersSettings({
  client,
  canPickDirectory,
}: LocalFoldersSettingsProps) {
  const [snapshot, setSnapshot] = useState<LocalFolderList>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [showAddDialog, setShowAddDialog] = useState(false);
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

  const groups = snapshot
    ? [
        {
          title: "Read only",
          folders: snapshot.folders.filter((folder) => folder.readOnly),
        },
        {
          title: "Read and write",
          folders: snapshot.folders.filter((folder) => !folder.readOnly),
        },
      ]
    : [];

  return (
    <>
      <section className="settings-group settings-stack">
        <h2 className="settings-group-title">Local folders</h2>
        {snapshot?.folders.length ? (
          groups.map(({ title, folders }) => folders.length > 0 && (
            <div className="local-folder-group" key={title}>
              <h3 className="local-folder-group-title">{title}</h3>
              <div className="local-folder-list">
                {folders.map((folder) => (
                  <div
                    className="settings-row local-folder-row"
                    key={folder.id}
                    title={folder.virtualPath}
                  >
                    <FolderOpen size={18} aria-hidden="true" />
                    <div className="settings-row-text">
                      <div className="settings-row-label">{folder.label}</div>
                      <div className="local-folder-path">{folder.path}</div>
                    </div>
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
            </div>
          ))
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

        {snapshot?.configurable && (
          <div className="local-folder-add-cta">
            <button
              type="button"
              className="btn-secondary"
              onClick={() => {
                setError(undefined);
                setShowAddDialog(true);
              }}
            >
              <Plus size={15} /> Add folder
            </button>
          </div>
        )}
      </section>

      {error && (
        <div className="settings-group schedule-editor-error" role="alert">
          {error}
        </div>
      )}

      {showAddDialog && snapshot && (
        <AddFolderDialog
          client={client}
          canPickDirectory={canPickDirectory}
          browseAvailable={snapshot.browseAvailable}
          onAdded={load}
          onClose={() => setShowAddDialog(false)}
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
