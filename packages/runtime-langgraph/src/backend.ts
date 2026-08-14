/** Routes durable memories and approved local folders outside checkpoint state. */
import { lstat, readdir, realpath } from "node:fs/promises";
import path from "node:path";
import {
  StateBackend,
  FilesystemBackend,
  CompositeBackend,
  type AnyBackendProtocol,
  type BackendProtocolV2,
  type DeleteResult,
  type EditResult,
  type FileDownloadResponse,
  type FileInfo,
  type FileUploadResponse,
  type GlobResult,
  type GrepResult,
  type LsResult,
  type ReadRawResult,
  type ReadResult,
  type WriteResult,
} from "deepagents";
import {
  LOCAL_FOLDER_VIRTUAL_ROOT,
  type LocalFolder,
} from "@pizza-bot/core";

export interface BuildBackendOptions {
  /** Global memory root; when set, `/memories/` is confined to this directory. */
  memoriesDir?: string;
  /** Live settings gate. Defaults to enabled for backwards-compatible callers. */
  memoryEnabled?: () => boolean;
  /** Live grants mounted beneath `/local/<id>/`. */
  localFolders?: () => readonly LocalFolder[];
}

const MEMORY_DISABLED_ERROR = "Durable memory is disabled in Settings.";
const LOCAL_FOLDER_READ_ONLY_ERROR = "Local folders are read-only.";
const LOCAL_FOLDER_DENIED_ERROR = "Local folder access is not allowed.";

function encodeVirtualSegment(segment: string): string {
  return [...new TextEncoder().encode(segment)]
    .map((byte) =>
      byte >= 0x20 &&
      byte <= 0x7e &&
      byte !== 0x25 &&
      byte !== 0x2f &&
      byte !== 0x5c
        ? String.fromCharCode(byte)
        : `%${byte.toString(16).toUpperCase().padStart(2, "0")}`,
    )
    .join("");
}

function encodeBackendPath(backendPath: string): string {
  return backendPath
    .split("/")
    .map((segment) => encodeVirtualSegment(segment))
    .join("/");
}

function decodeVirtualSegment(segment: string): string | undefined {
  let valid = true;
  const decoded = segment.replace(/(?:%[0-9A-Fa-f]{2})+/g, (encoded) => {
    const bytes = encoded
      .slice(1)
      .split("%")
      .map((hex) => Number.parseInt(hex, 16));
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(
        new Uint8Array(bytes),
      );
    } catch {
      valid = false;
      return "";
    }
  });
  if (
    !valid ||
    decoded === "." ||
    decoded === ".." ||
    decoded.includes("/") ||
    decoded.includes("\0") ||
    (path.sep === "\\" && decoded.includes("\\"))
  ) {
    return undefined;
  }
  return decoded;
}

function gatedMemoryBackend(
  backend: FilesystemBackend,
  memoryEnabled: () => boolean,
): AnyBackendProtocol {
  const guarded = new Set([
    "ls",
    "read",
    "readRaw",
    "write",
    "edit",
    "delete",
    "grep",
    "glob",
    "uploadFiles",
    "downloadFiles",
  ]);
  return new Proxy(backend, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      if (
        typeof property !== "string" ||
        typeof value !== "function" ||
        !guarded.has(property)
      ) {
        return value;
      }
      if (property === "uploadFiles") {
        return (files: Array<[string, Uint8Array]>) =>
          memoryEnabled()
            ? Reflect.apply(value, target, [files])
            : files.map(([path]) => ({ path, error: "permission_denied" }));
      }
      if (property === "downloadFiles") {
        return (paths: string[]) =>
          memoryEnabled()
            ? Reflect.apply(value, target, [paths])
            : paths.map((path) => ({
                path,
                content: null,
                error: "permission_denied",
              }));
      }
      return (...args: unknown[]) =>
        memoryEnabled()
          ? Reflect.apply(value, target, args)
          : { error: MEMORY_DISABLED_ERROR };
    },
  }) as AnyBackendProtocol;
}

function pathIsWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative === "" ||
    (!relative.startsWith(`..${path.sep}`) &&
      relative !== ".." &&
      !path.isAbsolute(relative))
  );
}

interface ResolvedLocalFolder {
  folder: LocalFolder;
  folderPath: string;
  backend: FilesystemBackend;
}

class LocalFoldersBackend implements BackendProtocolV2 {
  private readonly backends = new Map<string, FilesystemBackend>();

  constructor(private readonly folders: () => readonly LocalFolder[]) {}

  private folder(id: string): LocalFolder | undefined {
    return this.folders().find((folder) => folder.id === id);
  }

  private backend(folder: LocalFolder): FilesystemBackend {
    const key = `${folder.id}\0${folder.path}`;
    let backend = this.backends.get(key);
    if (!backend) {
      backend = new FilesystemBackend({
        rootDir: folder.path,
        virtualMode: true,
      });
      this.backends.set(key, backend);
    }
    return backend;
  }

  private split(virtualPath: string): {
    folder?: LocalFolder;
    folderPath: string;
  } {
    if (!virtualPath.startsWith("/") || virtualPath.includes("\\")) {
      return { folderPath: "/" };
    }
    const segments = virtualPath.split("/").filter(Boolean);
    const id = segments.shift();
    if (!id || id === "." || id === "..") return { folderPath: "/" };
    const decodedSegments: string[] = [];
    for (const segment of segments) {
      const decoded = decodeVirtualSegment(segment);
      if (decoded === undefined) return { folderPath: "/" };
      decodedSegments.push(decoded);
    }
    const folder = this.folder(id);
    return {
      ...(folder ? { folder } : {}),
      folderPath:
        decodedSegments.length > 0 ? `/${decodedSegments.join("/")}` : "/",
    };
  }

  /**
   * Rejects a grant root that is itself a link. `lstat` decides link-ness because
   * native `realpath` expands Windows 8.3 short names, so string-matching the
   * configured path against its canonical form would deny a legitimate alias
   * such as `C:\Users\RUNNER~1\AppData\Local\Temp\notes`.
   */
  private async canonicalRoot(
    folder: LocalFolder,
  ): Promise<string | undefined> {
    if ((await lstat(folder.path)).isSymbolicLink()) return undefined;
    return realpath(folder.path);
  }

  private async contained(
    folder: LocalFolder,
    folderPath: string,
    allowMissing = false,
  ): Promise<boolean> {
    try {
      const canonicalRoot = await this.canonicalRoot(folder);
      if (!canonicalRoot) return false;
      const candidate = path.resolve(
        canonicalRoot,
        folderPath.replace(/^\/+/, ""),
      );
      if (!pathIsWithin(canonicalRoot, candidate)) return false;
      try {
        return pathIsWithin(canonicalRoot, await realpath(candidate));
      } catch (error) {
        if (
          !allowMissing ||
          (error as NodeJS.ErrnoException).code !== "ENOENT"
        ) {
          return false;
        }
        let ancestor = path.dirname(candidate);
        while (pathIsWithin(canonicalRoot, ancestor)) {
          try {
            return pathIsWithin(canonicalRoot, await realpath(ancestor));
          } catch (ancestorError) {
            if (
              (ancestorError as NodeJS.ErrnoException).code !== "ENOENT" ||
              ancestor === canonicalRoot
            ) {
              return false;
            }
            ancestor = path.dirname(ancestor);
          }
        }
        return false;
      }
    } catch {
      return false;
    }
  }

  private async mutationAllowed(
    folder: LocalFolder,
    folderPath: string,
  ): Promise<boolean> {
    try {
      const canonicalRoot = await this.canonicalRoot(folder);
      if (!canonicalRoot) return false;
      const candidate = path.resolve(
        canonicalRoot,
        folderPath.replace(/^\/+/, ""),
      );
      if (!pathIsWithin(canonicalRoot, candidate)) return false;

      let current = canonicalRoot;
      const relative = path.relative(canonicalRoot, candidate);
      for (const segment of relative.split(path.sep).filter(Boolean)) {
        current = path.join(current, segment);
        try {
          if ((await lstat(current)).isSymbolicLink()) return false;
          if (!pathIsWithin(canonicalRoot, await realpath(current))) return false;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
          return false;
        }
      }
      return true;
    } catch {
      return false;
    }
  }

  private prefix<T extends { path: string }>(folder: LocalFolder, value: T): T {
    return {
      ...value,
      path: `/${folder.id}${encodeBackendPath(value.path)}`,
    };
  }

  private mountedPath(folder: LocalFolder, folderPath: string): string {
    return `${LOCAL_FOLDER_VIRTUAL_ROOT}/${folder.id}${encodeBackendPath(folderPath)}`;
  }

  private async readable(
    virtualPath: string,
    allowMissing = false,
  ): Promise<ResolvedLocalFolder | undefined> {
    const { folder, folderPath } = this.split(virtualPath);
    if (!folder) return undefined;

    let readablePath = folderPath;
    if (!(await this.contained(folder, folderPath))) {
      const normalizedPath = await this.normalizedExistingPath(
        folder,
        folderPath,
      );
      if (normalizedPath) {
        readablePath = normalizedPath;
      } else if (!(allowMissing && await this.contained(
        folder,
        folderPath,
        true,
      ))) {
        return undefined;
      }
    }
    return {
      folder,
      folderPath: readablePath,
      backend: this.backend(folder),
    };
  }

  private async normalizedExistingPath(
    folder: LocalFolder,
    folderPath: string,
  ): Promise<string | undefined> {
    try {
      const canonicalRoot = await this.canonicalRoot(folder);
      if (!canonicalRoot) return undefined;

      let current = canonicalRoot;
      const resolvedSegments: string[] = [];
      for (const requested of folderPath.split("/").filter(Boolean)) {
        const names = await readdir(current);
        const exact = names.find((name) => name === requested);
        const normalizedMatches = exact
          ? [exact]
          : names.filter(
              (name) => name.normalize("NFKC") === requested.normalize("NFKC"),
            );
        if (normalizedMatches.length !== 1) return undefined;

        const matched = normalizedMatches[0]!;
        current = path.join(current, matched);
        if (!pathIsWithin(canonicalRoot, await realpath(current))) {
          return undefined;
        }
        resolvedSegments.push(matched);
      }
      return resolvedSegments.length > 0
        ? `/${resolvedSegments.join("/")}`
        : "/";
    } catch {
      return undefined;
    }
  }

  private async writable(
    virtualPath: string,
  ): Promise<
    | { ok: true; value: ResolvedLocalFolder }
    | { ok: false; error: string }
  > {
    const { folder, folderPath } = this.split(virtualPath);
    if (!folder) return { ok: false, error: LOCAL_FOLDER_DENIED_ERROR };
    if (folder.readOnly) {
      return { ok: false, error: LOCAL_FOLDER_READ_ONLY_ERROR };
    }
    if (!(await this.mutationAllowed(folder, folderPath))) {
      return { ok: false, error: LOCAL_FOLDER_DENIED_ERROR };
    }
    return {
      ok: true,
      value: { folder, folderPath, backend: this.backend(folder) },
    };
  }

  async ls(virtualPath: string): Promise<LsResult> {
    if (virtualPath === "/") {
      return {
        files: this.folders().map((folder): FileInfo => ({
          path: `/${folder.id}/`,
          is_dir: true,
          size: 0,
          modified_at: folder.createdAt,
        })),
      };
    }
    const resolved = await this.readable(virtualPath);
    if (!resolved) return { error: LOCAL_FOLDER_DENIED_ERROR };
    const result = await resolved.backend.ls(resolved.folderPath);
    if (result.error) return result;
    const files: FileInfo[] = [];
    for (const file of result.files ?? []) {
      if (await this.contained(resolved.folder, file.path)) {
        files.push(this.prefix(resolved.folder, file));
      }
    }
    return { files };
  }

  async read(
    virtualPath: string,
    offset?: number,
    limit?: number,
  ): Promise<ReadResult> {
    const resolved = await this.readable(virtualPath, true);
    if (!resolved) return { error: LOCAL_FOLDER_DENIED_ERROR };
    return resolved.backend.read(resolved.folderPath, offset, limit);
  }

  async readRaw(virtualPath: string): Promise<ReadRawResult> {
    const resolved = await this.readable(virtualPath);
    if (!resolved) return { error: LOCAL_FOLDER_DENIED_ERROR };
    return resolved.backend.readRaw(resolved.folderPath);
  }

  async grep(
    pattern: string,
    virtualPath = "/",
    glob?: string | null,
    maxCount?: number | null,
  ): Promise<GrepResult> {
    if (virtualPath !== "/") {
      const resolved = await this.readable(virtualPath);
      if (!resolved) return { error: LOCAL_FOLDER_DENIED_ERROR };
      const result = await resolved.backend.grep(
        pattern,
        resolved.folderPath,
        glob,
        maxCount,
      );
      if (result.error) return result;
      const matches: NonNullable<GrepResult["matches"]> = [];
      for (const match of result.matches ?? []) {
        if (await this.contained(resolved.folder, match.path)) {
          matches.push(this.prefix(resolved.folder, match));
        }
      }
      return {
        matches,
        ...(result.truncated !== undefined
          ? { truncated: result.truncated }
          : {}),
      };
    }

    const matches: NonNullable<GrepResult["matches"]> = [];
    let truncated = false;
    for (const folder of this.folders()) {
      const remaining =
        maxCount == null ? null : Math.max(maxCount - matches.length, 0);
      if (remaining === 0) {
        truncated = true;
        break;
      }
      if (!(await this.contained(folder, "/"))) continue;
      const result = await this.backend(folder).grep(pattern, "/", glob, remaining);
      if (result.error) continue;
      for (const match of result.matches ?? []) {
        if (await this.contained(folder, match.path)) {
          matches.push(this.prefix(folder, match));
        }
      }
      truncated ||= result.truncated === true;
    }
    return { matches, truncated };
  }

  async glob(pattern: string, virtualPath = "/"): Promise<GlobResult> {
    if (virtualPath !== "/") {
      const resolved = await this.readable(virtualPath);
      if (!resolved) return { error: LOCAL_FOLDER_DENIED_ERROR };
      const result = await resolved.backend.glob(pattern, resolved.folderPath);
      if (result.error) return result;
      const files: FileInfo[] = [];
      for (const file of result.files ?? []) {
        if (await this.contained(resolved.folder, file.path)) {
          files.push(this.prefix(resolved.folder, file));
        }
      }
      return {
        files,
        ...(result.truncated !== undefined
          ? { truncated: result.truncated }
          : {}),
      };
    }

    const files: FileInfo[] = [];
    let truncated = false;
    for (const folder of this.folders()) {
      if (!(await this.contained(folder, "/"))) continue;
      const result = await this.backend(folder).glob(pattern, "/");
      if (result.error) continue;
      for (const file of result.files ?? []) {
        if (await this.contained(folder, file.path)) {
          files.push(this.prefix(folder, file));
        }
      }
      truncated ||= result.truncated === true;
    }
    files.sort((left, right) => left.path.localeCompare(right.path));
    return { files, truncated };
  }

  async write(virtualPath: string, content: string): Promise<WriteResult> {
    const resolved = await this.writable(virtualPath);
    if (!resolved.ok) return { error: resolved.error };
    const result = await resolved.value.backend.write(
      resolved.value.folderPath,
      content,
    );
    return result.error
      ? result
      : {
          ...result,
          path: this.mountedPath(
            resolved.value.folder,
            resolved.value.folderPath,
          ),
        };
  }

  async edit(
    virtualPath: string,
    oldString: string,
    newString: string,
    replaceAll?: boolean,
  ): Promise<EditResult> {
    const resolved = await this.writable(virtualPath);
    if (!resolved.ok) return { error: resolved.error };
    const result = await resolved.value.backend.edit(
      resolved.value.folderPath,
      oldString,
      newString,
      replaceAll,
    );
    return result.error
      ? result
      : {
          ...result,
          path: this.mountedPath(
            resolved.value.folder,
            resolved.value.folderPath,
          ),
        };
  }

  async delete(virtualPath: string): Promise<DeleteResult> {
    const resolved = await this.writable(virtualPath);
    if (!resolved.ok) return { error: resolved.error };
    const result = await resolved.value.backend.delete(
      resolved.value.folderPath,
    );
    return result.error
      ? result
      : {
          ...result,
          path: this.mountedPath(
            resolved.value.folder,
            resolved.value.folderPath,
          ),
        };
  }

  async uploadFiles(
    files: Array<[string, Uint8Array]>,
  ): Promise<FileUploadResponse[]> {
    const responses: FileUploadResponse[] = [];
    for (const [virtualPath, content] of files) {
      const resolved = await this.writable(virtualPath);
      if (!resolved.ok) {
        responses.push({ path: virtualPath, error: "permission_denied" });
        continue;
      }
      const [result] = await resolved.value.backend.uploadFiles([
        [resolved.value.folderPath, content],
      ]);
      responses.push({
        path: this.mountedPath(
          resolved.value.folder,
          resolved.value.folderPath,
        ),
        error: result?.error ?? null,
      });
    }
    return responses;
  }

  async downloadFiles(paths: string[]): Promise<FileDownloadResponse[]> {
    return Promise.all(
      paths.map(async (virtualPath) => {
        const resolved = await this.readable(virtualPath, true);
        if (!resolved) {
          return {
            path: virtualPath,
            content: null,
            error: "permission_denied",
          };
        }
        const [result] = await resolved.backend.downloadFiles([
          resolved.folderPath,
        ]);
        return {
          path: this.mountedPath(resolved.folder, resolved.folderPath),
          content: result?.content ?? null,
          error: result?.error ?? null,
        };
      }),
    );
  }
}

export function buildBackend(opts: BuildBackendOptions): AnyBackendProtocol {
  const base = new StateBackend();
  const routes: Record<string, AnyBackendProtocol> = {};
  if (opts.memoriesDir) {
    const durable = new FilesystemBackend({
      rootDir: opts.memoriesDir,
      virtualMode: true,
    });
    routes["/memories/"] = gatedMemoryBackend(
      durable,
      opts.memoryEnabled ?? (() => true),
    );
  }
  if (opts.localFolders) {
    routes["/local/"] = new LocalFoldersBackend(opts.localFolders);
  }
  return Object.keys(routes).length > 0
    ? new CompositeBackend(base, routes)
    : base;
}
