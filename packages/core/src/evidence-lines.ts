/**
 * Splits a tool result into numbered lines a citation can name. The numbered text is both
 * what the model reads and what the ledger stores, so a cited line number means the same
 * bytes to the model, the judge and the reviewer.
 */

/** A line longer than this is wrapped: one line of a minified payload is not a citation. */
const MAX_LINE_CHARS = 1_000;

/** "rev. 2026-02" and "e.g. Visa" end in a period without ending a sentence. */
const ABBREVIATION =
  /(?:^|[\s(])(?:rev|e\.g|i\.e|etc|vs|approx|no|dept|inc|ltd|st|mr|mrs|ms|dr|jr|sr|fig|jan|feb|mar|apr|jun|jul|aug|sep|sept|oct|nov|dec)\.$/i;
const SENTENCE_BREAK = /(?<=[.!?])\s+(?=[A-Z0-9"'(])/;

function isScalar(value: unknown): boolean {
  return value === null || ["string", "number", "boolean"].includes(typeof value);
}

/**
 * A nested object whose fields are all scalars stays on one line, so a row keeps its own date
 * and status together; splitting it would let a claim borrow one row's status for another's
 * date. The top-level object always splits by field, so a flat record stays citable per field.
 */
function jsonLines(node: unknown, path: string, out: string[]): void {
  if (Array.isArray(node)) {
    node.forEach((item, index) => {
      const at = `${path}[${index}]`;
      if (isScalar(item)) out.push(`${at}: ${JSON.stringify(item)}`);
      else jsonLines(item, at, out);
    });
    return;
  }
  if (node !== null && typeof node === "object") {
    const entries = Object.entries(node);
    if (path && entries.length > 0 && entries.every(([, value]) => isScalar(value))) {
      const fields = entries.map(([key, value]) => `${key}=${JSON.stringify(value)}`).join(", ");
      out.push(`${path}: {${fields}}`);
      return;
    }
    for (const [key, value] of entries) {
      const at = path ? `${path}.${key}` : key;
      if (isScalar(value)) out.push(`${at}: ${JSON.stringify(value)}`);
      else jsonLines(value, at, out);
    }
    return;
  }
  out.push(`${path}: ${JSON.stringify(node)}`);
}

function wrap(line: string): string[] {
  const out: string[] = [];
  for (let start = 0; start < line.length; start += MAX_LINE_CHARS) {
    out.push(line.slice(start, start + MAX_LINE_CHARS));
  }
  return out;
}

function textLines(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const sentences: string[] = [];
    for (const piece of line.split(SENTENCE_BREAK)) {
      const sentence = piece.trim();
      if (!sentence) continue;
      const last = sentences[sentences.length - 1];
      if (last !== undefined && ABBREVIATION.test(last)) sentences[sentences.length - 1] = `${last} ${sentence}`;
      else sentences.push(sentence);
    }
    for (const sentence of sentences) out.push(...wrap(sentence));
  }
  return out;
}

export function evidenceLines(text: string): string[] {
  const trimmed = text.trim();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (parsed !== null && typeof parsed === "object") {
        const out: string[] = [];
        jsonLines(parsed, "", out);
        return out.flatMap(wrap);
      }
    } catch {
      // A clipped or malformed payload is read as text.
    }
  }
  return textLines(text);
}

/** The numbered form the model reads and the ledger stores: one `[n] line` per line. */
export function numberEvidenceLines(text: string): string {
  return evidenceLines(text)
    .map((line, index) => `[${index + 1}] ${line}`)
    .join("\n");
}

const NUMBERED = /^\[(\d+)\] (.*)$/;

/** Reads a stored body back into its lines, by number. */
export function parseEvidenceLines(body: string): Map<number, string> {
  const lines = new Map<number, string>();
  for (const raw of body.split("\n")) {
    const match = NUMBERED.exec(raw);
    if (match) lines.set(Number(match[1]), match[2]!);
  }
  return lines;
}
