/** YAML frontmatter splitting for Markdown-defined plugin contributions. */
import { parse as parseYaml } from "yaml";

const FRONTMATTER = /^\uFEFF?---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

/** The parsed frontmatter mapping plus the Markdown body after the closing `---`. */
export interface Frontmatter {
  readonly data: Record<string, unknown>;
  readonly body: string;
  readonly error?: string;
}

/** Recovery is limited to name/description so malformed tool policies cannot be dropped. */
export function splitFrontmatter(markdown: string): Frontmatter {
  const match = FRONTMATTER.exec(markdown);
  if (!match) return { data: {}, body: markdown };
  let data: Record<string, unknown> = {};
  try {
    const parsed = parseYaml(match[1]!) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      data = parsed as Record<string, unknown>;
    }
  } catch (error) {
    return {
      data: parseWithSimpleFieldRecovery(match[1]!),
      body: markdown.slice(match[0].length),
      error: error instanceof Error ? error.message : String(error),
    };
  }
  return { data, body: markdown.slice(match[0].length) };
}

function parseWithSimpleFieldRecovery(yaml: string): Record<string, unknown> {
  const recovered = yaml.replace(
    /^(name|description):[ \t]+([^\r\n]+)$/gm,
    (line: string, key: string, rawValue: string) => {
      const value = rawValue.trim();
      if (!value || /^[[\]{},&*!|>'"%@`]/.test(value)) return line;
      try {
        parseYaml(line);
        return line;
      } catch {
        return `${key}: ${JSON.stringify(value)}`;
      }
    },
  );
  try {
    const parsed = parseYaml(recovered) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

/** Parsed frontmatter keys only; security checks depend on key presence. */
export function parseFrontmatter(markdown: string): Record<string, unknown> {
  return splitFrontmatter(markdown).data;
}
