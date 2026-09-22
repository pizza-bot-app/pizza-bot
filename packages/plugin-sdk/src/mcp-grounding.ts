/**
 * The `_grounding` citation argument: injected into an MCP tool's schema for the
 * model, stripped before dispatch so the server never sees it. Citations must
 * survive on the persisted tool call, so stripping always clones.
 */

type JsonSchema = Record<string, unknown>;

export const GROUNDING_ARGUMENT = "_grounding";

function isJsonSchema(value: unknown): value is JsonSchema {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * A span addresses its text by quoting it, not by offset: models reliably quote
 * themselves verbatim and reliably miscount characters, and an in-bounds but
 * misplaced offset renders as provenance that looks checked and is not.
 */
function groundingSchema(verifiedArgs: readonly string[]): JsonSchema {
  const argList = verifiedArgs.map((arg) => `\`${arg}\``).join(", ");
  return {
    type: "array",
    description:
      `Provenance for the prose in ${argList}. Stripped before delivery; the recipient never sees it.`,
    items: {
      type: "object",
      properties: {
        arg: {
          type: "string",
          enum: [...verifiedArgs],
          description: "Which argument the cited span appears in.",
        },
        text: {
          type: "string",
          description:
            "The cited span copied verbatim from that argument — character for character, " +
            "long enough to appear only once in it.",
        },
        evidenceId: {
          type: "string",
          description: "Id of the evidence entry supporting the span. Never invent an id.",
        },
      },
      required: ["arg", "text", "evidenceId"],
      additionalProperties: false,
    },
  };
}

/** Appended to the tool description, since a directive in a tool result reads as prompt injection. */
export function groundingContract(verifiedArgs: readonly string[]): string {
  const argList = verifiedArgs.map((arg) => `\`${arg}\``).join(", ");
  return [
    `Provenance contract: every factual claim in ${argList} that came from an evidence entry MUST`,
    `be cited in \`${GROUNDING_ARGUMENT}\`, one entry per cited span:`,
    "  - `arg`: which argument the span is in.",
    "  - `text`: the span copied verbatim from that argument, long enough to be unique in it.",
    "  - `evidenceId`: the id of the evidence entry it came from. Never invent an id.",
    "Cite only spans an evidence entry actually supports; leave your own connective prose uncited.",
  ].join("\n");
}

/**
 * Inject the citation argument into an already-adapted schema. Injecting into the
 * *source* schema instead is silently lost: `restoreFlattenedUnions` builds from
 * the adapted schema and only rewrites properties already present there.
 */
export function injectGroundingArgument(
  schema: unknown,
  verifiedArgs: readonly string[],
): unknown {
  if (verifiedArgs.length === 0 || !isJsonSchema(schema)) return schema;
  if (!isJsonSchema(schema.properties)) return schema;
  // A server owning the name wins; overwriting would break its own contract.
  if (GROUNDING_ARGUMENT in schema.properties) return schema;
  // Nothing to cite into means the argument would be dead weight in the prompt.
  const present = verifiedArgs.filter((arg) => arg in (schema.properties as JsonSchema));
  if (present.length === 0) return schema;
  return {
    ...schema,
    properties: {
      ...schema.properties,
      [GROUNDING_ARGUMENT]: groundingSchema(present),
    },
  };
}

/** The declared `verifiedArgs` that the tool's schema actually has properties for. */
export function resolvableVerifiedArgs(
  schema: unknown,
  verifiedArgs: readonly string[],
): string[] {
  if (!isJsonSchema(schema) || !isJsonSchema(schema.properties)) return [];
  return verifiedArgs.filter((arg) => arg in (schema.properties as JsonSchema));
}

/**
 * Remove the citation argument from a tool's arguments, cloning rather than
 * mutating: the graph reuses this object as the persisted tool call, which is
 * where the reviewer's citations live.
 */
export function stripGroundingArgument<T>(args: T): T {
  if (!isJsonSchema(args) || !(GROUNDING_ARGUMENT in args)) return args;
  const { [GROUNDING_ARGUMENT]: _dropped, ...rest } = args;
  return rest as T;
}

/**
 * Strip the citation argument from a tool invocation's arguments. The graph hands
 * the tool a wrapped `ToolCall` (`{type, id, name, args}`), so the payload is one
 * level down; a plain arguments object is also accepted for direct callers.
 */
export function stripGroundingFromInvocation(input: unknown): unknown {
  if (!isJsonSchema(input)) return input;
  if (isJsonSchema(input.args)) {
    const args = stripGroundingArgument(input.args);
    return args === input.args ? input : { ...input, args };
  }
  return stripGroundingArgument(input);
}
