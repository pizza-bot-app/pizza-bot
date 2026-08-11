/** Attachments stay by-reference in checkpoints and are inlined only for model calls. */

export const ATTACHMENT_URL_SCHEME = "attachment:";

export function attachmentUrl(id: string): string {
  return `${ATTACHMENT_URL_SCHEME}//${id}`;
}

/** Returns undefined for non-attachment URLs and empty attachment IDs. */
export function parseAttachmentUrl(url: string): string | undefined {
  if (!url.startsWith(`${ATTACHMENT_URL_SCHEME}//`)) return undefined;
  const id = url.slice(`${ATTACHMENT_URL_SCHEME}//`.length);
  return id.length > 0 ? id : undefined;
}

/**
 * Bedrock Converse accepts these image and document formats. Both the picker and
 * upload boundary use this allowlist so unsupported files fail before model calls.
 */
export const BEDROCK_IMAGE_MIME_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"] as const;

export const BEDROCK_DOCUMENT_MIME_TYPES = [
  "application/pdf",
  "text/csv",
  "text/plain",
  "text/markdown",
  "text/html",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
] as const;

export const SUPPORTED_ATTACHMENT_MIME_TYPES: readonly string[] = [
  ...BEDROCK_IMAGE_MIME_TYPES,
  ...BEDROCK_DOCUMENT_MIME_TYPES,
];

const SUPPORTED_SET = new Set<string>(SUPPORTED_ATTACHMENT_MIME_TYPES);
const IMAGE_SET = new Set<string>(BEDROCK_IMAGE_MIME_TYPES);

export function isSupportedAttachmentType(mimeType: string): boolean {
  return SUPPORTED_SET.has(mimeType.toLowerCase());
}

export function isImageAttachmentType(mimeType: string): boolean {
  return IMAGE_SET.has(mimeType.toLowerCase());
}

const EXTENSION_MIME_TYPES: Readonly<Record<string, string>> = {
  txt: "text/plain",
  md: "text/markdown",
  markdown: "text/markdown",
  csv: "text/csv",
  html: "text/html",
  htm: "text/html",
  pdf: "application/pdf",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  doc: "application/msword",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xls: "application/vnd.ms-excel",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
};

/**
 * Bedrock rejects the canonical MIME types for these text files. Normalize them
 * to `text/plain` while preserving the original filename.
 */
const TEXT_LIKE_EXTENSIONS = new Set<string>([
  "json",
  "yaml",
  "yml",
  "log",
  "toml",
  "ini",
  "cfg",
  "conf",
  "env",
  "xml",
  "tsv",
  "ts",
  "tsx",
  "js",
  "jsx",
  "mjs",
  "cjs",
  "py",
  "rb",
  "go",
  "rs",
  "java",
  "kt",
  "c",
  "h",
  "cpp",
  "hpp",
  "cs",
  "php",
  "swift",
  "sh",
  "bash",
  "zsh",
  "sql",
]);

function extensionOf(filename: string): string {
  const dot = filename.lastIndexOf(".");
  return dot >= 0 ? filename.slice(dot + 1).toLowerCase() : "";
}

/**
 * Recognized text extensions normalize to `text/plain`. Unknown extensions
 * return undefined.
 */
export function inferAttachmentMimeType(filename: string): string | undefined {
  const ext = extensionOf(filename);
  return EXTENSION_MIME_TYPES[ext] ?? (TEXT_LIKE_EXTENSIONS.has(ext) ? "text/plain" : undefined);
}

/**
 * A supported browser MIME wins; otherwise infer from the filename.
 * Returns undefined when neither value is accepted.
 */
export function resolveAttachmentMediaType(mediaType: string | undefined, filename: string): string | undefined {
  if (mediaType && isSupportedAttachmentType(mediaType)) return mediaType.toLowerCase();
  return inferAttachmentMimeType(filename);
}

/**
 * Transport ceiling enforced before buffering. Provider category limits may be
 * lower and are enforced separately.
 */
export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;

export interface AttachmentLimits {
  imageBytes: number;
  documentBytes: number;
}

/** Bedrock Converse per-file limits: 3.75 MB images and 4.5 MB documents. */
export const BEDROCK_ATTACHMENT_LIMITS: AttachmentLimits = {
  imageBytes: Math.floor(3.75 * 1024 * 1024),
  documentBytes: Math.floor(4.5 * 1024 * 1024),
};

export function maxBytesForMediaType(mediaType: string, limits: AttachmentLimits): number {
  return isImageAttachmentType(mediaType) ? limits.imageBytes : limits.documentBytes;
}

/**
 * Includes extensions because browsers may report text files as empty or
 * octet-stream. Server-side validation remains authoritative.
 */
export const ATTACHMENT_ACCEPT = [
  ...SUPPORTED_ATTACHMENT_MIME_TYPES,
  ...Object.keys(EXTENSION_MIME_TYPES).map((ext) => `.${ext}`),
  ...[...TEXT_LIKE_EXTENSIONS].map((ext) => `.${ext}`),
].join(",");

export interface AttachmentMeta {
  id: string;
  url: string;
  mediaType: string;
  filename: string;
  sizeBytes: number;
}

export interface ResolvedAttachment {
  data: string;
  mediaType: string;
  name?: string;
}

/**
 * Unknown or deleted IDs return undefined so callers can omit the block without
 * failing the run.
 */
export type AttachmentResolver = (id: string) => Promise<ResolvedAttachment | undefined>;
