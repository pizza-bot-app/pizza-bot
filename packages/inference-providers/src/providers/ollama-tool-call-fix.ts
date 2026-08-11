import {
  AIMessage,
  AIMessageChunk,
  ToolMessage,
  type BaseMessage,
} from "@langchain/core/messages";
import type { ChatModelStreamEvent } from "@langchain/core/language_models/event";
import { randomUUID } from "node:crypto";

export type ToolArgNames = ReadonlyMap<string, readonly string[]>;

function coerceArgsObject(
  args: Record<string, unknown>,
  canonicalNames: readonly string[] = [],
): Record<string, unknown> {
  let mutated = false;
  const next: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args)) {
    const canonicalKey = canonicalArgName(key, canonicalNames);
    const nextKey =
      canonicalKey !== undefined && !(canonicalKey in args)
        ? canonicalKey
        : key;
    if (nextKey !== key) mutated = true;
    if (typeof value === "string") {
      const parsed = tryParseJson(value);
      if (parsed !== undefined && (Array.isArray(parsed) || isPlainObject(parsed))) {
        next[nextKey] = parsed;
        mutated = true;
        continue;
      }
    }
    next[nextKey] = value;
  }
  return mutated ? next : args;
}

function canonicalArgName(
  generatedName: string,
  canonicalNames: readonly string[],
): string | undefined {
  if (canonicalNames.includes(generatedName)) return undefined;
  const normalized = normalizeArgName(generatedName);
  const matches = canonicalNames.filter(
    (candidate) => normalizeArgName(candidate) === normalized,
  );
  return matches.length === 1 ? matches[0] : undefined;
}

function normalizeArgName(name: string): string {
  return name.replace(/[^a-z0-9]/gi, "").toLowerCase();
}

function tryParseJson(value: string): unknown {
  const trimmed = value.trim();
  if (trimmed === "" || (trimmed[0] !== "{" && trimmed[0] !== "[")) return undefined;
  try {
    return JSON.parse(trimmed);
  } catch {
    return undefined;
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Extract each bound tool's declared top-level JSON-schema property names. */
export function buildToolArgNames(tools: unknown): ToolArgNames {
  const names = new Map<string, readonly string[]>();
  if (!Array.isArray(tools)) return names;
  for (const tool of tools) {
    if (!isPlainObject(tool)) continue;
    const fn = isPlainObject(tool.function) ? tool.function : tool;
    const name = fn.name;
    const parameters = fn.parameters;
    if (
      typeof name !== "string" ||
      !isPlainObject(parameters) ||
      !isPlainObject(parameters.properties)
    ) continue;
    names.set(name, Object.keys(parameters.properties));
  }
  return names;
}

/**
 * Adapt checkpointed v3 content blocks to ChatOllama's narrower replay format
 * without mutating graph state.
 *
 * ChatOllama only serializes `AIMessage.tool_calls` when assistant content is a
 * string. LangGraph v3 checkpoints the same turn as `tool_call` content blocks,
 * so passing it through unchanged silently drops the assistant tool-call turn
 * and leaves the following tool result orphaned.
 */
export function coerceOllamaMessageContent(messages: BaseMessage[]): BaseMessage[] {
  let rewritten: BaseMessage[] | undefined;
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index]!;
    if (
      AIMessage.isInstance(message) &&
      Array.isArray(message.content) &&
      (message.tool_calls?.length ?? 0) > 0
    ) {
      rewritten ??= [...messages];
      const clone = Object.assign(
        Object.create(Object.getPrototypeOf(message)) as AIMessage,
        message,
      );
      // Gemma 4 reasoning must not be replayed. Preserve only visible text;
      // `tool_calls` remains on the cloned message and is serialized by Ollama.
      clone.content = message.content
        .filter(
          (block): block is Extract<typeof block, { type: "text"; text: string }> =>
            block.type === "text" && typeof block.text === "string",
        )
        .map((block) => block.text)
        .join("");
      rewritten[index] = clone;
      continue;
    }
    if (!ToolMessage.isInstance(message) || !Array.isArray(message.content)) continue;
    rewritten ??= [...messages];
    const clone = Object.assign(
      Object.create(Object.getPrototypeOf(message)) as ToolMessage,
      message,
    );
    clone.content = stringifyToolContent(message.content);
    rewritten[index] = clone;
  }
  return rewritten ?? messages;
}

function stringifyToolContent(content: Array<Record<string, unknown>>): string {
  if (
    content.every(
      (block) => block.type === "text" && typeof block.text === "string",
    )
  ) {
    return content.map((block) => block.text as string).join("\n");
  }
  return JSON.stringify(content);
}

/**
 * Some Ollama models double-encode structured arguments or alter declared key
 * casing. Repair only structured strings and uniquely matched schema keys.
 */
export function coerceStringifiedToolArgs<T extends AIMessage | AIMessageChunk>(
  message: T,
  toolArgNames: ToolArgNames = new Map(),
): T {
  const toolCalls = message.tool_calls;
  if (toolCalls?.length) {
    message.tool_calls = toolCalls.map((call) => {
      if (!call.args || typeof call.args !== "object") return call;
      const coerced = coerceArgsObject(
        call.args as Record<string, unknown>,
        toolArgNames.get(call.name),
      );
      return coerced === call.args ? call : { ...call, args: coerced };
    });
  }

  if (message instanceof AIMessageChunk && message.tool_call_chunks?.length) {
    message.tool_call_chunks = message.tool_call_chunks.map((chunk) => {
      if (typeof chunk.args !== "string" || chunk.args === "") return chunk;
      const parsed = tryParseJson(chunk.args);
      if (!isPlainObject(parsed)) return chunk;
      const coerced = coerceArgsObject(
        parsed,
        chunk.name ? toolArgNames.get(chunk.name) : undefined,
      );
      if (coerced === parsed) return chunk;
      return { ...chunk, args: JSON.stringify(coerced) };
    });
  }

  return message;
}

/**
 * `streamEvents(v3)` drives the model through `_streamChatModelEvents`, which
 * never touches the message-level coercion above — the tool args arrive as
 * `ChatModelStreamEvent`s. `content-block-finish` carries the finalized parsed
 * `tool_call` that folds into `message.tool_calls`; the running
 * `content-block-delta` snapshots carry the raw JSON string. Coerce both so the
 * repair holds on the path production actually uses.
 */
export function coerceStringifiedToolArgsEvent(
  event: ChatModelStreamEvent,
  toolArgNames: ToolArgNames = new Map(),
): ChatModelStreamEvent {
  if (event.event === "content-block-finish" && event.content.type === "tool_call") {
    const args = event.content.args;
    if (isPlainObject(args)) {
      const coerced = coerceArgsObject(
        args,
        typeof event.content.name === "string"
          ? toolArgNames.get(event.content.name)
          : undefined,
      );
      if (coerced !== args) return { ...event, content: { ...event.content, args: coerced } };
    }
    return event;
  }

  if (event.event === "content-block-delta" && event.delta.type === "block-delta") {
    const fields = event.delta.fields;
    if (fields.type === "tool_call_chunk" && typeof fields.args === "string" && fields.args !== "") {
      const parsed = tryParseJson(fields.args);
      if (!isPlainObject(parsed)) return event;
      const coerced = coerceArgsObject(
        parsed,
        typeof fields.name === "string"
          ? toolArgNames.get(fields.name)
          : undefined,
      );
      if (coerced === parsed) return event;
      return {
        ...event,
        delta: { ...event.delta, fields: { ...fields, args: JSON.stringify(coerced) } },
      };
    }
  }

  return event;
}

/**
 * Ollama's v3 stream adapter omits tool-call IDs. Assign one per content block
 * so the resulting ToolMessage retains its required tool_call_id after
 * checkpoint serialization.
 */
export function ensureToolCallId(
  event: ChatModelStreamEvent,
  idsByBlock: Map<number, string>,
  createId: () => string = randomUUID,
): ChatModelStreamEvent {
  if (event.event === "content-block-start" && event.content.type === "tool_call_chunk") {
    const id = toolCallId(event.index, event.content.id, idsByBlock, createId);
    return event.content.id === id
      ? event
      : { ...event, content: { ...event.content, id } };
  }

  if (
    event.event === "content-block-delta" &&
    event.delta.type === "block-delta" &&
    event.delta.fields.type === "tool_call_chunk"
  ) {
    const existing = event.delta.fields.id;
    const id = toolCallId(event.index, existing, idsByBlock, createId);
    return existing === id
      ? event
      : {
          ...event,
          delta: { ...event.delta, fields: { ...event.delta.fields, id } },
        };
  }

  if (event.event === "content-block-finish" && event.content.type === "tool_call") {
    const id = toolCallId(event.index, event.content.id, idsByBlock, createId);
    return event.content.id === id
      ? event
      : { ...event, content: { ...event.content, id } };
  }

  return event;
}

function toolCallId(
  blockIndex: number,
  candidate: unknown,
  idsByBlock: Map<number, string>,
  createId: () => string,
): string {
  if (typeof candidate === "string" && candidate !== "") {
    idsByBlock.set(blockIndex, candidate);
    return candidate;
  }
  const existing = idsByBlock.get(blockIndex);
  if (existing) return existing;
  const created = createId();
  idsByBlock.set(blockIndex, created);
  return created;
}
