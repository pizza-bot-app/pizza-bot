/** Pure types for designed subagents: each owns its prompt, model, tool grants, skills, and approvals. */
import { z } from "zod";
import type { HitlDecision } from "./protocol-types.js";

export const BUILTIN_EVAL_TOOL_REF = "builtin:eval";

export const BUILTIN_EVAL_TOOL_DESCRIPTION = "Evaluate calculations and deterministic expressions.";

/** Offered only while a shell sandbox is configured (`PIZZA_SANDBOX`). */
export const BUILTIN_EXECUTE_TOOL_REF = "builtin:execute";

export const BUILTIN_EXECUTE_TOOL_DESCRIPTION = "Run shell commands in this conversation's sandbox VM.";

const BUILTIN_TOOL_REFS: ReadonlySet<string> = new Set([BUILTIN_EVAL_TOOL_REF, BUILTIN_EXECUTE_TOOL_REF]);

/** An absent `model` and this value both mean the conversation's model. */
export const INHERIT_MODEL = "inherit";

export const toolRefSchema = z
  .string()
  .refine(
    (ref) => BUILTIN_TOOL_REFS.has(ref) || /^mcp:[^:\s]+:[^:\s]+$/.test(ref),
    "Tool ref must be builtin:eval, builtin:execute, or mcp:<server>:<tool> (wildcards allowed)",
  );

export const interruptToolRefSchema = toolRefSchema.refine(
  (ref) => ref.startsWith("mcp:"),
  "HITL approval can only target MCP tools",
);

export const interruptConfigSchema = z.union([
  z.boolean(),
  z.object({
    allowedDecisions: z.array(
      z.enum(["approve", "edit", "reject", "respond"]) satisfies z.ZodType<HitlDecision>,
    ).min(1),
  }),
]);

export type InterruptConfig =
  | boolean
  | { allowedDecisions: HitlDecision[] };

export type InterruptOnPolicy = Record<string, InterruptConfig>;

export type AgentSource = "plugin" | "builtin" | "user";

export interface AgentCatalogEntry {
  id: string;
  name: string;
  description: string;
  systemPrompt: string;
  /** Provider-qualified model id; absent inherits the conversation's model. */
  model?: string;
  /** `mcp:<server>:<tool>` refs (wildcards allowed) and builtins: the agent's whole tool surface. */
  declaredTools: string[];
  /** Skill ids mounted on this agent's own skills middleware. */
  skills: string[];
  /** Tool calls that must pause for a durable human decision before execution. */
  interruptOn: InterruptOnPolicy;
  source: AgentSource;
  /** Shipped source hidden by this user override, if any. */
  overrides?: Exclude<AgentSource, "user">;
  pluginName?: string;
}

export type AgentCatalog = Map<string, AgentCatalogEntry>;

export interface McpDependencyInfo {
  id: string;
  enabled: boolean;
  status: "missing" | "loading" | "retrying" | "connected" | "error" | "crashed" | "disabled";
}

export interface AgentInfo extends Omit<AgentCatalogEntry, "systemPrompt"> {
  enabled?: boolean;
  status?: "disabled" | "loading" | "ready" | "unavailable";
  statusDetail?: string;
  mcpDependencies?: McpDependencyInfo[];
}

export function agentInfoOf(entry: AgentCatalogEntry): AgentInfo {
  const { systemPrompt: _systemPrompt, ...info } = entry;
  return info;
}

export function agentMcpServerIds(agent: Pick<AgentCatalogEntry, "declaredTools">): string[] {
  const servers = new Set<string>();
  for (const ref of agent.declaredTools) {
    const [kind, server, tool] = ref.split(":");
    if (kind === "mcp" && server && tool) servers.add(server);
  }
  return [...servers];
}

function stringList(raw: unknown): string[] {
  const items = Array.isArray(raw)
    ? raw
    : typeof raw === "string"
      ? raw.split(/[,\s]+/)
      : [];
  const seen = new Set<string>();
  for (const item of items) {
    if (typeof item === "string" && item.trim()) seen.add(item.trim());
  }
  return [...seen];
}

/**
 * Reads `tools` as a list or a comma/whitespace string; non-string entries are
 * dropped, and readiness rejects malformed refs instead of this parser.
 */
export function parseDeclaredTools(frontmatter: Record<string, unknown>): string[] {
  return stringList(frontmatter.tools);
}

export function parseAgentSkills(frontmatter: Record<string, unknown>): string[] {
  return stringList(frontmatter.skills);
}

export function parseAgentModel(frontmatter: Record<string, unknown>): string | undefined {
  const raw = frontmatter.model;
  if (typeof raw !== "string") return undefined;
  const model = raw.trim();
  return model && model !== INHERIT_MODEL ? model : undefined;
}

const HITL_DECISIONS = new Set<HitlDecision>(["approve", "edit", "reject", "respond"]);
const DEFAULT_DECISIONS: HitlDecision[] = ["approve", "edit", "reject"];

/**
 * Invalid refs are dropped. A valid ref whose decision list holds no valid
 * decision still pauses, with the default decisions: an approval must fail closed.
 */
export function parseInterruptOn(frontmatter: Record<string, unknown>): InterruptOnPolicy {
  const raw = frontmatter.interruptOn;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const parsed: InterruptOnPolicy = {};
  for (const [ref, config] of Object.entries(raw)) {
    if (!interruptToolRefSchema.safeParse(ref).success) continue;
    if (typeof config === "boolean") {
      parsed[ref] = config;
      continue;
    }
    const decisions = config && typeof config === "object" && !Array.isArray(config)
      ? (config as { allowedDecisions?: unknown }).allowedDecisions
      : undefined;
    const allowedDecisions = Array.isArray(decisions)
      ? decisions.filter(
          (decision): decision is HitlDecision =>
            typeof decision === "string" && HITL_DECISIONS.has(decision as HitlDecision),
        )
      : [];
    parsed[ref] = { allowedDecisions: allowedDecisions.length > 0 ? allowedDecisions : DEFAULT_DECISIONS };
  }
  return parsed;
}
