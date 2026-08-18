import { useCallback, useEffect, useState } from "react";
import { ChevronLeft, ChevronRight, Folder } from "lucide-react";
import { Dialog as DialogPrimitive } from "radix-ui";
import type { LocalFolderBrowseResult } from "@pizza-bot/core";
import type { ApiClient } from "@/api-client";

interface BackendDirectoryPickerProps {
  client: ApiClient;
  onCancel: () => void;
  onSelect: (path: string) => void;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function BackendDirectoryPicker({
  client,
  onCancel,
  onSelect,
}: BackendDirectoryPickerProps) {
  const [result, setResult] = useState<LocalFolderBrowseResult>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>();

  const browse = useCallback(async (path?: string) => {
    setLoading(true);
    setError(undefined);
    try {
      setResult(await client.browseLocalFolders(path));
    } catch (cause) {
      setError(message(cause));
    } finally {
      setLoading(false);
    }
  }, [client]);

  useEffect(() => {
    void browse();
  }, [browse]);

  return (
    <DialogPrimitive.Root
      open
      onOpenChange={(open) => {
        if (!open && !loading) onCancel();
      }}
    >
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="sidebar-modal-backdrop" />
        <DialogPrimitive.Content className="sidebar-modal local-folder-picker">
          <DialogPrimitive.Title className="sidebar-modal-title">
            Choose backend folder
          </DialogPrimitive.Title>
          <DialogPrimitive.Description className="sr-only">
            Browse directories made available by the backend operator.
          </DialogPrimitive.Description>

          <div className="local-folder-picker-location">
            {result?.currentPath && (
              <button
                type="button"
                className="icon-btn"
                title="Back"
                aria-label="Back"
                disabled={loading}
                onClick={() => void browse(result.parentPath ?? undefined)}
              >
                <ChevronLeft size={17} />
              </button>
            )}
            <code>{result?.currentPath ?? "Browse roots"}</code>
          </div>

          <div className="local-folder-picker-list">
            {loading && !result ? (
              <div className="local-folder-picker-empty">Loading folders...</div>
            ) : result?.directories.length ? (
              result.directories.map((directory) => (
                <button
                  type="button"
                  className="local-folder-picker-entry"
                  key={directory.path}
                  disabled={loading}
                  onClick={() => void browse(directory.path)}
                >
                  <Folder size={17} aria-hidden="true" />
                  <span>
                    <strong>{directory.name}</strong>
                    <small>{directory.path}</small>
                  </span>
                  <ChevronRight size={16} aria-hidden="true" />
                </button>
              ))
            ) : (
              <div className="local-folder-picker-empty">No subfolders.</div>
            )}
          </div>

          {error && (
            <div className="sidebar-modal-error" role="alert">
              {error}
            </div>
          )}
          <div className="sidebar-modal-actions">
            <DialogPrimitive.Close asChild>
              <button
                type="button"
                className="sidebar-modal-btn"
                disabled={loading}
              >
                Cancel
              </button>
            </DialogPrimitive.Close>
            <button
              type="button"
              className="sidebar-modal-btn primary"
              disabled={loading || !result?.currentPath}
              onClick={() => {
                if (result?.currentPath) onSelect(result.currentPath);
              }}
            >
              Select folder
            </button>
          </div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
