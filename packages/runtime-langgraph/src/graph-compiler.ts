/** Compiles a declarative GraphSpec into a checkpointed LangGraph StateGraph. */
import {
  Annotation,
  END,
  START,
  StateGraph,
  interrupt,
  type BaseCheckpointSaver,
  type LangGraphRunnableConfig,
} from "@langchain/langgraph";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { HumanMessage, SystemMessage, type BaseMessage } from "@langchain/core/messages";
import type { StructuredToolInterface } from "@langchain/core/tools";
import {
  GRAPH_END,
  GRAPH_START,
  evaluateCondition,
  graphStateKeys,
  renderText,
  renderValue,
  type GraphHumanRequest,
  type GraphNodeSpec,
  type GraphSpec,
} from "@pizza-bot/core";
import { LangGraphThreadGraph, contentText, type CompiledGraph } from "./thread-graph.js";

export interface GraphNodeAgent {
  runAsNode(prompt: string, config: unknown): Promise<string>;
}

/** Resolved per node execution, so model and MCP reloads reach graphs compiled earlier. */
export interface GraphRuntimeDeps {
  checkpointer?: BaseCheckpointSaver;
  agentFor(modelId?: string, agentId?: string): Promise<GraphNodeAgent>;
  modelFor(modelId?: string): Promise<BaseChatModel>;
  tool(ref: string): StructuredToolInterface | undefined;
}

type GraphState = Record<string, unknown>;
type NodeFn = (state: GraphState, config: LangGraphRunnableConfig) => Promise<GraphState>;

interface LooseBuilder {
  addNode(id: string, fn: NodeFn): LooseBuilder;
  addEdge(from: string, to: string): LooseBuilder;
  addConditionalEdges(
    from: string,
    route: (state: GraphState) => string,
    pathMap: Record<string, string>,
  ): LooseBuilder;
  compile(options: { checkpointer?: BaseCheckpointSaver }): unknown;
}

export function compileGraphSpec(spec: GraphSpec, deps: GraphRuntimeDeps): LangGraphThreadGraph {
  const channels = Object.fromEntries(
    graphStateKeys(spec).map((key) => [
      key,
      // A reducer lets parallel branches write the same key without InvalidUpdateError.
      Annotation<unknown>({ reducer: (_previous: unknown, next: unknown) => next, default: () => undefined }),
    ]),
  );
  const builder = new StateGraph(Annotation.Root(channels)) as unknown as LooseBuilder;

  for (const node of spec.nodes) builder.addNode(node.id, nodeFn(node, deps));
  for (const edge of spec.edges) builder.addEdge(endpoint(edge.from), endpoint(edge.to));
  for (const node of spec.nodes) {
    if (node.type !== "branch") continue;
    const targets = [...new Set([...node.cases.map((c) => c.to), node.default])];
    builder.addConditionalEdges(
      node.id,
      (state) => node.cases.find((c) => evaluateCondition(c.when, state))?.to ?? node.default,
      Object.fromEntries(targets.map((target) => [target, endpoint(target)])),
    );
  }

  const compiled = builder.compile(deps.checkpointer ? { checkpointer: deps.checkpointer } : {});
  return new LangGraphThreadGraph(compiled as CompiledGraph);
}

function endpoint(id: string): string {
  if (id === GRAPH_START) return START;
  if (id === GRAPH_END) return END;
  return id;
}

function nodeFn(node: GraphNodeSpec, deps: GraphRuntimeDeps): NodeFn {
  switch (node.type) {
    case "transform":
      return async (state) => renderValue(node.set, state) as GraphState;
    case "branch":
      return async () => ({});
    case "tool":
      return async (state, config) => {
        const tool = deps.tool(node.tool);
        if (!tool) throw new Error(`Tool ${node.tool} is not connected.`);
        const result: unknown = await tool.invoke(renderValue(node.args ?? {}, state), config);
        return { [node.output]: toolOutput(result) };
      };
    case "llm":
      return async (state, config) => {
        const model = await deps.modelFor(node.model);
        const messages: BaseMessage[] = [];
        if (node.system) messages.push(new SystemMessage(renderText(node.system, state)));
        messages.push(new HumanMessage(renderText(node.prompt, state)));
        const reply = await model.invoke(messages, config);
        return { [node.output]: contentText(reply.content) };
      };
    case "agent":
      return async (state, config) => {
        const agent = await deps.agentFor(node.model, node.agentId);
        return { [node.output]: await agent.runAsNode(renderText(node.prompt, state), config) };
      };
    case "human":
      return async (state) => {
        const request: GraphHumanRequest = {
          type: "graph.human",
          nodeId: node.id,
          prompt: renderText(node.prompt, state),
        };
        return { [node.output]: interrupt(request) };
      };
  }
}

/** MCP tools answer with text (often JSON) or content blocks; keep structure when there is one. */
function toolOutput(result: unknown): unknown {
  const text = typeof result === "string" ? result : Array.isArray(result) ? contentText(result) : undefined;
  if (text === undefined) return result;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}
