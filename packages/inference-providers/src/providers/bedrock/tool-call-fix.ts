import type { BaseMessage } from "@langchain/core/messages";
import type { ChatModelStreamEvent } from "@langchain/core/language_models/event";

type EmptyInvalidToolCall = {
  type: "invalid_tool_call";
  name: string;
  args: "";
  id?: string;
  [key: string]: unknown;
};

function isEmptyInvalidToolCall(value: unknown): value is EmptyInvalidToolCall {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { type?: unknown }).type === "invalid_tool_call" &&
    typeof (value as { name?: unknown }).name === "string" &&
    (value as { args?: unknown }).args === ""
  );
}

function asToolCall(call: EmptyInvalidToolCall) {
  const { error: _error, ...rest } = call;
  return {
    ...rest,
    type: "tool_call" as const,
    args: {},
  };
}

/**
 * Bedrock emits no argument delta for a zero-argument tool. LangChain 1.2's
 * native event finalizer parses the start block's empty string as JSON and
 * marks the call invalid. Repair only that exact provider output.
 */
export function repairEmptyToolCallEvent(event: ChatModelStreamEvent): ChatModelStreamEvent {
  if (event.event !== "content-block-finish" || !isEmptyInvalidToolCall(event.content)) {
    return event;
  }
  return { ...event, content: asToolCall(event.content) };
}

/** Repair the same shape if it arrives through a non-streaming model path. */
export function repairEmptyToolCalls(message: BaseMessage): BaseMessage {
  const content = Array.isArray(message.content) ? message.content : undefined;
  const invalidToolCalls = (message as { invalid_tool_calls?: unknown }).invalid_tool_calls;
  const contentNeedsRepair = content?.some(isEmptyInvalidToolCall) ?? false;
  const fieldNeedsRepair =
    Array.isArray(invalidToolCalls) && invalidToolCalls.some(isEmptyInvalidToolCall);
  if (!contentNeedsRepair && !fieldNeedsRepair) return message;

  const clone = Object.assign(Object.create(Object.getPrototypeOf(message)) as BaseMessage, message);
  const repairedFromContent = contentNeedsRepair
    ? content!.filter(isEmptyInvalidToolCall).map(asToolCall)
    : [];
  const repairedFromField = fieldNeedsRepair
    ? invalidToolCalls.filter(isEmptyInvalidToolCall).map(asToolCall)
    : [];
  const existingToolCalls = (message as { tool_calls?: unknown }).tool_calls;
  const repairedCalls = [...repairedFromContent, ...repairedFromField];
  const mutableClone = clone as unknown as {
    content: unknown;
    tool_calls: unknown[];
    invalid_tool_calls: unknown[];
  };

  if (contentNeedsRepair) {
    mutableClone.content = content!.map((block) =>
      isEmptyInvalidToolCall(block) ? asToolCall(block) : block,
    );
  }
  mutableClone.tool_calls = [
    ...(Array.isArray(existingToolCalls) ? existingToolCalls : []),
    ...repairedCalls.filter(
      (call, index) =>
        repairedCalls.findIndex(
          (candidate) => candidate.id === call.id && candidate.name === call.name,
        ) === index,
    ),
  ];
  if (Array.isArray(invalidToolCalls)) {
    mutableClone.invalid_tool_calls = invalidToolCalls.filter(
      (call) => !isEmptyInvalidToolCall(call),
    );
  }
  return clone;
}
