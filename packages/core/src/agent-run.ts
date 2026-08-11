/** Runtime-neutral agent inputs, state, dependencies, and handles. */
import type {
  NormalizedMessage,
  ResumeCommand,
  RunStatus,
  ThreadStateValues,
} from "./protocol-types.js";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import type { SkillCatalog } from "./skill.js";
import type { SkillAvailability } from "./skill-readiness.js";
import type { ToolCatalog } from "./wildcard.js";
import type { AttachmentResolver } from "./attachment.js";

export interface Logger {
  info(msg: string, ...args: unknown[]): void;
  warn(msg: string, ...args: unknown[]): void;
  error(msg: string, ...args: unknown[]): void;
  debug(msg: string, ...args: unknown[]): void;
}

export interface RuntimeDeps {
  checkpointer?: unknown;
  store?: unknown;
  /** Executable MCP tools are keyed by their qualified mcp:<server>:<tool> ref. */
  tools?: Record<string, unknown>;
  /**
   * Preserves original server tool names for wildcard expansion and display.
   */
  catalog?: ToolCatalog;
  skills?: SkillCatalog;
  /** Full readiness projection; non-ready skills are context only, never workers. */
  skillAvailability?: readonly SkillAvailability[];
  /**
   * Routes `/memories/` to a sandboxed shared filesystem backend.
   * Absence means no durable memory directory is available.
   */
  memoriesDir?: string;
  /**
   * Live memory gate checked by every durable backend operation. This can turn
   * access off for already-compiled graphs after the setting changes.
   */
  memoryEnabled?: () => boolean;
  /**
   * Resolves attachment references only at the model boundary so checkpoint
   * state never contains file bytes. Absence disables inlining.
   */
  attachmentResolver?: AttachmentResolver;
  model?: BaseChatModel;
  logger?: Logger;
}

export type RunInput =
  | { messages: NormalizedMessage[] }
  | { command: ResumeCommand };

export interface RunOptions {
  threadId: string;
  runId?: string;
  signal?: AbortSignal;
  configurable?: Record<string, unknown>;
}

export interface ThreadState {
  threadId: string;
  checkpointId: string;
  checkpointNs?: string;
  checkpointMap?: Record<string, unknown>;
  values: ThreadStateValues;
  next: string[];
  createdAt: string;
  metadata?: Record<string, unknown>;
  parentCheckpoint?: ThreadCheckpoint;
  /**
   * Durable Pregel task metadata. Subagent hydration uses task path/result
   * fields to map a parent `task` tool call to its execution namespace.
   */
  tasks?: ThreadTask[];
  /**
   * Checkpoint-derived HITL state that survives reloads and background runs.
   * Undefined when the runtime cannot expose interrupt tasks.
   */
  awaitingInput?: boolean;
  /**
   * Opaque pending interrupts used to reconstruct approval cards after reload.
   * Empty or undefined when the thread is not paused.
   */
  interrupts?: Array<{ id: string; value: unknown }>;
}

export interface ThreadCheckpoint {
  threadId: string;
  checkpointNs: string;
  checkpointId?: string;
  checkpointMap?: Record<string, unknown>;
}

export interface ThreadTask {
  id: string;
  name: string;
  path?: unknown[];
  result?: unknown;
  error?: unknown;
  interrupts: Array<{ id: string; value: unknown }>;
  checkpoint?: ThreadCheckpoint;
}

export interface Checkpoint {
  checkpointId: string;
  threadId: string;
}

export interface RunHandle {
  runId: string;
  threadId: string;
  status: RunStatus;
  startedAt: number;
  endedAt?: number;
}

/**
 * Streaming stays on concrete runtime agents because its event types would
 * introduce a runtime SDK dependency into core.
 */
export interface AgentHandle {
  getState(threadId: string, checkpointId?: string): Promise<ThreadState>;
  // `checkpointNs` scopes history to a subagent subgraph's own checkpoints
  // (its transcript), instead of the root thread's full message list.
  getStateHistory(threadId: string, checkpointNs?: string): AsyncIterable<ThreadState>;
  updateState(threadId: string, values: unknown, asNode?: string): Promise<Checkpoint>;
}
