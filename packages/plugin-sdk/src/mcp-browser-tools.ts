import type { StructuredToolInterface } from "@langchain/core/tools";

/** Browser exports live outside the agent's virtual filesystem. */
export function configureBrowserReadTool(tool: StructuredToolInterface, name: string): void {
  if (name !== "browser_evaluate" && name !== "browser_snapshot") return;
  const rawSchema = tool.schema;
  if (!rawSchema || typeof rawSchema !== "object" || Array.isArray(rawSchema)) return;
  const schema = rawSchema as Record<string, unknown>;
  const properties = schema.properties;
  if (!properties || typeof properties !== "object" || Array.isArray(properties)) return;
  const { filename: _filename, ...inlineProperties } = properties as Record<string, unknown>;
  (tool as { schema: unknown }).schema = {
    ...schema,
    properties: inlineProperties,
    additionalProperties: false,
    ...(Array.isArray(schema.required)
      ? { required: schema.required.filter((key) => key !== "filename") }
      : {}),
  };
  (tool as { description: string }).description +=
    " Return text inline; browser-host file exports are inaccessible to agent filesystem tools." +
    (name === "browser_evaluate"
      ? " Keep each evaluation result under 4,000 characters; page evaluation has no Node.js filesystem access."
      : "");
}
