/** Records in graph state whether the orchestrator's last turn ended at the token limit with no visible text. */
import { AIMessage, type BaseMessage } from "@langchain/core/messages";
import { createMiddleware } from "langchain";
import { z } from "zod";
import { reachedOutputLimit } from "./output-truncation-middleware.js";

export const TRUNCATED_TURN_KEY = "truncated";

const stateSchema = z.object({
  [TRUNCATED_TURN_KEY]: z.boolean().optional(),
});

/**
 * Graph state, not a synthesized protocol frame: LangGraph's own `values`
 * snapshot replaces the whole state object on the client, so a flag that is
 * not part of the state is erased by the next snapshot. State also lands in
 * the checkpoint, so the notice survives a reload. Written on every model
 * call — `false` included — so a later normal turn clears it.
 */
export function truncatedTurnMiddleware() {
  return createMiddleware({
    name: "truncatedTurn",
    stateSchema,
    afterModel: (state) => ({
      [TRUNCATED_TURN_KEY]: isTruncatedTurn(state.messages.at(-1)),
    }),
  });
}

export function isTruncatedTurn(message: BaseMessage | undefined): boolean {
  if (!message || !AIMessage.isInstance(message)) return false;
  // A length-limited tool call still routes to the tool; only a turn with no
  // visible reply and nothing to execute leaves the user with a blank turn.
  if (message.tool_calls?.length) return false;
  return reachedOutputLimit(message) && !hasVisibleText(message);
}

function hasVisibleText(message: AIMessage): boolean {
  if (typeof message.content === "string") return message.content.trim().length > 0;
  return message.content.some(
    (block) =>
      typeof block === "object" &&
      block !== null &&
      block.type === "text" &&
      typeof block.text === "string" &&
      block.text.trim().length > 0,
  );
}
