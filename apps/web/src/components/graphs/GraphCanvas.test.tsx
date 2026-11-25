import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { parseGraphSpec } from "@pizza-bot/core";
import { foldGraphRun, graphLayout } from "@/projection";
import { GraphCanvas } from "./GraphCanvas.js";
import { runPhase } from "./GraphRunPane.js";
import type { GraphRunSnapshot } from "../../graph-run-store.js";

const parsed = parseGraphSpec({
  id: "g",
  name: "G",
  nodes: [
    { id: "ask", type: "human", label: "Ask owner", prompt: "Who?", output: "owner" },
    { id: "reply", type: "agent", prompt: "Reply", output: "text" },
  ],
  edges: [
    { from: "start", to: "ask" },
    { from: "ask", to: "reply" },
    { from: "reply", to: "end" },
  ],
});
if (!parsed.ok) throw new Error(parsed.errors.join("; "));
const spec = parsed.spec;

describe("GraphCanvas", () => {
  it("renders each step with its live status", () => {
    const runs = foldGraphRun(
      [
        { kind: "start", id: "t1", name: "ask" },
        { kind: "result", id: "t1", name: "ask", interrupts: [{ id: "i1", value: {} }] },
      ],
      false,
    );
    const html = renderToStaticMarkup(
      <div style={{ width: 800, height: 400 }}>
        <GraphCanvas layout={graphLayout(spec)} runs={runs} />
      </div>,
    );
    expect(html).toContain("graph-node-human status-paused");
    expect(html).toContain("Ask owner");
    expect(html).toContain("graph-node-agent status-idle");
  });
});

describe("runPhase", () => {
  const snapshot = (overrides: Partial<GraphRunSnapshot>): GraphRunSnapshot => ({
    status: "idle",
    frames: [],
    runs: {},
    interrupts: [],
    values: {},
    ...overrides,
  });

  it("calls a settled run with an unfinished step stopped, not finished", () => {
    const pending = foldGraphRun([{ kind: "start", id: "t1", name: "reply" }], false);
    expect(runPhase(snapshot({ runs: pending }))).toBe("stopped");
    const done = foldGraphRun(
      [
        { kind: "start", id: "t1", name: "reply" },
        { kind: "result", id: "t1", name: "reply", interrupts: [] },
      ],
      false,
    );
    expect(runPhase(snapshot({ runs: done }))).toBe("finished");
  });

  it("reports a failed step as a failed run", () => {
    const failed = foldGraphRun(
      [
        { kind: "start", id: "t1", name: "reply" },
        { kind: "result", id: "t1", name: "reply", error: "boom", interrupts: [] },
      ],
      false,
    );
    expect(runPhase(snapshot({ runs: failed }))).toBe("error");
    expect(runPhase(snapshot({ status: "paused" }))).toBe("paused");
  });
});
