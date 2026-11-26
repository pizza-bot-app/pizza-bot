import { describe, expect, it } from "vitest";
import { parseGraphSpec, type GraphSpec } from "@pizza-bot/core";
import {
  agentNodeNamespace,
  foldGraphRun,
  graphEdges,
  graphLayout,
  graphRequests,
  taskFrameFromEvent,
  taskFramesFromHistory,
  traversedEdges,
  type TaskFrame,
} from "./graph-run.js";

function spec(): GraphSpec {
  const parsed = parseGraphSpec({
    id: "triage",
    name: "Triage",
    nodes: [
      { id: "prepare", type: "transform", set: { ticket: "{{input.body.ticket}}" } },
      {
        id: "route",
        type: "branch",
        cases: [{ when: { path: "ticket", op: "contains", value: "urgent" }, to: "approve" }],
        default: "draft",
      },
      { id: "approve", type: "human", label: "Approve", prompt: "Owner?", output: "owner" },
      { id: "draft", type: "agent", prompt: "Reply to {{ticket}}", output: "reply" },
    ],
    edges: [
      { from: "start", to: "prepare" },
      { from: "prepare", to: "route" },
      { from: "approve", to: "draft" },
      { from: "draft", to: "end" },
    ],
  });
  if (!parsed.ok) throw new Error(parsed.errors.join("; "));
  return parsed.spec;
}

const tasksEvent = (data: Record<string, unknown>, namespace: string[] = []) => ({
  method: "tasks",
  params: { namespace, timestamp: 0, data },
});

const human = { type: "graph.human", nodeId: "approve", prompt: "Owner?" };

describe("taskFrameFromEvent", () => {
  it("reads start and result frames at the root namespace", () => {
    expect(
      taskFrameFromEvent(
        tasksEvent({ id: "t1", name: "prepare", input: { input: {} }, triggers: ["branch:to:prepare"], interrupts: [] }),
      ),
    ).toEqual({ kind: "start", id: "t1", name: "prepare", input: { input: {} } });
    expect(
      taskFrameFromEvent(tasksEvent({ id: "t1", name: "prepare", result: { ticket: "x" }, interrupts: [], error: null })),
    ).toEqual({ kind: "result", id: "t1", name: "prepare", result: { ticket: "x" }, interrupts: [] });
  });

  it("ignores an agent node's inner tasks and other channels", () => {
    expect(taskFrameFromEvent(tasksEvent({ id: "t2", name: "model_request", input: {} }, ["draft:abc"]))).toBeUndefined();
    expect(taskFrameFromEvent({ method: "values", params: { namespace: [], data: {} } })).toBeUndefined();
  });

  it("keeps a pause's interrupts and an error's text", () => {
    expect(
      taskFrameFromEvent(
        tasksEvent({ id: "t3", name: "approve", result: {}, interrupts: [{ id: "i1", value: human }], error: null }),
      ),
    ).toMatchObject({ kind: "result", interrupts: [{ id: "i1", value: human }] });
    expect(
      taskFrameFromEvent(tasksEvent({ id: "t4", name: "draft", interrupts: [], error: "boom" })),
    ).toMatchObject({ kind: "result", error: "boom" });
  });
});

describe("taskFramesFromHistory", () => {
  it("treats tasks before the newest checkpoint as finished and keeps the newest pause", () => {
    const history = [
      { tasks: [{ id: "t3", name: "approve", interrupts: [{ id: "i1", value: human }] }] },
      { tasks: [{ id: "t2", name: "route", interrupts: [] }] },
      { tasks: [{ id: "t1", name: "prepare", result: { ticket: "x" }, interrupts: [] }] },
      { tasks: [{ id: "t0", name: "__start__", result: {}, interrupts: [] }] },
    ];
    const runs = foldGraphRun(taskFramesFromHistory(history), false);
    expect(Object.keys(runs)).toEqual(["prepare", "route", "approve"]);
    expect(runs.prepare).toMatchObject({ status: "done", result: { ticket: "x" } });
    expect(runs.route?.status).toBe("done");
    expect(runs.approve).toMatchObject({ status: "paused", interrupts: [{ id: "i1" }] });
  });

  it("treats a resumed pause in an older checkpoint as done", () => {
    const history = [
      { tasks: [] },
      { tasks: [{ id: "t4", name: "draft", result: { reply: "Hi" }, interrupts: [] }] },
      { tasks: [{ id: "t3", name: "approve", interrupts: [{ id: "i1", value: human }] }] },
    ];
    const runs = foldGraphRun(taskFramesFromHistory(history), false);
    expect(runs.approve).toMatchObject({ status: "done", interrupts: [] });
    expect(runs.draft?.status).toBe("done");
  });

  it("leaves a newest unfinished task pending", () => {
    const runs = foldGraphRun(taskFramesFromHistory([{ tasks: [{ id: "t1", name: "draft", interrupts: [] }] }]), false);
    expect(runs.draft?.status).toBe("pending");
  });
});

describe("foldGraphRun", () => {
  it("marks a started task running only while a run is active", () => {
    const frames: TaskFrame[] = [{ kind: "start", id: "t1", name: "draft" }];
    expect(foldGraphRun(frames, true).draft?.status).toBe("running");
    expect(foldGraphRun(frames, false).draft?.status).toBe("pending");
  });

  it("merges history and live replay of the same task and counts reruns", () => {
    const frames: TaskFrame[] = [
      { kind: "start", id: "t1", name: "approve" },
      { kind: "result", id: "t1", name: "approve", interrupts: [{ id: "i1", value: human }] },
      { kind: "start", id: "t1", name: "approve", input: { a: 1 } },
      { kind: "result", id: "t1", name: "approve", result: { owner: "Sam" }, interrupts: [] },
      { kind: "start", id: "t2", name: "prepare" },
      { kind: "result", id: "t2", name: "prepare", interrupts: [] },
      { kind: "start", id: "t3", name: "prepare" },
    ];
    const runs = foldGraphRun(frames, true);
    expect(runs.approve).toMatchObject({ status: "done", runs: 1, result: { owner: "Sam" }, input: { a: 1 } });
    expect(runs.prepare).toMatchObject({ status: "running", runs: 2, taskId: "t3" });
  });

  it("shows a resumed pause as running until its result arrives", () => {
    const frames: TaskFrame[] = [
      { kind: "start", id: "t1", name: "approve" },
      { kind: "result", id: "t1", name: "approve", interrupts: [{ id: "i1", value: human }] },
      { kind: "start", id: "t1", name: "approve" },
    ];
    expect(foldGraphRun(frames, true).approve).toMatchObject({ status: "running", interrupts: [] });
  });

  it("keeps a finished task done when its start replays", () => {
    const frames: TaskFrame[] = [
      { kind: "start", id: "t1", name: "draft" },
      { kind: "result", id: "t1", name: "draft", result: "ok", interrupts: [] },
      { kind: "start", id: "t1", name: "draft" },
    ];
    expect(foldGraphRun(frames, true).draft?.status).toBe("done");
  });
});

describe("graphRequests", () => {
  it("splits human answers from agent-node approvals", () => {
    const runs = foldGraphRun(
      [
        { kind: "start", id: "t1", name: "draft" },
        { kind: "result", id: "t1", name: "draft", interrupts: [{ id: "i2", value: { actionRequests: [] } }] },
      ],
      false,
    );
    expect(
      graphRequests(
        [
          { id: "i1", value: human },
          { id: "i2", value: { actionRequests: [] } },
        ],
        runs,
      ),
    ).toEqual([
      { kind: "human", interruptId: "i1", nodeId: "approve", prompt: "Owner?" },
      { kind: "approval", interruptId: "i2", nodeId: "draft", value: { actionRequests: [] } },
    ]);
  });
});

describe("graph topology", () => {
  it("draws branch cases and default as labeled edges", () => {
    expect(graphEdges(spec())).toEqual(
      expect.arrayContaining([
        { id: "route->approve", from: "route", to: "approve", label: 'ticket contains "urgent"' },
        { id: "route->draft", from: "route", to: "draft", label: "otherwise" },
      ]),
    );
  });

  it("ranks nodes by longest path from start so every edge points forward", () => {
    const layout = graphLayout(spec());
    const x = Object.fromEntries(layout.nodes.map((n) => [n.id, n.x]));
    expect(x.start).toBeLessThan(x.prepare!);
    expect(x.prepare).toBeLessThan(x.route!);
    expect(x.route).toBeLessThan(x.approve!);
    expect(x.approve).toBeLessThan(x.draft!);
    expect(x.end).toBeGreaterThan(x.draft!);
    expect(layout.nodes.find((n) => n.id === "approve")).toMatchObject({ type: "human", label: "Approve" });
  });

  it("moves a node aside when an edge skips over its rank", () => {
    const layout = graphLayout(spec(), "down");
    const at = Object.fromEntries(layout.nodes.map((n) => [n.id, n]));
    // route -> draft skips approve's rank; the edge runs straight down from route.
    expect(at.approve!.x).not.toBe(at.route!.x);
    expect(layout.nodes.map((n) => n.id)).not.toContain("route->draft@4");
  });

  it("flows downward when asked", () => {
    const layout = graphLayout(spec(), "down");
    const y = Object.fromEntries(layout.nodes.map((n) => [n.id, n.y]));
    expect(layout.direction).toBe("down");
    expect(y.start).toBeLessThan(y.prepare!);
    expect(y.draft).toBeLessThan(y.end!);
  });

  it("keeps a loop back to an earlier node from moving it", () => {
    const parsed = parseGraphSpec({
      id: "loop",
      name: "Loop",
      nodes: [
        { id: "a", type: "transform", set: { n: 1 } },
        { id: "check", type: "branch", cases: [{ when: { path: "n", op: "lt", value: 3 }, to: "a" }], default: "end" },
      ],
      edges: [
        { from: "start", to: "a" },
        { from: "a", to: "check" },
      ],
    });
    if (!parsed.ok) throw new Error(parsed.errors.join("; "));
    const x = Object.fromEntries(graphLayout(parsed.spec).nodes.map((n) => [n.id, n.x]));
    expect(x.a).toBeLessThan(x.check!);
  });
});

describe("traversedEdges", () => {
  const ran = (id: string, name: string): TaskFrame[] => [
    { kind: "start", id, name },
    { kind: "result", id, name, interrupts: [] },
  ];

  it("lights the branch case taken, not the default reached another way", () => {
    const frames = [...ran("t1", "prepare"), ...ran("t2", "route"), ...ran("t3", "approve"), ...ran("t4", "draft")];
    const taken = traversedEdges(frames, graphEdges(spec()), true);
    expect([...taken].sort()).toEqual(
      ["approve->draft", "draft->end", "prepare->route", "route->approve", "start->prepare"].sort(),
    );
  });

  it("ignores a live replay of tasks history already holds", () => {
    const history = [...ran("t1", "prepare"), ...ran("t2", "route")];
    const frames = [...history, ...history];
    expect(traversedEdges(frames, graphEdges(spec()), false).has("prepare->route")).toBe(true);
  });

  it("does not leave a paused node", () => {
    const frames: TaskFrame[] = [
      ...ran("t1", "prepare"),
      ...ran("t2", "route"),
      { kind: "start", id: "t3", name: "approve" },
      { kind: "result", id: "t3", name: "approve", interrupts: [{ id: "i1", value: human }] },
    ];
    const taken = traversedEdges(frames, graphEdges(spec()), false);
    expect(taken.has("route->approve")).toBe(true);
    expect(taken.has("approve->draft")).toBe(false);
    expect(taken.has("draft->end")).toBe(false);
  });
});

describe("agentNodeNamespace", () => {
  it("matches the checkpoint namespace LangGraph gives a node's task", () => {
    expect(agentNodeNamespace({ nodeId: "draft", taskId: "abc" })).toEqual(["draft:abc"]);
  });
});
