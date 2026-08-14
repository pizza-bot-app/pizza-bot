import { lstat, readdir, realpath, stat } from "node:fs/promises";
import { realpathSync, statSync } from "node:fs";
import path from "node:path";
import { Hono } from "hono";
import type {
  CreateLocalFolderInput,
  LocalFolder,
  LocalFolderBrowseEntry,
  LocalFolderBrowseResult,
  LocalFolderList,
} from "@pizza-bot/core";
import type { AgentHost } from "./agent-host.js";

const MAX_PATH_LENGTH = 4096;
const ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

interface LocalFolderRouteOptions {
  configurable: boolean;
  browseRoots?: readonly string[];
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

function slug(value: string): string {
  const normalized = value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48)
    .replace(/-+$/g, "");
  return ID_PATTERN.test(normalized) ? normalized : "folder";
}

function uniqueId(host: AgentHost, desired: string): string {
  const base = slug(desired);
  if (!host.localFolders.hasId(base)) return base;
  for (let suffix = 2; suffix < 10_000; suffix += 1) {
    const candidate = `${base}-${suffix}`;
    if (!host.localFolders.hasId(candidate)) return candidate;
  }
  throw new Error("Unable to allocate a local folder id.");
}

async function canonicalDirectory(input: unknown): Promise<
  | { ok: true; path: string }
  | { ok: false; detail: string }
> {
  if (typeof input !== "string" || input.trim().length === 0) {
    return { ok: false, detail: "path is required" };
  }
  const requested = input.trim();
  if (requested.length > MAX_PATH_LENGTH) {
    return { ok: false, detail: "path is too long" };
  }
  if (!path.isAbsolute(requested)) {
    return { ok: false, detail: "path must be absolute on the backend host" };
  }
  try {
    const canonical = await realpath(requested);
    if (!(await stat(canonical)).isDirectory()) {
      return { ok: false, detail: "path must identify a directory" };
    }
    return { ok: true, path: canonical };
  } catch {
    return { ok: false, detail: "directory does not exist or is not accessible" };
  }
}

// These roots are compared against request paths canonicalized by `fs/promises`
// realpath, so they must use `realpathSync.native`: the JS `realpathSync` keeps
// Windows 8.3 short names that the native one expands, and mixing the two makes
// the containment checks below miss.
function canonicalDataRoot(host: AgentHost): string | undefined {
  if (host.dataRoot === ":memory:" || host.dataRoot.startsWith("file::memory:")) {
    return undefined;
  }
  try {
    return realpathSync.native(host.dataRoot);
  } catch {
    return path.resolve(host.dataRoot);
  }
}

function isProtectedPath(
  dataRoot: string | undefined,
  candidate: string,
): boolean {
  return dataRoot !== undefined && (
    pathIsWithin(dataRoot, candidate) ||
    pathIsWithin(candidate, dataRoot)
  );
}

function overlappingGrantError(
  folders: readonly LocalFolder[],
  candidatePath: string,
  candidateReadOnly: boolean,
): string | undefined {
  let redundantWith: LocalFolder | undefined;
  for (const existing of folders) {
    const existingIsAncestor = pathIsWithin(existing.path, candidatePath);
    const candidateIsAncestor = pathIsWithin(candidatePath, existing.path);
    if (!existingIsAncestor && !candidateIsAncestor) continue;

    if (existing.readOnly === candidateReadOnly) {
      redundantWith ??= existing;
      continue;
    }

    const ancestorReadOnly = existingIsAncestor
      ? existing.readOnly
      : candidateReadOnly;
    if (!ancestorReadOnly) {
      return `Folder grants are additive. This folder overlaps "${existing.label}", and the writable parent would make the read-only folder writable through the parent grant.`;
    }
  }
  return redundantWith
    ? `Folder grants are additive. This folder overlaps "${redundantWith.label}" with the same access, so the additional grant would be redundant.`
    : undefined;
}

function canonicalBrowseRoots(
  host: AgentHost,
  configuredRoots: readonly string[],
): string[] {
  const dataRoot = canonicalDataRoot(host);
  const roots = configuredRoots.map((configured) => {
    if (!path.isAbsolute(configured)) {
      throw new Error(
        `PIZZA_LOCAL_FOLDER_BROWSE_ROOTS path must be absolute: ${configured}`,
      );
    }
    let canonical: string;
    try {
      canonical = realpathSync.native(configured);
      if (!statSync(canonical).isDirectory()) throw new Error("not a directory");
    } catch {
      throw new Error(
        `PIZZA_LOCAL_FOLDER_BROWSE_ROOTS directory is not accessible: ${configured}`,
      );
    }
    if (isProtectedPath(dataRoot, canonical)) {
      throw new Error(
        "PIZZA_LOCAL_FOLDER_BROWSE_ROOTS cannot include the Pizza Bot data directory or its ancestors or descendants",
      );
    }
    return canonical;
  });
  return [...new Set(roots)];
}

export function localFolderRoutes(
  host: AgentHost,
  options: LocalFolderRouteOptions,
): Hono {
  const app = new Hono();
  const configurable = options.configurable;
  const browseRoots = canonicalBrowseRoots(host, options.browseRoots ?? []);
  const dataRoot = canonicalDataRoot(host);

  app.get("/local-folders", (c) => {
    const result: LocalFolderList = {
      folders: host.localFolders.list(),
      configurable,
      browseAvailable: configurable && browseRoots.length > 0,
    };
    return c.json(result);
  });

  app.get("/local-folders/browse", async (c) => {
    if (!configurable || browseRoots.length === 0) {
      return c.json(
        {
          error: "browsing_disabled",
          detail: "Backend folder browsing is not enabled.",
        },
        403,
      );
    }

    const requested = c.req.query("path");
    if (!requested) {
      const result: LocalFolderBrowseResult = {
        currentPath: null,
        parentPath: null,
        directories: browseRoots.map((root) => ({
          name: path.basename(root) || root,
          path: root,
        })),
      };
      return c.json(result);
    }

    const directory = await canonicalDirectory(requested);
    if (!directory.ok) {
      return c.json({ error: "invalid_path", detail: directory.detail }, 400);
    }
    const containingRoot = browseRoots
      .filter((root) => pathIsWithin(root, directory.path))
      .sort((left, right) => right.length - left.length)[0];
    if (!containingRoot) {
      return c.json(
        {
          error: "path_not_browsable",
          detail: "That directory is outside the configured browse roots.",
        },
        403,
      );
    }

    const directories: LocalFolderBrowseEntry[] = [];
    try {
      for (const entry of await readdir(directory.path, { withFileTypes: true })) {
        if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
        const candidate = path.join(directory.path, entry.name);
        try {
          if ((await lstat(candidate)).isSymbolicLink()) continue;
          const canonical = await realpath(candidate);
          if (
            path.relative(path.resolve(candidate), canonical) === "" &&
            pathIsWithin(containingRoot, canonical)
          ) {
            directories.push({ name: entry.name, path: canonical });
          }
        } catch {
          continue;
        }
      }
    } catch {
      return c.json(
        { error: "directory_unreadable", detail: "Directory cannot be listed." },
        400,
      );
    }
    directories.sort((left, right) =>
      left.name.localeCompare(right.name, undefined, { sensitivity: "base" })
    );
    const result: LocalFolderBrowseResult = {
      currentPath: directory.path,
      parentPath:
        directory.path === containingRoot ? null : path.dirname(directory.path),
      directories,
    };
    return c.json(result);
  });

  app.post("/local-folders", async (c) => {
    if (!configurable) {
      return c.json(
        {
          error: "configuration_disabled",
          detail: "Local folders must be configured by the backend operator.",
        },
        403,
      );
    }
    const raw = (await c.req.json().catch(() => ({}))) as Partial<CreateLocalFolderInput>;
    if (raw.readOnly !== undefined && typeof raw.readOnly !== "boolean") {
      return c.json(
        { error: "invalid_access", detail: "readOnly must be a boolean" },
        400,
      );
    }
    const directory = await canonicalDirectory(raw.path);
    if (!directory.ok) {
      return c.json({ error: "invalid_path", detail: directory.detail }, 400);
    }

    if (isProtectedPath(dataRoot, directory.path)) {
      return c.json(
        {
          error: "protected_path",
          detail: "The Pizza Bot data directory cannot be exposed as a local folder.",
        },
        400,
      );
    }
    if (host.localFolders.hasPath(directory.path)) {
      return c.json(
        { error: "already_exists", detail: "That directory is already configured." },
        409,
      );
    }
    const readOnly = raw.readOnly ?? true;
    const overlapError = overlappingGrantError(
      host.localFolders.list(),
      directory.path,
      readOnly,
    );
    if (overlapError) {
      return c.json(
        { error: "overlapping_grant", detail: overlapError },
        409,
      );
    }

    const label = path.basename(directory.path) || "Folder";
    const folder = host.localFolders.create({
      id: uniqueId(host, label),
      label,
      path: directory.path,
      readOnly,
    });
    return c.json(folder, 201);
  });

  app.delete("/local-folders/:id", (c) => {
    if (!configurable) {
      return c.json(
        {
          error: "configuration_disabled",
          detail: "Local folders must be configured by the backend operator.",
        },
        403,
      );
    }
    const id = c.req.param("id");
    if (!ID_PATTERN.test(id)) {
      return c.json({ error: "invalid_id" }, 400);
    }
    return c.json({ deleted: host.localFolders.delete(id) });
  });

  return app;
}
