/** DeepAgents/LangGraph runtime implementation. */
import {
  createDeepAgent,
  createSubAgent,
  registerHarnessProfile,
  type CompiledSubAgent,
  type SubAgent,
} from "deepagents";
import {
  collectSkillFiles,
  collectSkillPaths,
  normalizeSkillFile,
  resolveToolReferences,
  splitSkillMd,
  SKILL_MD,
  type RuntimeDeps,
  type AgentHandle,
  type RunInput,
  type RunOptions,
  type ThreadState,
  type ThreadCheckpoint,
  type ThreadTask,
  type Checkpoint,
  type SkillCatalog,
  type SkillCatalogEntry,
  type Logger,
  type ToolCatalog,
  BUILTIN_EVAL_TOOL_REF,
} from "@pizza-bot/core";
import type { ThreadStateValues } from "@pizza-bot/core";
import type { ProtocolEvent, StateSnapshot } from "@langchain/langgraph";
import { RunnableLambda } from "@langchain/core/runnables";
import { modelCallLimitMiddleware, toolCallLimitMiddleware } from "langchain";
import { buildBackend } from "./backend.js";
import { toolErrorRecoveryMiddleware } from "./tool-error-middleware.js";
import { outputTruncationMiddleware } from "./output-truncation-middleware.js";
import { attachmentInlineMiddleware } from "./attachment-inline-middleware.js";
import { currentDateTimeMiddleware } from "./current-date-time-middleware.js";
import { streamProtocolEvents, toLangGraphInput, type ProtocolCapableGraph } from "./stream-protocol.js";

// The built-in Codex profile otherwise restores the opt-in planning middleware.
registerHarnessProfile("openai", { excludedMiddleware: ["todoListMiddleware"] });

export const AGENT_RUN_LIMITS = {
  modelCalls: 20,
  toolCalls: 40,
} as const;

interface RunLimitOptions {
  runLimit: number;
  exitBehavior: "end" | "error";
}

function runLimitMiddleware(): unknown[] {
  // LangChain's Zod interop type collapses these options under TypeScript 5.
  const createModelCallLimit = modelCallLimitMiddleware as unknown as (
    options: RunLimitOptions,
  ) => unknown;
  const createToolCallLimit = toolCallLimitMiddleware as unknown as (
    options: RunLimitOptions,
  ) => unknown;
  return [
    createModelCallLimit({
      runLimit: AGENT_RUN_LIMITS.modelCalls,
      exitBehavior: "end",
    }),
    createToolCallLimit({
      runLimit: AGENT_RUN_LIMITS.toolCalls,
      exitBehavior: "error",
    }),
  ];
}

// DeepAgents returns arbitrary child state to the parent; limiter counters are invocation-local.
const SUBAGENT_STATE_EXCLUSIONS = [
  "threadModelCallCount",
  "runModelCallCount",
  "threadToolCallCount",
  "runToolCallCount",
] as const;

function excludeSubagentLocalState(state: Record<string, unknown>): Record<string, unknown> {
  const filtered = { ...state };
  for (const key of SUBAGENT_STATE_EXCLUSIONS) delete filtered[key];
  return filtered;
}

function isolateSubagentLocalState(runnable: ReturnType<typeof createSubAgent>) {
  return RunnableLambda.from(async (state: Record<string, unknown>, config) => {
    const input = excludeSubagentLocalState(state) as Parameters<typeof runnable.invoke>[0];
    const result = await runnable.invoke(input, config);
    return excludeSubagentLocalState(result as Record<string, unknown>);
  });
}

/**
 * MCP tools are bound under their server-prefixed executable name
 * (`<server>__<tool>`), but the HITL middleware matches `interruptOn` keys
 * against that live tool name. Expand wildcard refs and requalify every concrete
 * tool so approval policy follows the same resolution rules as tool grants.
 */
function qualifyInterruptOn<T>(
  interruptOn: Record<string, T> | undefined,
  catalog: ToolCatalog | undefined,
  who: string,
  logger?: Logger,
): Record<string, T> | undefined {
  if (!interruptOn) return interruptOn;
  const out: Record<string, T> = {};
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
      out[executableToolName(concreteRef)] = config;
    }
  }
  return out;
}

function executableToolName(ref: string): string {
  const [, server, tool] = ref.split(":");
  return `${server}__${tool}`;
}

function hasEvalTool(refs: readonly string[]): boolean {
  return refs.includes(BUILTIN_EVAL_TOOL_REF);
}

function mcpToolRefs(refs: readonly string[]): string[] {
  return refs.filter((ref) => ref !== BUILTIN_EVAL_TOOL_REF);
}

export function codeInterpreterOptions(hasSubagents: boolean) {
  return {
    memoryLimitBytes: 32 * 1024 * 1024,
    maxStackSizeBytes: 320 * 1024,
    executionTimeoutMs: hasSubagents ? 120_000 : 15_000,
    maxPtcCalls: 16,
    maxResultChars: 8_000,
    captureConsole: true,
    subagents: hasSubagents,
  } as const;
}

async function codeInterpreterMiddleware(hasSubagents: boolean): Promise<unknown> {
  try {
    const { createCodeInterpreterMiddleware } = await import("@langchain/quickjs");
    // PTC is intentionally omitted: eval cannot invoke arbitrary agent tools.
    return createCodeInterpreterMiddleware(codeInterpreterOptions(hasSubagents));
  } catch {
    throw new Error(
      `An agent declares "${BUILTIN_EVAL_TOOL_REF}" but @langchain/quickjs is not installed. ` +
        "Install the optional dependency to enable sandboxed evaluation.",
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
 * Derive one isolated worker from each skill. The skill catalog is the only
 * source of subagent identity, instructions, tools, and HITL policy.
 */
export async function resolveSkillSubagents(
  skills: SkillCatalog | undefined,
  deps: RuntimeDeps,
): Promise<readonly SubAgent[] | undefined> {
  if (!skills?.size) return undefined;
  const logger = deps.logger;
  const entries = [...skills.values()];
  const resolved = await Promise.all(entries.map(async (entry) => {
    try {
      const middleware: unknown[] = [
        ...runLimitMiddleware(),
        toolErrorRecoveryMiddleware(),
        outputTruncationMiddleware(),
        currentDateTimeMiddleware(),
      ];
      if (hasEvalTool(entry.declaredTools)) {
        middleware.push(await codeInterpreterMiddleware(false));
      }
      const tools = resolveToolRefs(
        mcpToolRefs(entry.declaredTools),
        deps,
        `skill "${entry.id}"`,
      );
      const interruptOn = qualifyInterruptOn(
        entry.interruptOn,
        deps.catalog,
        `skill "${entry.id}"`,
        logger,
      );
      return {
        name: entry.id,
        description: entry.description,
        systemPrompt: skillBody(entry) || entry.description,
        tools,
        skills: collectSkillPaths([entry.id], skills),
        middleware,
        ...(interruptOn && Object.keys(interruptOn).length > 0 ? { interruptOn } : {}),
      } as unknown as SubAgent;
    } catch (err) {
      logger?.warn(
        `[skills] worker "${entry.id}" disabled: ${err instanceof Error ? err.message : String(err)}`,
      );
      return null;
    }
  }));
  const usable = resolved.filter((sa): sa is SubAgent => sa !== null);
  return usable.length ? usable : undefined;
}

function skillBody(entry: SkillCatalogEntry): string {
  const skillMd = entry.files.find((file) => file.path.endsWith(`/${SKILL_MD}`));
  if (!skillMd) return "";
  const content = normalizeSkillFile(skillMd).content;
  return typeof content === "string" ? splitSkillMd(content).body.trim() : "";
}

export interface StateFile {
  content: string | Uint8Array;
  mimeType: string;
  created_at: string;
  modified_at: string;
}

/**
 * Materialize all equipped skills in shared run state. Each participant receives
 * only its own skill paths, so shared seeding does not leak skills into prompts.
 */
export function buildSkillSeed(deps: RuntimeDeps): Record<string, StateFile> {
  const contentByPath = collectSkillFiles(
    deps.skills ? [...deps.skills.keys()] : [],
    deps.skills,
  );
  const now = new Date().toISOString();
  const seed: Record<string, StateFile> = {};
  for (const [path, { content, mimeType }] of Object.entries(contentByPath)) {
    seed[path] = { content, mimeType, created_at: now, modified_at: now };
  }
  return seed;
}

/** Seed message turns only; resume commands use skills already in persisted state. */
export function withSkillSeed(
  input: { messages: unknown[] } | object,
  seed: Record<string, StateFile> | undefined,
): { messages: unknown[]; files?: Record<string, StateFile> } | object {
  if (!seed || !("messages" in input)) return input;
  return { ...input, files: seed };
}

interface AssembledAgent {
  compiled: unknown;
  skillSeed?: Record<string, StateFile>;
}

async function assemblePizzaBot(systemPrompt: string, deps: RuntimeDeps): Promise<AssembledAgent> {
  // DeepAgents builds one backend shared by the orchestrator and subagents.
  const backend = buildBackend({
    ...(deps.memoriesDir ? { memoriesDir: deps.memoriesDir } : {}),
    ...(deps.memoryEnabled ? { memoryEnabled: deps.memoryEnabled } : {}),
  });

  const middleware: unknown[] = [
    ...runLimitMiddleware(),
    toolErrorRecoveryMiddleware(),
    currentDateTimeMiddleware(),
  ];
  // Keep attachment bytes out of checkpoints and inline them only for model calls.
  if (deps.attachmentResolver) {
    middleware.push(attachmentInlineMiddleware(deps.attachmentResolver));
  }
  // DeepAgents always provides its synchronous general-purpose subagent, so the
  // root interpreter can dispatch through task() even when no skills are loaded.
  middleware.push(await codeInterpreterMiddleware(true));

  const model = deps.model;
  const resolvedSubagents = await resolveSkillSubagents(deps.skills, deps);
  const subagents = resolvedSubagents?.map((subagent): SubAgent | CompiledSubAgent => {
    if (!model) {
      throw new Error("Pizza Bot requires a resolved model before compiling skill workers.");
    }
    return {
      name: subagent.name,
      description: subagent.description,
      runnable: isolateSubagentLocalState(
        createSubAgent({
          ...subagent,
          model,
          tools: subagent.tools ?? [],
        }),
      ),
    };
  });

  const params: Record<string, unknown> = {
    systemPrompt,
    backend,
    middleware,
  };
  if (model) params.model = model;
  if (subagents?.length) params.subagents = subagents;
  if (deps.checkpointer) params.checkpointer = deps.checkpointer;
  if (deps.store) params.store = deps.store;

  // Workers receive their SKILL.md body as their system prompt; the seed retains
  // sibling files without coaching the root to read skill instructions.
  const skillSeed = buildSkillSeed(deps);
  const hasSeed = Object.keys(skillSeed).length > 0;

  const compiled = await createDeepAgent(params as never);
  return { compiled, ...(hasSeed ? { skillSeed } : {}) };
}

interface CompiledGraph extends ProtocolCapableGraph {
  stream(
    input: unknown,
    config: Record<string, unknown>,
  ): Promise<AsyncIterable<unknown>>;
  getState(config: Record<string, unknown>): Promise<StateSnapshot>;
  getStateHistory(config: Record<string, unknown>): AsyncIterable<StateSnapshot>;
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
    private readonly skillSeed?: Record<string, StateFile>,
  ) {}

  /** Stream native protocol frames, seeding skills only on message turns. */
  streamProtocol(input: RunInput, opts: RunOptions): AsyncIterable<ProtocolEvent> {
    const lgInput = withSkillSeed(toLangGraphInput(input), this.skillSeed);
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

  async *getStateHistory(threadId: string, checkpointNs?: string): AsyncIterable<ThreadState> {
    const config = {
      configurable: { thread_id: threadId, ...(checkpointNs ? { checkpoint_ns: checkpointNs } : {}) },
    };
    for await (const snap of this.compiled.getStateHistory(config)) {
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

/** Compile the static Pizza Bot graph and its skill-derived workers. */
export async function createPizzaBotAgent(
  systemPrompt: string,
  deps: RuntimeDeps,
): Promise<LangGraphAgent> {
  const requiresHitl = [...(deps.skills?.values() ?? [])]
    .some((skill) =>
      Object.entries(skill.interruptOn)
        .some(([ref, config]) => ref.startsWith("mcp:") && config !== false),
    );
  if (requiresHitl && !deps.checkpointer) {
    throw new Error(
      "A skill declares interruptOn; a checkpointer is required for HITL but none was provided.",
    );
  }
  const { compiled, skillSeed } = await assemblePizzaBot(systemPrompt, deps);
  return new LangGraphAgent(compiled as CompiledGraph, skillSeed);
}

export type { LangGraphAgent };

export { buildBackend } from "./backend.js";

// Export the production stream path for protocol conformance tests.
export { streamProtocolEvents, type ProtocolCapableGraph } from "./stream-protocol.js";
