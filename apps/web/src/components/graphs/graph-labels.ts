import type { LucideIcon } from "lucide-react";
import { Bot, Flag, GitBranch, Play, Shuffle, Sparkles, UserRound, Wrench } from "lucide-react";
import type { GraphNodeType } from "@pizza-bot/core";
import type { GraphNodeStatus } from "@/projection";

type LayoutNodeType = GraphNodeType | "start" | "end";

export const GRAPH_NODE_ICON: Record<LayoutNodeType, LucideIcon> = {
  start: Play,
  end: Flag,
  transform: Shuffle,
  branch: GitBranch,
  tool: Wrench,
  llm: Sparkles,
  agent: Bot,
  human: UserRound,
};

export const GRAPH_NODE_TYPE_LABEL: Record<LayoutNodeType, string> = {
  start: "Start",
  end: "End",
  transform: "Transform",
  branch: "Branch",
  tool: "Tool",
  llm: "Model call",
  agent: "Agent",
  human: "Human step",
};

export const GRAPH_STATUS_LABEL: Record<GraphNodeStatus, string> = {
  idle: "Not run",
  pending: "Pending",
  running: "Running",
  paused: "Waiting for you",
  done: "Done",
  error: "Failed",
};
