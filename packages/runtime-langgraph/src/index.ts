/** DeepAgents/LangGraph runtime implementation. */
import {
  createDeepAgent,
  createFilesystemMiddleware,
  createSkillsMiddleware,
  registerHarnessProfile,
  type AnyBackendProtocol,
  type SubAgent,
} from "deepagents";
import {
  collectSkillPaths,
  resolveToolReferences,
  type AgentCatalog,
  type RuntimeDeps,
  type AgentHandle,
  type RunInput,
  type RunOptions,
  type ThreadState,
  type ThreadCheckpoint,
  type ThreadTask,
  type StateHistoryOptions,
  type Checkpoint,
  type Logger,
  type ToolCatalog,
  type HitlDecision,
  type InterruptConfig,
  type InterruptOnPolicy,
  BUILTIN_EVAL_TOOL_REF,
  DEFAULT_SETTINGS,
} from "@pizza-bot/core";
import type { ThreadStateValues } from "@pizza-bot/core";
import type { ProtocolEvent, StateSnapshot } from "@langchain/langgraph";
import { modelCallLimitMiddleware, toolCallLimitMiddleware } from "langchain";
import { buildBackend } from "./backend.js";
import { toolErrorRecoveryMiddleware } from "./tool-error-middleware.js";
import { outputTruncationMiddleware, blankTurnMiddleware } from "./output-truncation-middleware.js";
import { subagentFinalizationMiddleware } from "./subagent-finalization-middleware.js";
import { structuredResponseMiddleware } from "./structured-response-middleware.js";
import { attachmentInlineMiddleware } from "./attachment-inline-middleware.js";
import { currentDateTimeMiddleware } from "./current-date-time-middleware.js";
import { localFolderContextMiddleware } from "./local-folder-context-middleware.js";
import { createWorkerCodeInterpreterMiddleware } from "./code-interpreter-middleware.js";
import { taskDispatchMiddleware } from "./task-dispatch-middleware.js";
import { applyAgentGrounding } from "./agent-grounding.js";
import { evidenceLedgerMiddleware } from "./evidence-ledger-middleware.js";
import { streamProtocolEvents, toLangGraphInput, type ProtocolCapableGraph } from "./stream-protocol.js";

// The built-in Codex profile otherwise restores the opt-in planning middleware.
registerHarnessProfile("openai", { excludedMiddleware: ["todoListMiddleware"] });

export const AGENT_RUN_LIMITS = {
  orchestrator: {
    modelCalls: 40,
    toolCalls: DEFAULT_SETTINGS.maxToolCalls,
  },
  subagent: {
    modelCalls: 40,
    toolCalls: DEFAULT_SETTINGS.maxSubagentToolCalls,
  },
} as const;

interface RunLimits {
  modelCalls: number;
  toolCalls: number;
}

interface RunLimitMiddlewareOptions {
  runLimit: number;
  exitBehavior: "continue" | "end";
}

function runLimitMiddleware(limits: RunLimits): unknown[] {
  // LangChain's Zod interop type collapses these options under TypeScript 5.
  const createModelCallLimit = modelCallLimitMiddleware as unknown as (
    options: RunLimitMiddlewareOptions,
  ) => unknown;
  const createToolCallLimit = toolCallLimitMiddleware as unknown as (
    options: RunLimitMiddlewareOptions,
  ) => unknown;
  const middleware: unknown[] = [
    createModelCallLimit({
      runLimit: limits.modelCalls,
      exitBehavior: "end",
    }),
  ];
  if (limits.toolCalls !== -1) {
    // The limiter clears its per-run counter only once the graph completes, so blocking
    // the excess in place is what keeps each turn's budget its own; a model that keeps
    // requesting blocked tools stays bounded by the model-call ceiling.
    middleware.push(createToolCallLimit({
      runLimit: limits.toolCalls,
      exitBehavior: "continue",
    }));
  }
  return middleware;
}

/** What `true` grants in the upstream HITL middleware. */
const DEFAULT_HITL_DECISIONS: readonly HitlDecision[] = ["approve", "edit", "reject", "respond"];

/** The decisions both configs allow; never empty, so an overlap can't silently stop asking. */
function narrowInterruptConfig(
  a: InterruptConfig,
  b: InterruptConfig,
): InterruptConfig {
  if (a === false) return b;
  if (b === false) return a;
  if (a === true && b === true) return true;
  const decisions = (c: true | { allowedDecisions: HitlDecision[] }) =>
    c === true ? DEFAULT_HITL_DECISIONS : c.allowedDecisions;
  const shared = decisions(a).filter((d) => decisions(b).includes(d));
  return { allowedDecisions: shared.length > 0 ? shared : ["approve", "reject"] };
}

/**
 * MCP tools are bound under their server-prefixed executable name
 * (`<server>__<tool>`), but the HITL middleware matches `interruptOn` keys
 * against that live tool name. Expand wildcard refs and requalify every concrete
 * tool so approval policy follows the same resolution rules as tool grants. A tool
 * asks first if any ref covering it does; `false` never cancels another ref's ask.
 */
function qualifyInterruptOn(
  interruptOn: InterruptOnPolicy | undefined,
  catalog: ToolCatalog | undefined,
  who: string,
  logger?: Logger,
): InterruptOnPolicy | undefined {
  if (!interruptOn) return interruptOn;
  const out: InterruptOnPolicy = {};
  for (const [ref, config] of Object.entries(interruptOn)) {
    if (config === false) continue;
    if (!ref.startsWith("mcp:")) {
      logger?.warn(`${who}: interruptOn ref "${ref}" is not an MCP tool — skipping`);
      continue;
    }
    const { expanded, emptyWildcards, invalid } = resolveToolReferences(
      [ref],
      catalog ?? {},
    );
    for (const wildcard of emptyWildcards) {
      logger?.warn(`${who}: interruptOn wildcard "${wildcard}" matched no connected tool — skipping`);
    }
    for (const badRef of invalid) {
      logger?.warn(`${who}: invalid interruptOn tool ref "${badRef}" — skipping`);
    }
    for (const concreteRef of expanded) {
      const name = executableToolName(concreteRef);
      const previous = out[name];
      out[name] = previous === undefined ? config : narrowInterruptConfig(previous, config);
    }
  }
  return out;
}

function executableToolName(ref: string): string {
  const [, server, tool] = ref.split(":");
  return `${server}__${tool}`;
}

/** Inverts the executable name a model calls back to the ref that named the tool. */
function executableRefIndex(
  refs: readonly string[],
  catalog: ToolCatalog | undefined,
): Map<string, string> {
  const { expanded } = resolveToolReferences([...refs], catalog ?? {});
  return new Map(expanded.map((ref) => [executableToolName(ref), ref]));
}

function hasEvalTool(refs: readonly string[]): boolean {
  return refs.includes(BUILTIN_EVAL_TOOL_REF);
}

function mcpToolRefs(refs: readonly string[]): string[] {
  return refs.filter((ref) => ref !== BUILTIN_EVAL_TOOL_REF);
}

/**
 * The filesystem tools bridged into the sandbox as the `tools.*` namespace. The
 * mutating two are bridged unconditionally: the backend re-reads each grant's
 * `readOnly` flag per call, so a withheld tool would duplicate a gate that is
 * already live while the bridge is fixed at build time.
 */
const EVAL_PTC_TOOLS = [
  "ls",
  "read_file",
  "glob",
  "grep",
  "write_file",
  "edit_file",
] as const;

export function codeInterpreterOptions(hasSubagents: boolean) {
  return {
    // Only MCP tools are withheld: reaching them from code would bypass the HITL
    // approval an agent declares through `interruptOn`.
    ptc: [...EVAL_PTC_TOOLS] as string[],
    // Deliberately above the upstream default: the sandbox exists so bulk data
    // stays inside it and only a distillate returns through this string.
    maxResultChars: 8_000,
    // Charged only for guest execution — awaited reads and subagent dispatch are
    // free — and a long budget is safe because guest code runs on a worker thread.
    executionTimeoutMs: 120_000,
    subagents: hasSubagents,
    // Matches upstream's default cap on concurrent `task()` calls per REPL.
    maxSubagentConcurrency: 32,
  } as const;
}

async function codeInterpreterMiddleware(
  hasSubagents: boolean,
  approvalGatedSubagents: readonly string[] = [],
): Promise<unknown> {
  try {
    return await createWorkerCodeInterpreterMiddleware({
      ...codeInterpreterOptions(hasSubagents),
      approvalGatedSubagents,
    });
  } catch (error) {
    if ((error as { code?: unknown } | null)?.code !== "ERR_MODULE_NOT_FOUND") throw error;
    throw new Error(
      `An agent declares "${BUILTIN_EVAL_TOOL_REF}" but @langchain/quickjs is not installed. ` +
        "Install the optional dependency to enable sandboxed evaluation.",
      { cause: error },
    );
  }
}

/** Resolve concrete and wildcard refs, rejecting any incomplete tool grant. */
function resolveToolRefs(
  refs: readonly string[],
  deps: RuntimeDeps,
  who: string,
): unknown[] {
  const { expanded, emptyWildcards, invalid } = resolveToolReferences(refs, deps.catalog ?? {});
  if (emptyWildcards.length > 0) {
    throw new Error(`${who}: wildcard "${emptyWildcards[0]}" matched no connected tool`);
  }
  if (invalid.length > 0) {
    throw new Error(`${who}: invalid tool ref "${invalid[0]}"`);
  }
  const resolved: unknown[] = [];
  for (const ref of expanded) {
    const instance = deps.tools?.[ref];
    if (instance) resolved.push(instance);
    else throw new Error(`${who}: tool ref "${ref}" resolved to no loaded tool`);
  }
  return resolved;
}

/**
 * Compile one isolated subagent per ready agent definition. The definition is
 * the subagent's whole identity: prompt, model, tool surface, skills, approvals.
 */
export async function resolveAgentSubagents(
  agents: AgentCatalog | undefined,
  deps: RuntimeDeps,
  backend: AnyBackendProtocol,
): Promise<readonly SubAgent[] | undefined> {
  if (!agents?.size) return undefined;
  const logger = deps.logger;
  const limits = {
    ...AGENT_RUN_LIMITS.subagent,
    toolCalls: deps.maxSubagentToolCalls ?? AGENT_RUN_LIMITS.subagent.toolCalls,
  };
  const resolved = await Promise.all([...agents.values()].map(async (agent) => {
    try {
      const model = deps.agentModels?.get(agent.id) ?? deps.model;
      if (!model) throw new Error("no model resolved");
      // Declarative subagents bypass createDeepAgent's per-subagent defaults, so
      // filesystem and skills middleware are mounted here, on the shared backend.
      const middleware: unknown[] = [createFilesystemMiddleware({ backend })];
      const skillSources = collectSkillPaths(agent.skills, deps.skills);
      if (skillSources.length > 0) {
        middleware.push(createSkillsMiddleware({ backend, sources: skillSources }));
      }
      middleware.push(
        ...runLimitMiddleware(limits),
        subagentFinalizationMiddleware(AGENT_RUN_LIMITS.subagent.modelCalls),
        structuredResponseMiddleware(),
        toolErrorRecoveryMiddleware(),
        outputTruncationMiddleware(),
        currentDateTimeMiddleware(),
      );
      if (deps.localFolders) {
        middleware.push(localFolderContextMiddleware(deps.localFolders));
      }
      if (hasEvalTool(agent.declaredTools)) {
        middleware.push(await codeInterpreterMiddleware(false));
      }
      const who = `agent "${agent.id}"`;
      const { tools, interruptOn, groundedTools } = applyAgentGrounding(
        resolveToolRefs(mcpToolRefs(agent.declaredTools), deps, who),
        qualifyInterruptOn(agent.interruptOn, deps.catalog, who, logger),
      );
      // Only an agent that cites anything needs a ledger to cite from.
      if (groundedTools.length > 0 && deps.evidenceRecorder) {
        middleware.push(evidenceLedgerMiddleware({
          recorder: deps.evidenceRecorder,
          refsByToolName: executableRefIndex(mcpToolRefs(agent.declaredTools), deps.catalog),
          gatedToolNames: new Set(Object.keys(interruptOn ?? {})),
          ...(logger ? { logger } : {}),
        }));
      }
      return {
        name: agent.id,
        description: agent.description,
        systemPrompt: agent.systemPrompt || agent.description,
        model,
        tools,
        middleware,
        ...(interruptOn && Object.keys(interruptOn).length > 0 ? { interruptOn } : {}),
      } as unknown as SubAgent;
    } catch (err) {
      logger?.warn(
        `[agents] subagent "${agent.id}" disabled: ${err instanceof Error ? err.message : String(err)}`,
      );
      return null;
    }
  }));
  const usable = resolved.filter((sa): sa is SubAgent => sa !== null);
  return usable.length ? usable : undefined;
}

/** Message turns force a skills reload so catalog edits reach existing threads. */
export function withSkillReload(
  input: { messages: unknown[] } | object,
  reload: boolean,
): object {
  if (!reload || !("messages" in input)) return input;
  return { ...input, skillsMetadata: null };
}

interface AssembledAgent {
  compiled: unknown;
  reloadsSkills: boolean;
}

async function assemblePizzaBot(systemPrompt: string, deps: RuntimeDeps): Promise<AssembledAgent> {
  // DeepAgents builds one backend shared by the orchestrator and subagents.
  const backend = buildBackend({
    ...(deps.skills ? { skills: deps.skills } : {}),
    ...(deps.memoriesDir ? { memoriesDir: deps.memoriesDir } : {}),
    ...(deps.memoryEnabled ? { memoryEnabled: deps.memoryEnabled } : {}),
    ...(deps.localFolders ? { localFolders: deps.localFolders } : {}),
  });

  const middleware: unknown[] = [
    // Subagents get outputTruncationMiddleware's notice instead; this one retries
    // cut-off tool calls and flags the turn for the human. It comes first because
    // afterModel hooks run in reverse and a jump skips the rest, so the model-call
    // counter must already have run when it retries.
    blankTurnMiddleware(),
    ...runLimitMiddleware({
      ...AGENT_RUN_LIMITS.orchestrator,
      toolCalls: deps.maxToolCalls ?? AGENT_RUN_LIMITS.orchestrator.toolCalls,
    }),
    toolErrorRecoveryMiddleware(),
    currentDateTimeMiddleware(),
  ];
  if (deps.localFolders) {
    middleware.push(localFolderContextMiddleware(deps.localFolders));
  }
  // Keep attachment bytes out of checkpoints and inline them only for model calls.
  if (deps.attachmentResolver) {
    middleware.push(attachmentInlineMiddleware(deps.attachmentResolver));
  }

  const model = deps.model;
  // Declarative, not compiled: DeepAgents rebuilds a declarative spec per call to
  // apply an eval task()'s responseSchema, and rejects one for a compiled subagent.
  const subagents = await resolveAgentSubagents(deps.agents, deps, backend);

  // The roster goes to this middleware alone, never to createDeepAgent: it replaces
  // DeepAgents' own by name, so a roster given there would only gain upstream's
  // default subagent middleware and be compiled for nothing.
  middleware.push(taskDispatchMiddleware({
    ...(model ? { model } : {}),
    subagents: subagents ?? [],
  }));
  // The sandbox's task() global only has somewhere to dispatch when subagents exist.
  middleware.push(await codeInterpreterMiddleware(
    Boolean(subagents?.length),
    (subagents ?? []).filter((subagent) => subagent.interruptOn).map((subagent) => subagent.name),
  ));

  const params: Record<string, unknown> = {
    systemPrompt,
    backend,
    middleware,
  };
  if (model) params.model = model;
  if (deps.checkpointer) params.checkpointer = deps.checkpointer;
  if (deps.store) params.store = deps.store;
  const rootSkills = collectSkillPaths(deps.rootSkills, deps.skills);
  if (rootSkills.length > 0) params.skills = rootSkills;

  const compiled = await createDeepAgent(params as never);
  return { compiled, reloadsSkills: rootSkills.length > 0 };
}

interface CompiledGraph extends ProtocolCapableGraph {
  stream(
    input: unknown,
    config: Record<string, unknown>,
  ): Promise<AsyncIterable<unknown>>;
  getState(config: Record<string, unknown>): Promise<StateSnapshot>;
  getStateHistory(
    config: Record<string, unknown>,
    options?: { limit?: number; before?: { configurable?: { checkpoint_id?: string } } },
  ): AsyncIterable<StateSnapshot>;
  updateState(
    config: Record<string, unknown>,
    values: unknown,
    asNode?: string,
  ): Promise<{ configurable?: { checkpoint_id?: string } }>;
}

type RuntimeTask = StateSnapshot["tasks"][number];

/**
 * Detect HITL from checkpoint task interrupts. `next` also covers non-HITL
 * pauses, while task interrupts remain authoritative across reloads.
 */
function snapshotAwaitingInput(snap: {
  tasks?: ReadonlyArray<{ interrupts?: ReadonlyArray<unknown> }>;
}): boolean {
  return (snap.tasks ?? []).some((t) => (t.interrupts?.length ?? 0) > 0);
}

/** Preserve durable HITL payloads so the SDK can rebuild approval state. */
function snapshotInterrupts(snap: {
  tasks?: ReadonlyArray<{ interrupts?: ReadonlyArray<{ id?: unknown; value?: unknown }> }>;
}): Array<{ id: string; value: unknown }> {
  const out: Array<{ id: string; value: unknown }> = [];
  for (const task of snap.tasks ?? []) {
    for (const it of task.interrupts ?? []) {
      if (typeof it?.id === "string") out.push({ id: it.id, value: it.value });
    }
  }
  return out;
}

function checkpointFromConfig(config: unknown): ThreadCheckpoint | undefined {
  if (config == null || typeof config !== "object") return undefined;
  const configurable = (config as {
    configurable?: {
      thread_id?: unknown;
      checkpoint_id?: unknown;
      checkpoint_ns?: unknown;
      checkpoint_map?: unknown;
    };
  }).configurable;
  if (configurable == null || typeof configurable !== "object") return undefined;
  const threadId = configurable.thread_id;
  if (typeof threadId !== "string") return undefined;
  const checkpointId = configurable.checkpoint_id;
  const checkpointNs = configurable.checkpoint_ns;
  const checkpointMap = configurable.checkpoint_map;
  return {
    threadId,
    checkpointNs: typeof checkpointNs === "string" ? checkpointNs : "",
    ...(typeof checkpointId === "string" ? { checkpointId } : {}),
    ...(checkpointMap != null && typeof checkpointMap === "object"
      ? { checkpointMap: checkpointMap as Record<string, unknown> }
      : {}),
  };
}

function taskCheckpoint(state: unknown): ThreadCheckpoint | undefined {
  if (state == null || typeof state !== "object") return undefined;
  const nestedConfig = (state as { config?: unknown }).config;
  return checkpointFromConfig(nestedConfig ?? state);
}

function snapshotTasks(snap: { tasks?: ReadonlyArray<RuntimeTask> }): ThreadTask[] {
  return (snap.tasks ?? []).map((task) => {
    const checkpoint = taskCheckpoint(task.state);
    return {
      id: task.id,
      name: task.name,
      ...(task.path ? { path: [...task.path] } : {}),
      ...(task.result !== undefined ? { result: task.result } : {}),
      ...(task.error !== undefined ? { error: task.error } : {}),
      interrupts: (task.interrupts ?? []).flatMap((interrupt) =>
        typeof interrupt.id === "string"
          ? [{ id: interrupt.id, value: interrupt.value }]
          : [],
      ),
      ...(checkpoint ? { checkpoint } : {}),
    };
  });
}

class LangGraphAgent implements AgentHandle {
  constructor(
    private readonly compiled: CompiledGraph,
    private readonly reloadsSkills: boolean,
  ) {}

  streamProtocol(input: RunInput, opts: RunOptions): AsyncIterable<ProtocolEvent> {
    const lgInput = withSkillReload(toLangGraphInput(input), this.reloadsSkills);
    return streamProtocolEvents(this.compiled, lgInput, opts);
  }

  async getState(threadId: string, checkpointId?: string): Promise<ThreadState> {
    const config = {
      configurable: {
        thread_id: threadId,
        ...(checkpointId ? { checkpoint_id: checkpointId } : {}),
      },
    };
    const snap = await this.compiled.getState(config);
    const checkpoint = checkpointFromConfig(snap.config);
    const parentCheckpoint = checkpointFromConfig(snap.parentConfig);
    return {
      threadId,
      checkpointId: snap.config.configurable?.checkpoint_id ?? "",
      checkpointNs: checkpoint?.checkpointNs ?? "",
      ...(checkpoint?.checkpointMap ? { checkpointMap: checkpoint.checkpointMap } : {}),
      values: (snap.values ?? {}) as ThreadStateValues,
      next: snap.next,
      createdAt: snap.createdAt ?? "",
      metadata: snap.metadata ?? {},
      ...(parentCheckpoint ? { parentCheckpoint } : {}),
      tasks: snapshotTasks(snap),
      awaitingInput: snapshotAwaitingInput(snap),
      interrupts: snapshotInterrupts(snap),
    };
  }

  async *getStateHistory(
    threadId: string,
    options?: StateHistoryOptions,
  ): AsyncIterable<ThreadState> {
    const checkpointNs = options?.checkpointNs;
    const config = {
      configurable: { thread_id: threadId, ...(checkpointNs ? { checkpoint_ns: checkpointNs } : {}) },
    };
    // The checkpointer only appends SQL LIMIT when it receives one; without it
    // the saver materializes every row for the thread and namespace at once.
    const listOptions = {
      ...(options?.limit != null ? { limit: options.limit } : {}),
      ...(options?.beforeCheckpointId != null
        ? { before: { configurable: { checkpoint_id: options.beforeCheckpointId } } }
        : {}),
    };
    for await (const snap of this.compiled.getStateHistory(config, listOptions)) {
      const checkpoint = checkpointFromConfig(snap.config);
      const parentCheckpoint = checkpointFromConfig(snap.parentConfig);
      yield {
        threadId,
        checkpointId: snap.config.configurable?.checkpoint_id ?? "",
        checkpointNs: checkpoint?.checkpointNs ?? checkpointNs ?? "",
        ...(checkpoint?.checkpointMap ? { checkpointMap: checkpoint.checkpointMap } : {}),
        values: (snap.values ?? {}) as ThreadStateValues,
        next: snap.next,
        createdAt: snap.createdAt ?? "",
        metadata: snap.metadata ?? {},
        ...(parentCheckpoint ? { parentCheckpoint } : {}),
        tasks: snapshotTasks(snap),
        awaitingInput: snapshotAwaitingInput(snap),
        interrupts: snapshotInterrupts(snap),
      };
    }
  }

  async updateState(threadId: string, values: unknown, asNode?: string): Promise<Checkpoint> {
    const config = { configurable: { thread_id: threadId } };
    const next = await this.compiled.updateState(config, values, asNode);
    return { checkpointId: next.configurable?.checkpoint_id ?? "", threadId };
  }
}

/** Compile the Pizza Bot graph and one subagent per ready agent definition. */
export async function createPizzaBotAgent(
  systemPrompt: string,
  deps: RuntimeDeps,
): Promise<LangGraphAgent> {
  const requiresHitl = [...(deps.agents?.values() ?? [])]
    .some((agent) =>
      Object.entries(agent.interruptOn)
        .some(([ref, config]) => ref.startsWith("mcp:") && config !== false),
    );
  if (requiresHitl && !deps.checkpointer) {
    throw new Error(
      "An agent declares interruptOn; a checkpointer is required for HITL but none was provided.",
    );
  }
  const { compiled, reloadsSkills } = await assemblePizzaBot(systemPrompt, deps);
  return new LangGraphAgent(compiled as CompiledGraph, reloadsSkills);
}

export type { LangGraphAgent };

export { buildBackend } from "./backend.js";

// Export the production stream path for protocol conformance tests.
export { streamProtocolEvents, type ProtocolCapableGraph } from "./stream-protocol.js";
