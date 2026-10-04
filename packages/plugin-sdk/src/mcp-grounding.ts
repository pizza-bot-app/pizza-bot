/**
 * The `_grounding` citation argument: injected into an MCP tool's schema for the
 * model, stripped before dispatch so the server never sees it. Citations must
 * survive on the persisted tool call, so stripping always clones.
 */

import { GROUNDING_ARGUMENT } from "@pizza-bot/core";

type JsonSchema = Record<string, unknown>;

function isJsonSchema(value: unknown): value is JsonSchema {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * A span addresses its own text by quoting it, not by offset: models reliably quote
 * themselves verbatim and reliably miscount characters. It addresses its evidence by the
 * line numbers the evidence was handed to it with, which it copies rather than counts.
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
            "A span of your own drafted wording, copied character for character out of what " +
            "you wrote in that argument — never the evidence's phrasing. Long enough to " +
            "appear only once in the argument.",
        },
        cites: {
          type: "array",
          description:
            "The evidence the span is based on: one entry per evidence result it draws from, " +
            "more than one when the sentence joins facts from several lookups.",
          items: {
            type: "object",
            properties: {
              evidenceId: {
                type: "string",
                description: "Id of an evidence entry the span draws on. Never invent an id.",
              },
              lines: {
                type: "array",
                items: { type: "integer" },
                description:
                  "The [n] numbers of the lines in that entry the span is based on: every line " +
                  "a reviewer must read to check it, and no others.",
              },
            },
            required: ["evidenceId", "lines"],
            additionalProperties: false,
          },
        },
      },
      required: ["arg", "text", "cites"],
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
    "  - `text`: your own drafted words, copied character for character out of that argument",
    "    and long enough to be unique in it. An exact search of the argument must find it, so",
    "    quote the sentence you wrote, never the evidence's wording.",
    "  - `cites`: each evidence entry the span draws on, as `{evidenceId, lines}` — the entry's",
    "    id (never invent one) and the [n] numbers of its lines the span rests on: every line a",
    "    reviewer must read to check it, and no others. A sentence joining facts from two",
    "    lookups cites both entries.",
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
