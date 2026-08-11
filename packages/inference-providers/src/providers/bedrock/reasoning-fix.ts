/** Repairs Bedrock replay messages whose reasoning signatures cannot be preserved. */
import type { BaseMessage } from "@langchain/core/messages";

function isReasoningBlock(block: unknown): boolean {
  if (typeof block !== "object" || block === null) return false;
  const t = (block as { type?: unknown }).type;
  return t === "reasoning_content" || t === "reasoning";
}

function withContent(msg: BaseMessage, content: unknown): BaseMessage {
  const clone = Object.assign(Object.create(Object.getPrototypeOf(msg)) as BaseMessage, msg);
  (clone as { content: unknown }).content = content;
  return clone;
}

function toolCallsOf(msg: BaseMessage): Array<{
  id?: string;
  name: string;
  args: Record<string, unknown>;
}> {
  const toolCalls = (msg as { tool_calls?: unknown }).tool_calls;
  return Array.isArray(toolCalls)
    ? toolCalls.filter(
        (call): call is { id?: string; name: string; args: Record<string, unknown> } =>
          typeof call === "object" &&
          call !== null &&
          "name" in call &&
          typeof call.name === "string" &&
          "args" in call &&
          typeof call.args === "object" &&
          call.args !== null &&
          !Array.isArray(call.args),
      )
    : [];
}

/**
 * @langchain/aws@1.4.2 drops reasoning signatures while converting native v3
 * streams to v1 history, so Bedrock rejects replayed `reasoning` and
 * `reasoning_content` blocks. Strip them only from provider input, preserving
 * checkpoint display and tool calls. Remove when native-v3 conversion and replay
 * preserve signatures (langchainjs#11164 and #11246).
 */
export function stripReasoningForBedrock(messages: BaseMessage[]): BaseMessage[] {
  let rewritten: BaseMessage[] | undefined;
  for (let index = 0; index < messages.length; index += 1) {
    const msg = messages[index]!;
    if (!Array.isArray(msg.content) || !msg.content.some(isReasoningBlock)) {
      rewritten?.push(msg);
      continue;
    }

    rewritten ??= messages.slice(0, index);
    let content = msg.content.filter((block) => !isReasoningBlock(block));
    const type = typeof msg.getType === "function" ? msg.getType() : "";
    const toolCalls = type === "ai" ? toolCallsOf(msg) : [];
    if (
      content.length === 0 &&
      toolCalls.length > 0 &&
      msg.response_metadata?.output_version === "v1"
    ) {
      // V1 replay reads tool calls from content blocks, not `AIMessage.tool_calls`.
      content = toolCalls.map((call) => ({
        type: "tool_call" as const,
        ...(call.id ? { id: call.id } : {}),
        name: call.name,
        args: call.args,
      }));
    }
    if (type !== "ai" || content.length > 0 || toolCalls.length > 0) {
      rewritten.push(withContent(msg, content));
    }
  }
  return rewritten ?? messages;
}
