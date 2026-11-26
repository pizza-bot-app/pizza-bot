/** Declarative graph specs: the serializable shape a trigger runs and the UI renders. */
import { z } from "zod";

export const GRAPH_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const KEY_PATTERN = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
// `start`/`end` are edge markers, `input` holds the run input, and a `messages`
// key would be decoded as a chat transcript by the protocol state projection.
// Object.prototype names are refused too: state channels are keyed by plain objects.
const RESERVED_KEYS = new Set(["input", "start", "end", "messages"]);

export const GRAPH_START = "start";
export const GRAPH_END = "end";

const key = z
  .string()
  .regex(KEY_PATTERN, "must start with a letter and use only letters, digits, and _")
  .refine((value) => !RESERVED_KEYS.has(value) && !(value in Object.prototype), "is reserved");

const conditionSchema = z.object({
  path: z.string().min(1),
  op: z.enum(["eq", "neq", "gt", "gte", "lt", "lte", "contains", "exists", "truthy"]),
  value: z.unknown().optional(),
});

const base = { id: key, label: z.string().max(120).optional() };

const nodeSchema = z.discriminatedUnion("type", [
  z.object({ ...base, type: z.literal("transform"), set: z.record(z.string(), z.unknown()) }),
  z.object({
    ...base,
    type: z.literal("branch"),
    cases: z.array(z.object({ when: conditionSchema, to: z.string() })).min(1),
    default: z.string(),
  }),
  z.object({
    ...base,
    type: z.literal("tool"),
    tool: z.string().min(1),
    args: z.record(z.string(), z.unknown()).optional(),
    output: key,
  }),
  z.object({
    ...base,
    type: z.literal("llm"),
    prompt: z.string().min(1),
    system: z.string().optional(),
    model: z.string().optional(),
    output: key,
  }),
  z.object({
    ...base,
    type: z.literal("agent"),
    prompt: z.string().min(1),
    model: z.string().optional(),
    /** Runs this agent definition instead of the assistant; its pinned model wins over `model`. */
    agentId: z.string().min(1).max(64).optional(),
    output: key,
  }),
  z.object({ ...base, type: z.literal("human"), prompt: z.string().min(1), output: key }),
]);

const specSchema = z.object({
  id: z.string().regex(GRAPH_ID_PATTERN, "must be lowercase letters, digits, - or _"),
  name: z.string().min(1).max(120),
  description: z.string().max(2000).optional(),
  nodes: z.array(nodeSchema).min(1),
  edges: z.array(z.object({ from: z.string(), to: z.string() })),
});

export type GraphCondition = z.infer<typeof conditionSchema>;
export type GraphNodeSpec = z.infer<typeof nodeSchema>;
export type GraphNodeType = GraphNodeSpec["type"];
export type GraphEdgeSpec = z.infer<typeof specSchema>["edges"][number];
export type GraphSpec = z.infer<typeof specSchema>;

export type GraphSpecParse =
  | { ok: true; spec: GraphSpec }
  | { ok: false; errors: string[] };

export function parseGraphSpec(raw: unknown): GraphSpecParse {
  const parsed = specSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false,
      errors: parsed.error.issues.map((issue) =>
        issue.path.length > 0 ? `${issue.path.join(".")}: ${issue.message}` : issue.message,
      ),
    };
  }
  const errors = graphTopologyErrors(parsed.data);
  return errors.length > 0 ? { ok: false, errors } : { ok: true, spec: parsed.data };
}

/** Successors of each node; a branch's successors come from its cases and default. */
export function graphSuccessors(spec: GraphSpec): Map<string, string[]> {
  const next = new Map<string, string[]>([[GRAPH_START, []]]);
  for (const node of spec.nodes) {
    next.set(node.id, node.type === "branch" ? branchTargets(node) : []);
  }
  for (const edge of spec.edges) next.get(edge.from)?.push(edge.to);
  return next;
}

/** State keys a run writes, in declaration order. `input` is always first. */
export function graphStateKeys(spec: GraphSpec): string[] {
  const keys = new Set<string>(["input"]);
  for (const node of spec.nodes) {
    if (node.type === "transform") for (const k of Object.keys(node.set)) keys.add(k);
    else if (node.type !== "branch") keys.add(node.output);
  }
  return [...keys];
}

function branchTargets(node: Extract<GraphNodeSpec, { type: "branch" }>): string[] {
  return [...new Set([...node.cases.map((c) => c.to), node.default])];
}

function graphTopologyErrors(spec: GraphSpec): string[] {
  const errors: string[] = [];
  const nodes = new Map<string, GraphNodeSpec>();
  for (const node of spec.nodes) {
    if (nodes.has(node.id)) errors.push(`duplicate node id "${node.id}"`);
    nodes.set(node.id, node);
  }
  const isTarget = (id: string) => id === GRAPH_END || nodes.has(id);
  for (const node of spec.nodes) {
    if (node.type !== "transform") continue;
    for (const k of Object.keys(node.set)) {
      const problem = key.safeParse(k).error?.issues[0]?.message;
      if (problem) errors.push(`node "${node.id}" sets "${k}", which ${problem}`);
    }
  }
  // LangGraph rejects a node named after a state channel.
  for (const stateKey of graphStateKeys(spec)) {
    if (nodes.has(stateKey)) errors.push(`node id "${stateKey}" is also a state key`);
  }

  for (const edge of spec.edges) {
    if (edge.from !== GRAPH_START && !nodes.has(edge.from)) {
      errors.push(`edge from unknown node "${edge.from}"`);
    } else if (nodes.get(edge.from)?.type === "branch") {
      errors.push(`branch "${edge.from}" routes through its cases, not edges`);
    }
    if (!isTarget(edge.to)) errors.push(`edge to unknown node "${edge.to}"`);
  }
  for (const node of nodes.values()) {
    if (node.type !== "branch") continue;
    for (const target of branchTargets(node)) {
      if (!isTarget(target)) errors.push(`branch "${node.id}" targets unknown node "${target}"`);
    }
  }
  if (errors.length > 0) return errors;

  const next = graphSuccessors(spec);
  if ((next.get(GRAPH_START) ?? []).length === 0) errors.push("no edge leaves start");
  for (const node of nodes.values()) {
    if ((next.get(node.id) ?? []).length === 0) errors.push(`node "${node.id}" has no outgoing edge`);
  }
  const reached = new Set<string>();
  const queue = [GRAPH_START];
  while (queue.length > 0) {
    const id = queue.pop()!;
    for (const to of next.get(id) ?? []) {
      if (!reached.has(to)) {
        reached.add(to);
        queue.push(to);
      }
    }
  }
  for (const id of nodes.keys()) {
    if (!reached.has(id)) errors.push(`node "${id}" is unreachable from start`);
  }
  return errors;
}
