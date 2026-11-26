import { useEffect, useMemo, useState } from "react";
import { CircleStop, Loader2 } from "lucide-react";
import type { GraphSpec } from "@pizza-bot/core";
import {
  agentNodeNamespace,
  graphLayout,
  graphRequests,
  parseInterruptActions,
  traversedEdges,
  type GraphNodeRun,
  type GraphRequest,
} from "@/projection";
import type { ApiClient } from "../../api-client.js";
import { graphRunStore, type GraphRunSnapshot } from "../../graph-run-store.js";
import { useAgentTranscript, useGraphRun } from "../../use-graph-run.js";
import { ChatHeader } from "../ChatHeader.js";
import { outputText, SubagentTranscript } from "../ActivityRail.js";
import { GraphCanvas } from "./GraphCanvas.js";
import { GRAPH_NODE_TYPE_LABEL, GRAPH_STATUS_LABEL } from "./graph-labels.js";

type RunPhase = "loading" | "running" | "paused" | "finished" | "stopped" | "error";

const PHASE_LABEL: Record<RunPhase, string> = {
  loading: "Loading",
  running: "Running",
  paused: "Waiting for you",
  finished: "Finished",
  stopped: "Stopped",
  error: "Failed",
};

export function runPhase(run: GraphRunSnapshot): RunPhase {
  if (run.status !== "idle") return run.status === "error" ? "error" : run.status;
  const runs = Object.values(run.runs);
  if (runs.some((r) => r.status === "error")) return "error";
  // A settled run with an unfinished task was cancelled or cut off by a restart.
  return runs.some((r) => r.status === "pending") ? "stopped" : "finished";
}

export function GraphRunPane({
  client,
  threadId,
  graphId,
  title,
  onRename,
  onBack,
}: {
  client: ApiClient;
  threadId: string;
  graphId: string;
  title: string;
  onRename?: (title: string) => Promise<void>;
  onBack?: () => void;
}) {
  const [spec, setSpec] = useState<GraphSpec | null | undefined>(undefined);
  useEffect(() => {
    let cancelled = false;
    setSpec(undefined);
    client
      .getGraph(graphId)
      .then((loaded) => !cancelled && setSpec(loaded ?? null))
      .catch(() => !cancelled && setSpec(null));
    return () => {
      cancelled = true;
    };
  }, [client, graphId]);

  const run = useGraphRun(threadId);
  const phase = runPhase(run);
  // The run pane is taller than wide beside its detail panel, so the graph flows down.
  const layout = useMemo(() => (spec ? graphLayout(spec, "down") : null), [spec]);
  const finished = phase === "finished";
  const traversed = useMemo(
    () => (layout ? traversedEdges(run.frames, layout.edges, finished) : new Set<string>()),
    [layout, run.frames, finished],
  );
  const requests = useMemo(() => graphRequests(run.interrupts, run.runs), [run.interrupts, run.runs]);

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const pausedNode = requests[0]?.nodeId;
  useEffect(() => {
    if (pausedNode) setSelectedId(pausedNode);
  }, [pausedNode]);

  const selectedNode = spec?.nodes.find((node) => node.id === selectedId);
  const selectedRun = selectedId ? run.runs[selectedId] : undefined;

  return (
    <div className="graph-run-pane">
      <ChatHeader
        title={title}
        {...(onRename ? { onRename } : {})}
        {...(onBack ? { onBack } : {})}
        actions={
          <>
            <span className={`graph-run-status phase-${phase}`}>
              {phase === "running" && <Loader2 size={13} className="spin" />}
              {PHASE_LABEL[phase]}
            </span>
            {phase === "running" && (
              <button className="btn-secondary" onClick={() => void graphRunStore.stop(threadId)}>
                <CircleStop size={14} /> Stop
              </button>
            )}
          </>
        }
      />
      {spec === null ? (
        <div className="graph-run-missing">
          Graph <code>{graphId}</code> no longer exists or does not parse, so this run cannot be drawn.
        </div>
      ) : (
        <div className="graph-run-body">
          {layout ? (
            <GraphCanvas
              layout={layout}
              runs={run.runs}
              traversed={traversed}
              finished={finished}
              selectedId={selectedId}
              onSelect={setSelectedId}
            />
          ) : (
            <div className="graph-canvas graph-canvas-loading">
              <Loader2 size={18} className="spin" />
            </div>
          )}
          <aside className="graph-run-side" aria-label="Run details">
            {run.errorText && <div className="graph-run-error">{run.errorText}</div>}
            {requests.map((request) => (
              <RequestCard
                key={request.interruptId}
                threadId={threadId}
                request={request}
                nodeLabel={nodeLabel(spec, request.nodeId)}
              />
            ))}
            {selectedNode ? (
              <NodeDetail
                threadId={threadId}
                label={selectedNode.label ?? selectedNode.id}
                type={selectedNode.type}
                run={selectedRun}
                output={"output" in selectedNode ? run.values[selectedNode.output] : undefined}
              />
            ) : (
              requests.length === 0 && (
                <p className="graph-run-hint">Select a step to see its input and result.</p>
              )
            )}
          </aside>
        </div>
      )}
    </div>
  );
}

function nodeLabel(spec: GraphSpec | null | undefined, nodeId: string | undefined): string | undefined {
  if (!nodeId) return undefined;
  const node = spec?.nodes.find((n) => n.id === nodeId);
  return node?.label ?? nodeId;
}

function RequestCard({
  threadId,
  request,
  nodeLabel,
}: {
  threadId: string;
  request: GraphRequest;
  nodeLabel: string | undefined;
}) {
  const [answer, setAnswer] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const act = async (action: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      setBusy(false);
    }
  };

  if (request.kind === "human") {
    return (
      <form
        className="graph-request"
        onSubmit={(event) => {
          event.preventDefault();
          if (!answer.trim()) return;
          void act(() => graphRunStore.respond(threadId, request.interruptId, answer.trim()));
        }}
      >
        <div className="graph-request-head">{nodeLabel ?? "Human step"} needs your answer</div>
        <p className="graph-request-prompt">{request.prompt}</p>
        <textarea
          className="graph-request-input"
          aria-label="Your answer"
          rows={3}
          value={answer}
          disabled={busy}
          onChange={(event) => setAnswer(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
              event.currentTarget.form?.requestSubmit();
            }
          }}
        />
        {error && <div className="graph-request-error">{error}</div>}
        <div className="graph-request-actions">
          <button type="submit" className="btn-primary" disabled={busy || !answer.trim()}>
            {busy ? "Sending…" : "Send answer"}
          </button>
        </div>
      </form>
    );
  }

  const { actions, allowedDecisions } = parseInterruptActions(request.value);
  const interrupt = { id: request.interruptId, value: request.value };
  return (
    <div className="graph-request">
      <div className="graph-request-head">{nodeLabel ?? "An agent"} asks to run</div>
      {actions.map((action, index) => (
        <div key={index} className="graph-request-action">
          <code>{action.toolName}</code>
          <pre>{outputText(action.args)}</pre>
        </div>
      ))}
      {error && <div className="graph-request-error">{error}</div>}
      <div className="graph-request-actions">
        {allowedDecisions.includes("reject") && (
          <button
            className="btn-secondary"
            disabled={busy}
            onClick={() => void act(() => graphRunStore.decide(threadId, interrupt, "reject"))}
          >
            Reject
          </button>
        )}
        <button
          className="btn-primary"
          disabled={busy}
          onClick={() => void act(() => graphRunStore.decide(threadId, interrupt, "approve"))}
        >
          Approve
        </button>
      </div>
    </div>
  );
}

function NodeDetail({
  threadId,
  label,
  type,
  run,
  output,
}: {
  threadId: string;
  label: string;
  type: keyof typeof GRAPH_NODE_TYPE_LABEL;
  run: GraphNodeRun | undefined;
  output: unknown;
}) {
  return (
    <section className="graph-node-detail">
      <div className="graph-node-detail-head">
        <span className="graph-node-detail-title">{label}</span>
        <span className="graph-node-detail-type">{GRAPH_NODE_TYPE_LABEL[type]}</span>
        <span className={`graph-node-detail-status status-${run?.status ?? "idle"}`}>
          {GRAPH_STATUS_LABEL[run?.status ?? "idle"]}
          {run && run.runs > 1 ? ` · ran ${run.runs}×` : ""}
        </span>
      </div>
      {run?.error && <pre className="graph-node-detail-io error">{run.error}</pre>}
      {type === "agent" && run ? (
        <AgentNodeTranscript threadId={threadId} run={run} output={output} />
      ) : (
        <>
          {hasContent(run?.result) && <Field label="Result" value={run!.result} />}
          {run?.result === undefined && output !== undefined && <Field label="Output" value={output} />}
        </>
      )}
      {run?.input !== undefined && <Field label="Input" value={run.input} collapsed />}
    </section>
  );
}

function AgentNodeTranscript({
  threadId,
  run,
  output,
}: {
  threadId: string;
  run: GraphNodeRun;
  output: unknown;
}) {
  const namespace = useMemo(() => agentNodeNamespace(run), [run]);
  const messages = useAgentTranscript(threadId, namespace);
  const settled = run.status !== "running";
  if (messages && messages.length > 0) {
    return (
      <div className="graph-node-transcript">
        <SubagentTranscript messages={messages} settled={settled} />
      </div>
    );
  }
  const text = outputText(output);
  if (text) return <Field label="Reply" value={text} />;
  return (
    <div className="graph-node-detail-muted">
      {run.status === "running" ? "Waiting for the agent to report…" : "No transcript available for this run."}
    </div>
  );
}

function hasContent(value: unknown): boolean {
  if (value === undefined || value === null) return false;
  return typeof value !== "object" || Object.keys(value).length > 0;
}

function Field({ label, value, collapsed = false }: { label: string; value: unknown; collapsed?: boolean }) {
  const text = outputText(value) ?? "";
  return (
    <details className="graph-node-field" open={!collapsed}>
      <summary>{label}</summary>
      <pre className="graph-node-detail-io">{text}</pre>
    </details>
  );
}
