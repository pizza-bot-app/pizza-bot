/** Framework-free graph-run projection: spec topology plus per-node status folded from v3 `tasks` frames and checkpoint history. */
import {
  GRAPH_END,
  GRAPH_START,
  type GraphCondition,
  type GraphHumanRequest,
  type GraphNodeType,
  type GraphSpec,
} from "@pizza-bot/core";

export type GraphNodeStatus = "idle" | "pending" | "running" | "paused" | "done" | "error";

export interface PendingInterrupt {
  id: string;
  value: unknown;
}

/** One node's latest task, plus how many tasks it has run. */
export interface GraphNodeRun {
  nodeId: string;
  taskId: string;
  status: GraphNodeStatus;
  runs: number;
  input?: unknown;
  result?: unknown;
  error?: string;
  interrupts: PendingInterrupt[];
}

export type GraphNodeRuns = Record<string, GraphNodeRun>;

export type TaskFrame =
  | { kind: "start"; id: string; name: string; input?: unknown }
  | {
      kind: "result";
      id: string;
      name: string;
      result?: unknown;
      error?: string;
      interrupts: PendingInterrupt[];
    };

export type GraphRequest =
  | { kind: "human"; interruptId: string; nodeId: string; prompt: string }
  | { kind: "approval"; interruptId: string; nodeId?: string; value: unknown };

interface RawEvent {
  method?: string;
  params?: { namespace?: readonly string[]; data?: unknown };
}

interface RawHistoryTask {
  id?: unknown;
  name?: unknown;
  result?: unknown;
  error?: unknown;
  interrupts?: unknown;
}

interface RawHistoryState {
  tasks?: RawHistoryTask[];
}

// LangGraph's own entry task; not a spec node.
const INTERNAL_TASKS = new Set(["__start__", "__end__"]);

/** Root-namespace `tasks` frames only; an agent node's inner tasks sit at a deeper namespace. */
export function taskFrameFromEvent(event: unknown): TaskFrame | undefined {
  const e = event as RawEvent;
  if (e?.method !== "tasks" || (e.params?.namespace?.length ?? 0) > 0) return undefined;
  const data = e.params?.data as Record<string, unknown> | undefined;
  if (!data || typeof data.id !== "string" || typeof data.name !== "string") return undefined;
  if (INTERNAL_TASKS.has(data.name)) return undefined;
  if (!("input" in data)) {
    return {
      kind: "result",
      id: data.id,
      name: data.name,
      ...(data.result !== undefined ? { result: data.result } : {}),
      ...(errorText(data.error) !== undefined ? { error: errorText(data.error)! } : {}),
      interrupts: interruptsOf(data.interrupts),
    };
  }
  return {
    kind: "start",
    id: data.id,
    name: data.name,
    ...(data.input !== undefined ? { input: data.input } : {}),
  };
}

/**
 * Checkpoint history, newest first, as chronological task frames. A task in any
 * checkpoint but the newest has finished, because a later checkpoint exists.
 */
export function taskFramesFromHistory(history: readonly unknown[]): TaskFrame[] {
  const frames: TaskFrame[] = [];
  const states = [...history].reverse() as RawHistoryState[];
  states.forEach((state, index) => {
    const latest = index === states.length - 1;
    for (const task of state?.tasks ?? []) {
      if (typeof task.id !== "string" || typeof task.name !== "string") continue;
      if (INTERNAL_TASKS.has(task.name)) continue;
      frames.push({ kind: "start", id: task.id, name: task.name });
      // An older checkpoint keeps the interrupts its task raised before it was resumed.
      const interrupts = latest ? interruptsOf(task.interrupts) : [];
      const error = errorText(task.error);
      if (!latest || task.result !== undefined || error !== undefined || interrupts.length > 0) {
        frames.push({
          kind: "result",
          id: task.id,
          name: task.name,
          ...(task.result !== undefined ? { result: task.result } : {}),
          ...(error !== undefined ? { error } : {}),
          interrupts,
        });
      }
    }
  });
  return frames;
}

/**
 * Folds task frames into each node's latest task. Frames may repeat across
 * history and live replay; they merge by task id. A started task without a
 * result is `running` while a run is active and `pending` otherwise.
 */
export function foldGraphRun(frames: readonly TaskFrame[], running: boolean): GraphNodeRuns {
  const tasks = new Map<string, GraphNodeRun>();
  const order: string[] = [];
  for (const frame of frames) {
    let task = tasks.get(frame.id);
    if (!task) {
      task = { nodeId: frame.name, taskId: frame.id, status: "pending", runs: 0, interrupts: [] };
      tasks.set(frame.id, task);
      order.push(frame.id);
    }
    if (frame.kind === "start") {
      if (frame.input !== undefined) task.input = frame.input;
      // A resumed task re-starts under the same id; only a pause may be reopened,
      // so a replayed start can't un-finish a done task.
      if (task.status === "paused") {
        task.status = "pending";
        task.interrupts = [];
      }
      continue;
    }
    if (frame.result !== undefined) task.result = frame.result;
    if (frame.error !== undefined) task.error = frame.error;
    task.interrupts = frame.interrupts;
    task.status = frame.error !== undefined ? "error" : frame.interrupts.length > 0 ? "paused" : "done";
  }

  const byNode: GraphNodeRuns = {};
  for (const taskId of order) {
    const task = tasks.get(taskId)!;
    const runs = (byNode[task.nodeId]?.runs ?? 0) + 1;
    const status = task.status === "pending" && running ? "running" : task.status;
    byNode[task.nodeId] = { ...task, status, runs };
  }
  return byNode;
}

/** Splits pending interrupts into `human` answers and agent-node tool approvals. */
export function graphRequests(
  interrupts: readonly PendingInterrupt[],
  runs: GraphNodeRuns,
): GraphRequest[] {
  const ownerOf = new Map<string, string>();
  for (const run of Object.values(runs)) {
    for (const interrupt of run.interrupts) ownerOf.set(interrupt.id, run.nodeId);
  }
  return interrupts.map((interrupt) => {
    if (isHumanRequest(interrupt.value)) {
      return {
        kind: "human",
        interruptId: interrupt.id,
        nodeId: interrupt.value.nodeId,
        prompt: interrupt.value.prompt,
      };
    }
    const nodeId = ownerOf.get(interrupt.id);
    return {
      kind: "approval",
      interruptId: interrupt.id,
      ...(nodeId ? { nodeId } : {}),
      value: interrupt.value,
    };
  });
}

export function isHumanRequest(value: unknown): value is GraphHumanRequest {
  const v = value as Partial<GraphHumanRequest> | null | undefined;
  return v?.type === "graph.human" && typeof v.nodeId === "string" && typeof v.prompt === "string";
}

/** Namespace an agent node's subgraph frames and checkpoints nest under. */
export function agentNodeNamespace(run: Pick<GraphNodeRun, "nodeId" | "taskId">): string[] {
  return [`${run.nodeId}:${run.taskId}`];
}

export interface GraphLayoutNode {
  id: string;
  type: GraphNodeType | "start" | "end";
  label: string;
  x: number;
  y: number;
}

export interface GraphLayoutEdge {
  id: string;
  from: string;
  to: string;
  label?: string;
}

export interface GraphLayout {
  direction: GraphDirection;
  nodes: GraphLayoutNode[];
  edges: GraphLayoutEdge[];
}

export type GraphDirection = "right" | "down";

// Spacing between ranks and between nodes within a rank, per flow direction.
const SPACING: Record<GraphDirection, { rank: number; sibling: number }> = {
  right: { rank: 230, sibling: 110 },
  down: { rank: 100, sibling: 230 },
};

/**
 * Layers by longest path from start so every forward edge points down the
 * flow; edges that close a loop are ignored for ranking. `end` takes the last rank.
 */
export function graphLayout(spec: GraphSpec, direction: GraphDirection = "right"): GraphLayout {
  const edges = graphEdges(spec);
  const next = new Map<string, string[]>();
  for (const edge of edges) next.set(edge.from, [...(next.get(edge.from) ?? []), edge.to]);

  // Depth-first post-order without back edges gives a reverse topological order.
  const order: string[] = [];
  const state = new Map<string, "open" | "closed">();
  const forward = new Map<string, string[]>();
  const visit = (id: string) => {
    state.set(id, "open");
    for (const to of next.get(id) ?? []) {
      if (state.get(to) === "open") continue;
      forward.set(id, [...(forward.get(id) ?? []), to]);
      if (!state.has(to)) visit(to);
    }
    state.set(id, "closed");
    order.push(id);
  };
  visit(GRAPH_START);

  const rank = new Map<string, number>([[GRAPH_START, 0]]);
  for (const id of order.reverse()) {
    const from = rank.get(id) ?? 0;
    for (const to of forward.get(id) ?? []) rank.set(to, Math.max(rank.get(to) ?? 0, from + 1));
  }
  const lastRank =
    Math.max(0, ...[...rank].filter(([id]) => id !== GRAPH_END).map(([, value]) => value)) + 1;
  rank.set(GRAPH_END, lastRank);

  const ids = [GRAPH_START, ...spec.nodes.map((node) => node.id), GRAPH_END];
  const ranks = new Map<number, string[]>();
  for (const id of ids) {
    const r = rank.get(id) ?? lastRank;
    ranks.set(r, [...(ranks.get(r) ?? []), id]);
  }
  // An edge that skips ranks reserves a slot in each rank it crosses, so it
  // does not run through the nodes there.
  for (const [from, targets] of forward) {
    for (const to of targets) {
      for (let r = rank.get(from)! + 1; r < rank.get(to)!; r++) {
        ranks.get(r)?.push(`${from}->${to}@${r}`);
      }
    }
  }
  const widest = Math.max(...[...ranks.values()].map((members) => members.length));
  const { rank: rankGap, sibling: siblingGap } = SPACING[direction];
  const position = new Map<string, { x: number; y: number }>();
  for (const [r, members] of ranks) {
    const offset = ((widest - members.length) * siblingGap) / 2;
    members.forEach((id, i) => {
      const along = r * rankGap;
      const across = offset + i * siblingGap;
      position.set(id, direction === "right" ? { x: along, y: across } : { x: across, y: along });
    });
  }

  const specNodes = new Map(spec.nodes.map((node) => [node.id, node]));
  return {
    direction,
    nodes: ids.map((id) => {
      const node = specNodes.get(id);
      return {
        id,
        type: node ? node.type : id === GRAPH_START ? "start" : "end",
        label: node ? (node.label ?? node.id) : id === GRAPH_START ? "Start" : "End",
        ...position.get(id)!,
      };
    }),
    edges,
  };
}

/** Plain edges plus each branch's cases and default, labeled by condition. */
export function graphEdges(spec: GraphSpec): GraphLayoutEdge[] {
  const edges: GraphLayoutEdge[] = spec.edges.map((edge) => ({
    id: `${edge.from}->${edge.to}`,
    from: edge.from,
    to: edge.to,
  }));
  for (const node of spec.nodes) {
    if (node.type !== "branch") continue;
    const labels = new Map<string, string[]>();
    for (const branchCase of node.cases) {
      labels.set(branchCase.to, [...(labels.get(branchCase.to) ?? []), conditionLabel(branchCase.when)]);
    }
    labels.set(node.default, [...(labels.get(node.default) ?? []), "otherwise"]);
    for (const [to, parts] of labels) {
      edges.push({ id: `${node.id}->${to}`, from: node.id, to, label: parts.join(" / ") });
    }
  }
  return edges;
}

const OP_TEXT: Record<GraphCondition["op"], string> = {
  eq: "=",
  neq: "≠",
  gt: ">",
  gte: "≥",
  lt: "<",
  lte: "≤",
  contains: "contains",
  exists: "exists",
  truthy: "is truthy",
};

export function conditionLabel(condition: GraphCondition): string {
  const op = OP_TEXT[condition.op];
  if (condition.op === "exists" || condition.op === "truthy") return `${condition.path} ${op}`;
  return `${condition.path} ${op} ${JSON.stringify(condition.value)}`;
}

/**
 * Edges a run went down. A task is reached through the predecessor whose task
 * finished last before it started, so a branch's untaken edge stays dark even
 * when its target is reached another way.
 */
export function traversedEdges(
  frames: readonly TaskFrame[],
  edges: readonly GraphLayoutEdge[],
  finished: boolean,
): Set<string> {
  interface Span {
    name: string;
    start: number;
    end?: number;
    done: boolean;
  }
  const spans = new Map<string, Span>();
  frames.forEach((frame, seq) => {
    let span = spans.get(frame.id);
    if (!span) {
      span = { name: frame.name, start: seq, done: false };
      spans.set(frame.id, span);
    }
    // History and live replay repeat a task; its first finishing result counts.
    if (frame.kind === "result" && !span.done) {
      span.end = seq;
      span.done = frame.error === undefined && frame.interrupts.length === 0;
    }
  });
  const into = new Map<string, GraphLayoutEdge[]>();
  for (const edge of edges) into.set(edge.to, [...(into.get(edge.to) ?? []), edge]);

  const lastBefore = (sources: readonly GraphLayoutEdge[], before: number) => {
    let best: { edge: GraphLayoutEdge; end: number } | undefined;
    for (const edge of sources) {
      for (const span of spans.values()) {
        if (span.name !== edge.from || !span.done || span.end === undefined || span.end >= before) continue;
        if (!best || span.end > best.end) best = { edge, end: span.end };
      }
    }
    return best?.edge;
  };

  const taken = new Set<string>();
  for (const span of spans.values()) {
    const incoming = into.get(span.name) ?? [];
    const edge = lastBefore(incoming, span.start) ?? incoming.find((e) => e.from === GRAPH_START);
    if (edge) taken.add(edge.id);
  }
  if (finished) {
    const edge = lastBefore(into.get(GRAPH_END) ?? [], Number.POSITIVE_INFINITY);
    if (edge) taken.add(edge.id);
  }
  return taken;
}

function interruptsOf(raw: unknown): PendingInterrupt[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((it) => {
    const interrupt = it as { id?: unknown; value?: unknown };
    return typeof interrupt?.id === "string" ? [{ id: interrupt.id, value: interrupt.value }] : [];
  });
}

function errorText(raw: unknown): string | undefined {
  if (raw === undefined || raw === null || raw === "") return undefined;
  if (typeof raw === "string") return raw;
  const message = (raw as { message?: unknown }).message;
  return typeof message === "string" ? message : JSON.stringify(raw);
}
