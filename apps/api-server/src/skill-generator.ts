import type { InterruptOnPolicy } from "@pizza-bot/core";

export interface SkillDraft {
  name: string;
  description: string;
  body: string;
}

export interface AgentDraft extends SkillDraft {
  declaredTools: string[];
  interruptOn: InterruptOnPolicy;
}

export interface GeneratorTool {
  ref: string;
  description: string;
}

const JSON_ONLY = [
  "Return ONLY a single JSON object — no markdown, no prose, no code fences —",
  "with exactly these fields:",
];

// Bedrock Converse rejects the tool_choice required by structured output, so the
// callers parse and validate raw JSON instead.
export function buildSkillGeneratorPrompt(): string {
  return [
    "You author Agent Skills for a chat app called Pizza Bot. A skill is a",
    "reusable, step-by-step playbook an agent reads on demand when a task matches",
    "it. Given a short description of what the user wants a skill to do, produce",
    "a complete skill definition.",
    "",
    ...JSON_ONLY,
    "",
    '- "name": a short, human-friendly skill name (2–4 words).',
    '- "description": one or two sentences describing what the skill does and',
    "  when to use it. This is the DISCOVERY signal an agent reads to decide",
    "  whether to load this skill, so make it specific.",
    '- "body": the SKILL.md instructions in Markdown (roughly 100–400 words):',
    "  a clear, numbered or sectioned playbook covering the goal and the steps.",
    "",
    "Output must be valid JSON parseable by JSON.parse.",
  ].join("\n");
}

export function buildAgentGeneratorPrompt(tools: readonly GeneratorTool[]): string {
  const toolList =
    tools.length > 0
      ? tools.map(({ ref, description }) => `- ${ref}: ${description}`).join("\n")
      : '(no tools are currently available — return an empty "tools" array)';

  return [
    "You design specialist subagents for a chat app called Pizza Bot. The main",
    "assistant delegates a request to a subagent when the request matches its",
    "description; the subagent works in its own context with only its own tools",
    "and returns one report. Given a short description of the specialist the user",
    "wants, produce a complete subagent definition.",
    "",
    ...JSON_ONLY,
    "",
    '- "name": a short, human-friendly name (2–4 words).',
    '- "description": one or two sentences saying what the subagent handles, what',
    "  it decides for itself, and what it returns. This is the ROUTING signal the",
    "  main assistant reads, so make it specific.",
    '- "body": the subagent\'s system prompt in Markdown (roughly 100–400 words):',
    "  its goal, its procedure, how to use its tools, and the shape of its report.",
    '- "tools": an array of tool reference strings the subagent needs, chosen ONLY',
    "  from the available tools listed below. Pick the minimal set that fits, but",
    "  do not omit a tool the workflow needs to take action or retrieve information.",
    "  Use a `mcp:server:*` wildcard only when the subagent genuinely needs most of",
    "  a server's tools. If none are relevant, use [].",
    "",
    "Available tools:",
    toolList,
    "",
    "Choose tools only from that list. Do not invent tool names. Output must be",
    "valid JSON parseable by JSON.parse.",
  ].join("\n");
}

// Models may wrap the requested JSON in a fence or surrounding prose.
export function parseSkillDraftJson(text: string): Record<string, unknown> {
  const trimmed = text.trim();
  const unfenced = trimmed
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "")
    .trim();

  const candidates = [unfenced, trimmed];
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // A failed direct parse is expected; the brace scan below handles surrounding prose.
    }
  }

  const start = unfenced.indexOf("{");
  const end = unfenced.lastIndexOf("}");
  if (start !== -1 && end > start) {
    const parsed = JSON.parse(unfenced.slice(start, end + 1));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  }
  throw new Error("model reply did not contain a JSON object");
}

export function normalizeSkillDraft(raw: Record<string, unknown>): SkillDraft {
  const str = (v: unknown): string => (typeof v === "string" ? v : "");
  const name = str(raw.name).trim() || "New Skill";
  return {
    name,
    description: str(raw.description).trim() || name,
    body: str(raw.body).trim(),
  };
}

export function normalizeAgentDraft(
  raw: Record<string, unknown>,
  tools: readonly GeneratorTool[],
): AgentDraft {
  const allowed = new Set(tools.map(({ ref }) => ref));
  const declaredTools = Array.isArray(raw.tools)
    ? [...new Set(raw.tools.filter((t): t is string => typeof t === "string" && allowed.has(t)))]
    : [];
  const interruptOn: InterruptOnPolicy = {};
  for (const ref of declaredTools) {
    if (requiresApproval(ref)) {
      interruptOn[ref] = { allowedDecisions: ["approve", "edit", "reject"] };
    }
  }
  const str = (v: unknown): string => (typeof v === "string" ? v : "");
  const name = str(raw.name).trim() || "New Agent";
  return {
    name,
    description: str(raw.description).trim() || name,
    body: str(raw.body).trim(),
    declaredTools,
    interruptOn,
  };
}

const SIDE_EFFECT_TOOL_TOKENS = new Set([
  "add",
  "append",
  "approve",
  "archive",
  "assign",
  "buy",
  "cancel",
  "close",
  "commit",
  "copy",
  "create",
  "decrement",
  "delete",
  "deploy",
  "destroy",
  "disable",
  "dispatch",
  "edit",
  "enable",
  "execute",
  "follow",
  "forward",
  "grant",
  "increment",
  "insert",
  "install",
  "invite",
  "launch",
  "like",
  "lock",
  "merge",
  "modify",
  "move",
  "mutate",
  "patch",
  "pay",
  "post",
  "prepend",
  "provision",
  "publish",
  "push",
  "purchase",
  "put",
  "react",
  "reject",
  "remove",
  "rename",
  "replace",
  "reopen",
  "reply",
  "restart",
  "restore",
  "revoke",
  "run",
  "schedule",
  "send",
  "set",
  "share",
  "sign",
  "start",
  "stop",
  "submit",
  "subscribe",
  "terminate",
  "transfer",
  "trigger",
  "unassign",
  "unfollow",
  "uninstall",
  "unlock",
  "unsubscribe",
  "update",
  "upload",
  "upsert",
  "vote",
  "write",
]);

/** Generated wildcards require approval; exact MCP refs are classified by action verb. */
export function requiresApproval(ref: string): boolean {
  if (!ref.startsWith("mcp:")) return false;
  const toolName = ref.split(":").at(-1) ?? "";
  if (toolName === "*") return true;
  const tokens = toolName
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
  return tokens.some((token) => SIDE_EFFECT_TOOL_TOKENS.has(token));
}
