/** Owns the `task` tool: its roster is the skill workers and its notes route, not brief. */
import { createMiddleware } from "langchain";
import { createSubAgentMiddleware, type CompiledSubAgent, type SubAgent } from "deepagents";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";

/**
 * Replaces DeepAgents' default entry by name, so this text is the whole tool
 * description rather than an edit to theirs.
 */
const SUBAGENT_MIDDLEWARE_NAME = "subAgentMiddleware";

export const TASK_USAGE_NOTES = [
  "Specify subagent_type to select the agent. Usage notes:",
  "- Launch multiple agents concurrently when their tasks are independent, using a " +
    "single message with multiple tool calls.",
  "- `description` routes a request; it does not brief the worker. Carry the user's " +
    "own words — copy them verbatim when they stand on their own — and add only what " +
    "the worker cannot see for itself: relevant earlier turns, results you already " +
    "gathered, exact paths or identifiers.",
  "- Do not specify an output format, field list, length, tone, time range, or " +
    "acceptance criteria the user did not ask for. The worker's own instructions " +
    "govern what it returns and in how much detail.",
  "- Dispatch a worker once per request unless the request spans genuinely " +
    "independent items; then keep each item's original wording.",
  "- Each invocation is stateless: the worker sees only this description and returns " +
    "one final report.",
  "- The report is not shown to the user, so reproduce it in your reply with its " +
    "formatting intact rather than summarizing it.",
].join("\n");

type RosterEntry = { name: string; description: string };

export function taskToolDescription(subagents: readonly RosterEntry[]): string {
  return [
    "Launch an ephemeral subagent to handle a complex, multi-step task in an isolated " +
      "context window.",
    "",
    "Available agent types:",
    ...subagents.map((subagent) => `- ${subagent.name}: ${subagent.description}`),
    "",
    TASK_USAGE_NOTES,
  ].join("\n");
}

/**
 * Upstream's notes tell the model to put full detail in the dispatch, to state
 * exactly what to get back, and to relay a summary — advice for a generic
 * subagent that fights a skill-scoped worker, whose own instructions already
 * govern procedure and output. The system prompt loses this argument on
 * locality, since those notes sit in the schema the model is filling out.
 *
 * `generalPurposeAgent: false` because DeepAgents' auto-added one heads the
 * roster claiming "access to all tools as the main agent" while holding only the
 * filesystem — we pass no `tools` to `createDeepAgent`, so its `defaultTools` are
 * empty, and it gets no skill, no `eval`, and none of the per-worker guardrails.
 * The base agent already holds the same filesystem tools directly. With no
 * workers there is nothing to route to, so the tool itself goes away.
 */
export function taskDispatchMiddleware(options: {
  model?: BaseChatModel;
  subagents: readonly (SubAgent | CompiledSubAgent)[];
}): unknown {
  if (!options.model || options.subagents.length === 0) {
    return createMiddleware({ name: SUBAGENT_MIDDLEWARE_NAME });
  }
  return createSubAgentMiddleware({
    defaultModel: options.model,
    subagents: options.subagents as (SubAgent | CompiledSubAgent)[],
    generalPurposeAgent: false,
    taskDescription: taskToolDescription(options.subagents as readonly RosterEntry[]),
  });
}
