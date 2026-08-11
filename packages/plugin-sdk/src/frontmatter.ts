/** YAML frontmatter splitting for Markdown-defined plugin contributions. */
import { parse as parseYaml } from "yaml";

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

/** The parsed frontmatter mapping plus the Markdown body after the closing `---`. */
export interface Frontmatter {
  readonly data: Record<string, unknown>;
  readonly body: string;
}

/**
 * Splits leading `---`-delimited YAML from its body. A non-mapping or malformed
 * block yields an empty `data` so callers see missing keys, never a throw.
 */
export function splitFrontmatter(markdown: string): Frontmatter {
  const match = FRONTMATTER.exec(markdown);
  if (!match) return { data: {}, body: markdown };
  let data: Record<string, unknown> = {};
  try {
    const parsed = parseYaml(match[1]!) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      data = parsed as Record<string, unknown>;
    }
  } catch {
    data = {};
  }
  return { data, body: markdown.slice(match[0].length) };
}

/** Parsed frontmatter keys only; security checks depend on key presence. */
export function parseFrontmatter(markdown: string): Record<string, unknown> {
  return splitFrontmatter(markdown).data;
}
