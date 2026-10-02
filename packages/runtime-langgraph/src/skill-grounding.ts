/**
 * Applies a skill's `verifiedArgs` to the tools it equips: the citation argument is
 * per-(skill, tool), so tools are wrapped rather than mutated — one tool instance is
 * shared by every skill that declares it.
 */
import {
  groundingContract,
  injectGroundingArgument,
  resolvableVerifiedArgs,
  stripGroundingArgument,
} from "@pizza-bot/plugin-sdk";

interface ToolLike {
  name: string;
  description?: string;
  schema?: unknown;
}

interface QualifiedInterruptConfig {
  allowedDecisions: string[];
  verifiedArgs?: string[];
  argsSchema?: Record<string, unknown>;
  description?: unknown;
}

function isToolLike(value: unknown): value is ToolLike {
  return typeof value === "object" && value !== null && typeof (value as ToolLike).name === "string";
}

/**
 * Overrides the HITL middleware's default description, which serializes the whole
 * argument object and would print raw citation JSON at the reviewer. Only grounded
 * tools get this; elsewhere the upstream default stands.
 */
function approvalDescription(toolCall: unknown): string {
  const call = toolCall as { name?: unknown; args?: unknown } | undefined;
  const name = typeof call?.name === "string" ? call.name : "tool";
  const args = stripGroundingArgument(
    typeof call?.args === "object" && call.args !== null ? (call.args as Record<string, unknown>) : {},
  );
  return `Tool: ${name}\nArguments:\n${JSON.stringify(args, null, 2)}`;
}

/**
 * Augments equipped tools with the citation argument and rewrites the per-tool HITL
 * config to carry the same schema for edit validation. `verifiedArgs` is consumed
 * here and never reaches the upstream config.
 */
export function applySkillGrounding(
  tools: readonly unknown[],
  interruptOn: Record<string, unknown> | undefined,
): {
  tools: unknown[];
  interruptOn: Record<string, unknown> | undefined;
  /** Executable names that actually carry the citation argument. */
  groundedTools: string[];
} {
  if (!interruptOn) return { tools: [...tools], interruptOn, groundedTools: [] };

  const groundedSchemas = new Map<string, { schema: unknown; verifiedArgs: string[] }>();
  const rewritten: Record<string, unknown> = {};

  for (const [execName, rawConfig] of Object.entries(interruptOn)) {
    if (typeof rawConfig !== "object" || rawConfig === null) {
      rewritten[execName] = rawConfig;
      continue;
    }
    const { verifiedArgs, ...config } = rawConfig as QualifiedInterruptConfig;
    const tool = tools.find((candidate) => isToolLike(candidate) && candidate.name === execName);
    const resolvable =
      verifiedArgs && isToolLike(tool) ? resolvableVerifiedArgs(tool.schema, verifiedArgs) : [];

    if (resolvable.length === 0) {
      rewritten[execName] = config;
      continue;
    }
    const schema = injectGroundingArgument((tool as ToolLike).schema, resolvable);
    groundedSchemas.set(execName, { schema, verifiedArgs: resolvable });
    rewritten[execName] = {
      ...config,
      argsSchema: schema as Record<string, unknown>,
      description: approvalDescription,
    };
  }

  if (groundedSchemas.size === 0) {
    return { tools: [...tools], interruptOn: rewritten, groundedTools: [] };
  }

  return {
    tools: tools.map((tool) => {
      if (!isToolLike(tool)) return tool;
      const grounded = groundedSchemas.get(tool.name);
      return grounded ? withGroundingSchema(tool, grounded.schema, grounded.verifiedArgs) : tool;
    }),
    interruptOn: rewritten,
    groundedTools: [...groundedSchemas.keys()],
  };
}

/** Overlays the augmented schema and the contract without touching the shared instance. */
function withGroundingSchema(
  tool: ToolLike,
  schema: unknown,
  verifiedArgs: readonly string[],
): ToolLike {
  const description = [tool.description?.trim(), groundingContract(verifiedArgs)]
    .filter((part) => part)
    .join("\n\n");
  return new Proxy(tool, {
    get(target, property, receiver) {
      if (property === "schema") return schema;
      if (property === "description") return description;
      return Reflect.get(target, property, receiver);
    },
  });
}
