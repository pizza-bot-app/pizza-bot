import { memo, useMemo } from "react";
import {
  Background,
  Handle,
  MarkerType,
  Position,
  ReactFlow,
  type Edge,
  type Node,
  type NodeProps,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import type { GraphLayout, GraphNodeRuns, GraphNodeStatus } from "@/projection";
import { GRAPH_NODE_ICON, GRAPH_NODE_TYPE_LABEL, GRAPH_STATUS_LABEL } from "./graph-labels.js";

interface GraphNodeData extends Record<string, unknown> {
  label: string;
  type: keyof typeof GRAPH_NODE_ICON;
  status: GraphNodeStatus;
  runs: number;
  direction: GraphLayout["direction"];
}

type GraphFlowNode = Node<GraphNodeData, "graph">;

const GraphNodeCard = memo(function GraphNodeCard({ data, selected }: NodeProps<GraphFlowNode>) {
  const Icon = GRAPH_NODE_ICON[data.type];
  const terminal = data.type === "start" || data.type === "end";
  const down = data.direction === "down";
  return (
    <div
      className={`graph-node graph-node-${data.type} status-${data.status}${selected ? " selected" : ""}${
        terminal ? " terminal" : ""
      }`}
      title={`${data.label} · ${GRAPH_NODE_TYPE_LABEL[data.type]} · ${GRAPH_STATUS_LABEL[data.status]}`}
    >
      {data.type !== "start" && <Handle type="target" position={down ? Position.Top : Position.Left} isConnectable={false} />}
      <Icon size={14} className="graph-node-icon" />
      <span className="graph-node-label">{data.label}</span>
      {!terminal && data.runs > 1 && <span className="graph-node-runs">×{data.runs}</span>}
      {data.type !== "end" && <Handle type="source" position={down ? Position.Bottom : Position.Right} isConnectable={false} />}
    </div>
  );
});

const nodeTypes = { graph: GraphNodeCard };

export function GraphCanvas({
  layout,
  runs = {},
  traversed,
  finished = false,
  selectedId,
  onSelect,
}: {
  layout: GraphLayout;
  runs?: GraphNodeRuns;
  traversed?: ReadonlySet<string>;
  finished?: boolean;
  selectedId?: string | null;
  onSelect?: (nodeId: string) => void;
}) {
  const nodes = useMemo<GraphFlowNode[]>(
    () =>
      layout.nodes.map((node) => {
        const run = runs[node.id];
        const status: GraphNodeStatus =
          node.type === "start"
            ? Object.keys(runs).length > 0
              ? "done"
              : "idle"
            : node.type === "end"
              ? finished
                ? "done"
                : "idle"
              : (run?.status ?? "idle");
        return {
          id: node.id,
          type: "graph",
          position: { x: node.x, y: node.y },
          data: {
            label: node.label,
            type: node.type,
            status,
            runs: run?.runs ?? 0,
            direction: layout.direction,
          },
          selected: node.id === selectedId,
          draggable: false,
          connectable: false,
        };
      }),
    [layout, runs, finished, selectedId],
  );
  const edges = useMemo<Edge[]>(
    () =>
      layout.edges.map((edge) => {
        const active = traversed?.has(edge.id) ?? false;
        return {
          id: edge.id,
          source: edge.from,
          target: edge.to,
          ...(edge.label ? { label: edge.label } : {}),
          className: active ? "graph-edge traversed" : "graph-edge",
          markerEnd: { type: MarkerType.ArrowClosed, width: 16, height: 16 },
          animated: active && runs[edge.to]?.status === "running",
        };
      }),
    [layout, traversed, runs],
  );

  return (
    <div className="graph-canvas">
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        fitView
        fitViewOptions={{ padding: 0.2 }}
        nodeOrigin={[0.5, 0.5]}
        nodesDraggable={false}
        nodesConnectable={false}
        edgesFocusable={false}
        onNodeClick={(_, node) => onSelect?.(node.id)}
        minZoom={0.3}
        maxZoom={1.6}
      >
        <Background gap={20} size={1} />
      </ReactFlow>
    </div>
  );
}
