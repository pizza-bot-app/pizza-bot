export const LOCAL_FOLDER_VIRTUAL_ROOT = "/local";

export interface LocalFolder {
  /** Stable path segment under `/local/`. */
  id: string;
  label: string;
  /** Absolute canonical path on the backend host. */
  path: string;
  virtualPath: string;
  readOnly: true;
  createdAt: string;
}

export interface LocalFolderList {
  folders: LocalFolder[];
  /** Whether this backend accepts folder changes over its authenticated API. */
  configurable: boolean;
  /** Whether the backend exposes a restricted server-side directory picker. */
  browseAvailable: boolean;
}

export interface CreateLocalFolderInput {
  path: string;
}

export interface LocalFolderBrowseEntry {
  name: string;
  path: string;
}

export interface LocalFolderBrowseResult {
  /** Null while listing the operator-configured browse roots. */
  currentPath: string | null;
  /** Null when Back should return to the browse-root list. */
  parentPath: string | null;
  directories: LocalFolderBrowseEntry[];
}
