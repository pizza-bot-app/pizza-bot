import { describe, expect, it } from "vitest";
import { graphStateKeys, graphSuccessors, parseGraphSpec } from "./graph-spec.js";

const valid = {
  id: "triage",
  name: "Triage",
  nodes: [
    { id: "classify", type: "llm", prompt: "Classify {{input.body.text}}", output: "label" },
    {
      id: "route",
      type: "branch",
      cases: [{ when: { path: "label", op: "eq", value: "urgent" }, to: "approve" }],
      default: "end",
    },
    { id: "approve", type: "human", prompt: "Escalate {{input.body.text}}?", output: "decision" },
  ],
  edges: [
    { from: "start", to: "classify" },
    { from: "classify", to: "route" },
    { from: "approve", to: "end" },
  ],
};

function errorsOf(raw: unknown): string[] {
  const parsed = parseGraphSpec(raw);
  return parsed.ok ? [] : parsed.errors;
}

describe("parseGraphSpec", () => {
  it("accepts a branching spec and derives successors and state keys", () => {
    const parsed = parseGraphSpec(valid);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(graphSuccessors(parsed.spec).get("route")).toEqual(["approve", "end"]);
    expect(graphStateKeys(parsed.spec)).toEqual(["input", "label", "decision"]);
  });

  it("rejects ids that could escape the graphs directory", () => {
    expect(errorsOf({ ...valid, id: "../etc" })).toEqual([
      expect.stringContaining("id:"),
    ]);
  });

  it("rejects reserved and colliding keys", () => {
    expect(errorsOf({
      ...valid,
      nodes: [{ id: "a", type: "transform", set: { messages: 1 } }],
      edges: [{ from: "start", to: "a" }, { from: "a", to: "end" }],
    })).toEqual([expect.stringContaining("is reserved")]);
    expect(errorsOf({
      ...valid,
      nodes: [{ id: "a", type: "transform", set: { a: 1 } }],
      edges: [{ from: "start", to: "a" }, { from: "a", to: "end" }],
    })).toEqual(['node id "a" is also a state key']);
  });

  it("reports dangling edges, outgoing edges on a branch, dead ends, and unreachable nodes", () => {
    expect(errorsOf({ ...valid, edges: [...valid.edges, { from: "route", to: "nope" }] })).toEqual([
      'branch "route" routes through its cases, not edges',
      'edge to unknown node "nope"',
    ]);
    expect(errorsOf({
      ...valid,
      nodes: [...valid.nodes, { id: "orphan", type: "transform", set: { x: 1 } }],
    })).toEqual(['node "orphan" has no outgoing edge', 'node "orphan" is unreachable from start']);
  });

  it("requires an edge out of start", () => {
    expect(errorsOf({ ...valid, edges: valid.edges.slice(1) })).toContain("no edge leaves start");
  });
});
