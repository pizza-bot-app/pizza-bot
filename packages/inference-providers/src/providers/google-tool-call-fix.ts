import type { ChatModelStreamEvent } from "@langchain/core/language_models/event";
import {
  AIMessage,
  AIMessageChunk,
  type BaseMessage,
  type UsageMetadata,
} from "@langchain/core/messages";
import type { ChatGenerationChunk } from "@langchain/core/outputs";
import { randomUUID } from "node:crypto";

interface GoogleToolCall {
  id?: string;
  name: string;
  args: Record<string, unknown>;
  thoughtSignature?: string;
}

interface GoogleFunctionCallBlock {
  type: "functionCall";
  functionCall: {
    id?: string;
    name: string;
    args: Record<string, unknown>;
  };
  thoughtSignature?: string;
}

interface AccumulatedBlock {
  index: number;
  content: Record<string, unknown> & { type: string };
}

/**
 * Google requires thought signatures to be replayed unchanged with function
 * calls. LangChain's v1 message converter currently omits that provider field.
 */
export function prepareGoogleMessages(messages: BaseMessage[]): BaseMessage[] {
  return messages.map((message) => {
    if (!AIMessage.isInstance(message) || !message.tool_calls?.length) {
      return message;
    }

    const toolCalls = message.tool_calls.map((toolCall, index) => {
      const contentCall = findContentToolCall(message.content, toolCall.id, index);
      const thoughtSignature =
        googleString(toolCall, "thoughtSignature") ??
        googleString(contentCall, "thoughtSignature");
      return {
        ...toolCall,
        ...(thoughtSignature ? { thoughtSignature } : {}),
      } satisfies GoogleToolCall;
    });
    if (!toolCalls.some((toolCall) => toolCall.thoughtSignature)) return message;

    const content = visibleGoogleContent(message.content);
    for (const toolCall of toolCalls) {
      content.push({
        type: "functionCall",
        functionCall: {
          ...googleProviderToolCallId(toolCall.id),
          name: toolCall.name,
          args: toolCall.args,
        },
        ...(toolCall.thoughtSignature
          ? { thoughtSignature: toolCall.thoughtSignature }
          : {}),
      } satisfies GoogleFunctionCallBlock);
    }

    const responseMetadata = { ...message.response_metadata };
    delete responseMetadata.output_version;
    return new AIMessage({
      ...(message.id ? { id: message.id } : {}),
      ...(message.name ? { name: message.name } : {}),
      content,
      tool_calls: toolCalls,
      additional_kwargs: { ...message.additional_kwargs },
      response_metadata: responseMetadata,
      ...(message.usage_metadata
        ? { usage_metadata: message.usage_metadata }
        : {}),
    });
  });
}

/**
 * LangChain's native Google v3 adapter drops function-call IDs and thought
 * signatures. Build equivalent events from its legacy chunks, which retain
 * both fields.
 */
export async function* convertGoogleChunksToEvents(
  chunks: AsyncIterable<ChatGenerationChunk>,
  createId: () => string = () =>
    `lc-tool-call-${randomUUID().replaceAll("-", "")}`,
): AsyncGenerator<ChatModelStreamEvent> {
  const blocks = new Map<string, AccumulatedBlock>();
  let nextBlockIndex = 0;
  let messageStarted = false;
  let usage: { input_tokens: number; output_tokens: number; total_tokens: number } | undefined;
  let finishReason: unknown;
  let hasToolCalls = false;

  const getBlock = (
    key: string,
    initial: Record<string, unknown> & { type: string },
  ): { block: AccumulatedBlock; isNew: boolean } => {
    const existing = blocks.get(key);
    if (existing) return { block: existing, isNew: false };
    const block = { index: nextBlockIndex++, content: initial };
    blocks.set(key, block);
    return { block, isNew: true };
  };

  for await (const chunk of chunks) {
    const message = chunk.message;
    if (!messageStarted) {
      messageStarted = true;
      yield {
        event: "message-start",
        ...(message.id ? { id: message.id } : {}),
      };
    }

    const aiMessage = AIMessageChunk.isInstance(message)
      ? message as unknown as {
          usage_metadata?: UsageMetadata;
          tool_calls?: GoogleToolCall[];
        }
      : undefined;
    const chunkUsage = aiMessage?.usage_metadata;
    if (chunkUsage) {
      usage = {
        input_tokens: (usage?.input_tokens ?? 0) + chunkUsage.input_tokens,
        output_tokens: (usage?.output_tokens ?? 0) + chunkUsage.output_tokens,
        total_tokens: (usage?.total_tokens ?? 0) + chunkUsage.total_tokens,
      };
      yield { event: "usage", usage };
    }
    finishReason = chunk.generationInfo?.finishReason ?? finishReason;

    for (const part of googleTextParts(message.content)) {
      const key = part.reasoning ? "reasoning" : "text";
      const initial = part.reasoning
        ? { type: "reasoning", reasoning: "" }
        : { type: "text", text: "" };
      const { block, isNew } = getBlock(key, initial);
      if (isNew) {
        yield {
          event: "content-block-start",
          index: block.index,
          content: block.content,
        };
      }
      if (part.reasoning) {
        block.content.reasoning = `${block.content.reasoning ?? ""}${part.text}`;
        yield {
          event: "content-block-delta",
          index: block.index,
          delta: { type: "reasoning-delta", reasoning: part.text },
        };
      } else {
        block.content.text = `${block.content.text ?? ""}${part.text}`;
        yield {
          event: "content-block-delta",
          index: block.index,
          delta: { type: "text-delta", text: part.text },
        };
      }
    }

    for (const [toolIndex, rawToolCall] of (aiMessage?.tool_calls ?? []).entries()) {
      const toolCall = rawToolCall as GoogleToolCall;
      const key = `tool:${toolIndex}`;
      const args = JSON.stringify(toolCall.args ?? {});
      const existingId = blocks.get(key)?.content.id;
      const id =
        (typeof existingId === "string" && existingId) ||
        toolCall.id ||
        createId();
      const initial = {
        type: "tool_call_chunk",
        id,
        name: toolCall.name,
        args: "",
        index: toolIndex,
        ...(toolCall.thoughtSignature
          ? { thoughtSignature: toolCall.thoughtSignature }
          : {}),
      };
      const { block, isNew } = getBlock(key, initial);
      hasToolCalls = true;
      if (isNew) {
        yield {
          event: "content-block-start",
          index: block.index,
          content: block.content,
        };
      }
      Object.assign(block.content, {
        id: block.content.id ?? id,
        name: toolCall.name,
        args,
        ...(toolCall.thoughtSignature
          ? { thoughtSignature: toolCall.thoughtSignature }
          : {}),
      });
      yield {
        event: "content-block-delta",
        index: block.index,
        delta: {
          type: "block-delta",
          fields: { ...block.content },
        },
      };
    }
  }

  if (!messageStarted) yield { event: "message-start" };
  for (const block of blocks.values()) {
    const content = block.content.type === "tool_call_chunk"
      ? {
          ...block.content,
          type: "tool_call",
          args: parseToolArgs(block.content.args),
        }
      : block.content;
    yield {
      event: "content-block-finish",
      index: block.index,
      content,
    };
  }
  yield {
    event: "message-finish",
    reason: googleFinishReason(finishReason, hasToolCalls),
    ...(usage ? { usage } : {}),
    responseMetadata: { model_provider: "google" },
  };
}

function visibleGoogleContent(
  content: BaseMessage["content"],
): Array<Record<string, unknown> & { type: string }> {
  if (typeof content === "string") {
    return content ? [{ type: "text", text: content }] : [];
  }
  return content.filter((part) => {
    return ![
      "functionCall",
      "tool_call",
      "tool_call_chunk",
      "reasoning",
    ].includes(part.type);
  }) as Array<Record<string, unknown> & { type: string }>;
}

function findContentToolCall(
  content: BaseMessage["content"],
  id: string | undefined,
  index: number,
): Record<string, unknown> | undefined {
  if (!Array.isArray(content)) return undefined;
  const calls = content.filter((part) =>
    ["functionCall", "tool_call", "tool_call_chunk"].includes(part.type)
  ) as Array<Record<string, unknown>>;
  return calls.find((part) => id !== undefined && part.id === id) ?? calls[index];
}

function googleTextParts(
  content: BaseMessage["content"],
): Array<{ text: string; reasoning: boolean }> {
  if (typeof content === "string") {
    return content ? [{ text: content, reasoning: false }] : [];
  }
  return content.flatMap((part) => {
    if (part.type !== "text" || typeof part.text !== "string" || !part.text) {
      return [];
    }
    return [{ text: part.text, reasoning: part.thought === true }];
  });
}

function googleProviderToolCallId(id: string | undefined): { id?: string } {
  return id && !id.startsWith("lc-tool-call-") ? { id } : {};
}

function googleString(value: unknown, key: string): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  const field = (value as Record<string, unknown>)[key];
  return typeof field === "string" && field ? field : undefined;
}

function parseToolArgs(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  if (typeof value !== "string") return {};
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function googleFinishReason(
  reason: unknown,
  hasToolCalls: boolean,
): "stop" | "length" | "tool_use" | "content_filter" {
  if (hasToolCalls) return "tool_use";
  const normalized = typeof reason === "string"
    ? reason.toLowerCase().replaceAll("-", "_")
    : "";
  if (["max_tokens", "max_token"].includes(normalized)) return "length";
  if ([
    "safety",
    "recitation",
    "language",
    "blocklist",
    "prohibited_content",
    "spii",
    "image_safety",
    "image_prohibited_content",
    "image_recitation",
  ].includes(normalized)) {
    return "content_filter";
  }
  return "stop";
}
