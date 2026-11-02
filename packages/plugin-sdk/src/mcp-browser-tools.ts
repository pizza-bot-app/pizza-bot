import type { StructuredToolInterface } from "@langchain/core/tools";

/** Browser exports live outside the agent's virtual filesystem. */
export function configureBrowserReadTool(tool: StructuredToolInterface, name: string): void {
  if (name !== "browser_evaluate" && name !== "browser_snapshot") return;
  const schema = tool.schema as Record<string, unknown>;
  const properties = schema.properties;
  if (!properties || typeof properties !== "object" || Array.isArray(properties)) return;
  const { filename: _filename, ...inlineProperties } = properties as Record<string, unknown>;
  (tool as { schema: unknown }).schema = {
    ...schema, properties: inlineProperties, additionalProperties: false,
    ...(Array.isArray(schema.required) ? { required: schema.required.filter((key) => key !== "filename") } : {}),
  };
  (tool as { description: string }).description +=
    " Return source text inline in small reads (at most 4,000 characters). " +
    "The filename export option is not supported here: browser host files are not " +
    "accessible through agent read_file/glob/ls. Omit filename; do not search the " +
    "agent filesystem for browser outputs. For long documents return section " +
    "summaries, source URLs and partial-coverage notes rather than the full text. " +
    (name === "browser_evaluate" ? "Evaluation runs in the web page, without Node require or filesystem access." : "");
}
