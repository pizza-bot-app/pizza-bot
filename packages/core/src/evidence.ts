/**
 * Evidence metadata for citation audits. Bodies stay outside checkpoints, and the
 * body cap is applied to the tool output itself so the bytes the model reads and
 * the bytes a reviewer verifies against are the same by construction.
 */

/** ~64k tokens of text; a single tool result larger than this is clipped at source. */
export const MAX_EVIDENCE_BODY_BYTES = 256 * 1024;

export const MAX_EVIDENCE_EXCERPT_CHARS = 280;

/** Bounds one run's ledger; further results are passed through uncitable. */
export const MAX_EVIDENCE_ENTRIES_PER_RUN = 100;

export interface EvidenceEntry {
  id: string;
  threadId: string;
  runId: string;
  /** Qualified `mcp:<server>:<tool>` ref of the call that produced the body. */
  toolRef: string;
  /** Short label for the evidence card. */
  breadcrumb: string;
  /** Display-only; a citation audit reads the body, never the excerpt. */
  excerpt: string;
  /** Size of the tool output before clipping. */
  bytes: number;
  truncated: boolean;
  createdAt: string;
}

export interface NewEvidence {
  threadId: string;
  runId: string;
  toolRef: string;
  breadcrumb: string;
  /** Already clipped to `MAX_EVIDENCE_BODY_BYTES`. */
  body: string;
  /** Pre-clipping size, retained so a reviewer can see the source was partial. */
  bytes: number;
  truncated: boolean;
}

/** Returns undefined when the run's ledger is full, leaving the result uncitable. */
export type EvidenceRecorder = (
  entry: NewEvidence,
) => Promise<EvidenceEntry | undefined>;

function utf8Size(codePoint: number): number {
  if (codePoint < 0x80) return 1;
  if (codePoint < 0x800) return 2;
  if (codePoint < 0x10000) return 3;
  return 4;
}

/**
 * Clips on a code-point boundary, never a byte one: the audit resolves citations by
 * string search, so half a code point is a quote that could never resolve.
 */
export function clipEvidenceBody(
  body: string,
  maxBytes = MAX_EVIDENCE_BODY_BYTES,
): { body: string; bytes: number; truncated: boolean } {
  const bytes = new TextEncoder().encode(body).length;
  if (bytes <= maxBytes) return { body, bytes, truncated: false };
  let used = 0;
  let end = 0;
  for (const char of body) {
    const size = utf8Size(char.codePointAt(0) ?? 0);
    if (used + size > maxBytes) break;
    used += size;
    end += char.length;
  }
  return { body: body.slice(0, end), bytes, truncated: true };
}

export function evidenceExcerpt(
  body: string,
  maxChars = MAX_EVIDENCE_EXCERPT_CHARS,
): string {
  const collapsed = body.replace(/\s+/g, " ").trim();
  return collapsed.length > maxChars
    ? `${collapsed.slice(0, maxChars - 1)}…`
    : collapsed;
}
