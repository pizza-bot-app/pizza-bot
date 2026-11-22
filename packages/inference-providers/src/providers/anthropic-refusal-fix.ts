/**
 * Restores the `refusal` block `@langchain/anthropic`'s v1 stream converter drops
 * (it keeps only a `content_filter` finish reason), which the refusal middleware needs.
 * TODO: remove once https://github.com/langchain-ai/langchainjs/issues/12268 ships.
 */
import type { ChatModelStreamEvent } from "@langchain/core/language_models/event";

/** An event type Anthropic never sends, so the converter passes it through as a `provider` event. */
export const REFUSAL_MARKER = "pizza_bot_refusal_stop";

interface RawStreamEvent {
  type: string;
  delta?: { stop_reason?: unknown; stop_details?: unknown };
}

/** Follows a refusal `message_delta` with an in-stream marker, so concurrent calls cannot share it. */
export function markRefusalStops<S extends AsyncIterable<unknown>>(stream: S): S {
  const source = stream as AsyncIterable<RawStreamEvent>;
  const marked = (async function* () {
    for await (const event of source) {
      yield event;
      if (event.type === "message_delta" && event.delta?.stop_reason === "refusal") {
        yield { type: REFUSAL_MARKER, stop_details: event.delta.stop_details ?? null };
      }
    }
  })();
  // The converter aborts a cancelled request through the SDK stream's `controller`.
  return Object.assign(marked, {
    controller: (stream as { controller?: unknown }).controller,
  }) as unknown as S;
}

function refusalBlock(stopDetails: unknown): { type: "refusal"; refusal: string; extras?: { category: string } } {
  const details = (stopDetails && typeof stopDetails === "object" ? stopDetails : {}) as {
    explanation?: unknown;
    category?: unknown;
  };
  return {
    type: "refusal",
    refusal: typeof details.explanation === "string" ? details.explanation : "",
    ...(typeof details.category === "string" && { extras: { category: details.category } }),
  };
}

/** Turns the marker into a `refusal` content block, placed after the message's other blocks. */
export async function* restoreRefusalBlocks(
  events: AsyncIterable<ChatModelStreamEvent>,
): AsyncGenerator<ChatModelStreamEvent> {
  let nextIndex = 0;
  let refusal: ReturnType<typeof refusalBlock> | undefined;
  for await (const event of events) {
    if (event.event === "provider" && event.name === REFUSAL_MARKER) {
      refusal = refusalBlock((event.payload as { stop_details?: unknown }).stop_details);
      continue;
    }
    if (event.event === "content-block-start" || event.event === "content-block-finish") {
      nextIndex = Math.max(nextIndex, event.index + 1);
    }
    if (event.event === "message-finish" && refusal) {
      const index = nextIndex++;
      yield { event: "content-block-start", index, content: refusal } as ChatModelStreamEvent;
      yield { event: "content-block-finish", index, content: refusal } as ChatModelStreamEvent;
      refusal = undefined;
    }
    yield event;
  }
}
