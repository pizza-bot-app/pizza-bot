/** Parses a plugin ZIP into a manifest-validated bundle ready to write under the install directory. */
import { pluginManifestSchema, type PluginManifest } from "@pizza-bot/plugin-sdk";
import { ArchiveError, readZipArchive, safeArchivePath } from "./archive.js";

export const MAX_PLUGIN_ARCHIVE_BYTES = 50 * 1024 * 1024;
export const MAX_PLUGIN_UNCOMPRESSED_BYTES = 200 * 1024 * 1024;
export const MAX_PLUGIN_ARCHIVE_FILES = 2048;

const MANIFEST_REL = ".claude-plugin/plugin.json";

export class PluginImportError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "PluginImportError";
  }
}

export interface ImportedPluginFile {
  path: string;
  content: Uint8Array;
}

export interface ImportedPlugin {
  name: string;
  manifest: PluginManifest;
  files: ImportedPluginFile[];
}

export async function parsePluginArchive(bytes: Uint8Array): Promise<ImportedPlugin> {
  let archiveFiles;
  try {
    archiveFiles = await readZipArchive(bytes, {
      maxArchiveBytes: MAX_PLUGIN_ARCHIVE_BYTES,
      maxUncompressedBytes: MAX_PLUGIN_UNCOMPRESSED_BYTES,
      maxFiles: MAX_PLUGIN_ARCHIVE_FILES,
    });
  } catch (error) {
    if (error instanceof ArchiveError) throw new PluginImportError(error.code, error.message);
    throw error;
  }

  const manifestFiles = archiveFiles.filter((file) => file.path.endsWith(MANIFEST_REL));
  if (manifestFiles.length !== 1) {
    throw new PluginImportError(
      "invalid_bundle",
      `The archive must contain exactly one ${MANIFEST_REL} file.`,
    );
  }

  const manifestFile = manifestFiles[0]!;
  const root = manifestFile.path.slice(0, manifestFile.path.length - MANIFEST_REL.length).replace(/\/$/, "");
  const files: ImportedPluginFile[] = archiveFiles.map((file) => {
    if (root && !file.path.startsWith(`${root}/`)) {
      throw new PluginImportError(
        "invalid_bundle",
        `Archive file "${file.path}" is outside the plugin directory.`,
      );
    }
    const path = root ? file.path.slice(root.length + 1) : file.path;
    if (!safeArchivePath(path)) {
      throw new PluginImportError("unsafe_path", `Archive file "${file.path}" has an unsafe path.`);
    }
    return { path, content: new Uint8Array(file.content) };
  });

  let manifest: PluginManifest;
  try {
    const raw = new TextDecoder("utf-8", { fatal: true }).decode(manifestFile.content);
    manifest = pluginManifestSchema.parse(JSON.parse(raw));
  } catch (error) {
    throw new PluginImportError(
      "invalid_manifest",
      `${MANIFEST_REL} is not a valid plugin manifest: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }

  return {
    name: manifest.name,
    manifest,
    files: files.sort((a, b) => a.path.localeCompare(b.path)),
  };
}
