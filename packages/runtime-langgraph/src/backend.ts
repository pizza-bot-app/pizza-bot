/** Routes sandboxed memories separately from ephemeral DeepAgents files. */
import { StateBackend, FilesystemBackend, CompositeBackend, type AnyBackendProtocol } from "deepagents";

export interface BuildBackendOptions {
  /** Global memory root; when set, `/memories/` is confined to this directory. */
  memoriesDir?: string;
  /** Live settings gate. Defaults to enabled for backwards-compatible callers. */
  memoryEnabled?: () => boolean;
}

const MEMORY_DISABLED_ERROR = "Durable memory is disabled in Settings.";

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

export function buildBackend(opts: BuildBackendOptions): AnyBackendProtocol {
  const base = new StateBackend();
  if (!opts.memoriesDir) return base;
  const durable = new FilesystemBackend({
    rootDir: opts.memoriesDir,
    virtualMode: true,
  });
  return new CompositeBackend(base, {
    "/memories/": gatedMemoryBackend(
      durable,
      opts.memoryEnabled ?? (() => true),
    ),
  });
}
