/** DeepAgents/LangGraph runtime implementation. */
import {
  createDeepAgent,
  createFilesystemMiddleware,
  createSkillsMiddleware,
  isSandboxBackend,
  registerHarnessProfile,
  type AnyBackendProtocol,
  type SandboxBackendProtocolV2,
  type SubAgent,
} from "deepagents";
import {
  collectSkillPaths,
  resolveToolReferences,
  type AgentCatalog,
  type RuntimeDeps,
  type RunInput,
  type RunOptions,
  type Logger,
  type ToolCatalog,
  type HitlDecision,
  type InterruptConfig,
  type InterruptOnPolicy,
  BUILTIN_EVAL_TOOL_REF,
  BUILTIN_EXECUTE_TOOL_REF,
  DEFAULT_SETTINGS,
} from "@pizza-bot/core";
import type { ProtocolEvent } from "@langchain/langgraph";
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
import { streamProtocolEvents, toLangGraphInput } from "./stream-protocol.js";
import { LangGraphThreadGraph, contentText, type CompiledGraph } from "./thread-graph.js";

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

function hasEvalTool(refs: readonly string[]): boolean {
  return refs.includes(BUILTIN_EVAL_TOOL_REF);
}

function mcpToolRefs(refs: readonly string[]): string[] {
  return refs.filter((ref) => !ref.startsWith("builtin:"));
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
  executingBackend?: AnyBackendProtocol,
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
      const executes = agent.declaredTools.includes(BUILTIN_EXECUTE_TOOL_REF);
      const filesystemBackend = executes ? executingBackend : backend;
      if (!filesystemBackend) throw new Error("no shell sandbox is configured");
      // Declarative subagents bypass createDeepAgent's per-subagent defaults, so
      // filesystem and skills middleware are mounted here. The filesystem
      // middleware offers `execute` exactly when its backend can run commands.
      const middleware: unknown[] = [
        createFilesystemMiddleware({ backend: filesystemBackend }),
      ];
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
      const tools = resolveToolRefs(mcpToolRefs(agent.declaredTools), deps, who);
      const interruptOn = qualifyInterruptOn(agent.interruptOn, deps.catalog, who, logger);
      const systemPrompt = agent.systemPrompt || agent.description;
      return {
        name: agent.id,
        description: agent.description,
        systemPrompt: executes ? `${systemPrompt}\n\n${SANDBOX_PROMPT}` : systemPrompt,
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
  input: { messages: unknown[] } | object | null,
  reload: boolean,
): object | null {
  if (!reload || !input || !("messages" in input)) return input;
  return { ...input, skillsMetadata: null };
}

interface AssembledAgent {
  compiled: unknown;
  reloadsSkills: boolean;
}

const SANDBOX_PROMPT = `## Sandbox

The \`execute\` tool runs shell commands in an isolated Linux virtual machine
dedicated to this conversation, starting in /workspace. Only files under
/workspace/ are shared between the file tools and \`execute\`; commands cannot
see any other path the file tools show. Network access may be disabled.`;

function resolveSandbox(sandbox: unknown): SandboxBackendProtocolV2 | undefined {
  if (sandbox === undefined) return undefined;
  if (!isSandboxBackend(sandbox)) {
    throw new Error("RuntimeDeps.sandbox must implement the DeepAgents sandbox protocol.");
  }
  return sandbox;
}

async function assemblePizzaBot(systemPrompt: string, deps: RuntimeDeps): Promise<AssembledAgent> {
  const sandbox = resolveSandbox(deps.sandbox);
  const backendOptions = {
    ...(deps.skills ? { skills: deps.skills } : {}),
    ...(deps.memoriesDir ? { memoriesDir: deps.memoriesDir } : {}),
    ...(deps.memoryEnabled ? { memoryEnabled: deps.memoryEnabled } : {}),
    ...(deps.localFolders ? { localFolders: deps.localFolders } : {}),
    ...(sandbox ? { sandbox } : {}),
  };
  const backend = buildBackend({ ...backendOptions, sandboxExecute: true });
  // Subagents share /workspace/; only those granted `builtin:execute` can run commands in it.
  const subagentBackend = sandbox ? buildBackend(backendOptions) : backend;

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
  const subagents = await resolveAgentSubagents(
    deps.agents,
    deps,
    subagentBackend,
    sandbox ? backend : undefined,
  );

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
    systemPrompt: sandbox ? `${systemPrompt}\n\n${SANDBOX_PROMPT}` : systemPrompt,
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

class LangGraphAgent extends LangGraphThreadGraph {
  constructor(
    compiled: CompiledGraph,
    private readonly reloadsSkills: boolean,
  ) {
    super(compiled);
  }

  override streamProtocol(input: RunInput, opts: RunOptions): AsyncIterable<ProtocolEvent> {
    const lgInput = withSkillReload(toLangGraphInput(input), this.reloadsSkills);
    return streamProtocolEvents(this.compiled, lgInput, opts);
  }

  /**
   * Run one prompt as a subgraph of the calling graph node. Passing the node's
   * config nests the agent's checkpoints, stream frames, and interrupts under it.
   */
  async runAsNode(prompt: string, config: unknown): Promise<string> {
    const input = withSkillReload({ messages: [{ role: "user", content: prompt }] }, this.reloadsSkills);
    const result = (await this.compiled.invoke(input, config)) as { messages?: unknown[] };
    return contentText((result.messages?.at(-1) as { content?: unknown } | undefined)?.content);
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

export type { LangGraphAgent, LangGraphThreadGraph };

export { buildBackend } from "./backend.js";
export {
  SmolvmSandbox,
  SmolvmSandboxPool,
  createSmolvmRunner,
  machineNameForThread,
  resolveSmolvmCommand,
  type SmolvmLocation,
  type SmolvmMachineOptions,
  type SmolvmRunner,
} from "./smolvm-sandbox.js";

// Export the production stream path for protocol conformance tests.
export { streamProtocolEvents, type ProtocolCapableGraph } from "./stream-protocol.js";
export { compileGraphSpec, type GraphNodeAgent, type GraphRuntimeDeps } from "./graph-compiler.js";
