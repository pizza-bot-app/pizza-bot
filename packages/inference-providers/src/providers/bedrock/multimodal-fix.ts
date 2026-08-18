import {
  ToolMessage,
  type BaseMessage,
} from "@langchain/core/messages";

type DeepAgentsBinaryBlock = Record<string, unknown> & {
  type: "image" | "file";
  mimeType: string;
  data: string;
};

function isDeepAgentsBinaryBlock(block: unknown): block is DeepAgentsBinaryBlock {
  return (
    typeof block === "object" &&
    block !== null &&
    ((block as { type?: unknown }).type === "image" ||
      (block as { type?: unknown }).type === "file") &&
    typeof (block as { mimeType?: unknown }).mimeType === "string" &&
    typeof (block as { data?: unknown }).data === "string" &&
    !("source_type" in block)
  );
}

function normalizeBlock(block: unknown): unknown {
  if (!isDeepAgentsBinaryBlock(block)) return block;
  const { mimeType, ...rest } = block;
  return {
    ...rest,
    source_type: "base64",
    mime_type: mimeType,
  };
}

/**
 * DeepAgents read_file emits v1 multimodal blocks that @langchain/aws otherwise
 * serializes as JSON. Normalize provider input without changing checkpoint state.
 */
export function normalizeMultimodalToolResultsForBedrock(
  messages: BaseMessage[],
): BaseMessage[] {
  let rewritten: BaseMessage[] | undefined;
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index]!;
    if (!ToolMessage.isInstance(message) || !Array.isArray(message.content)) {
      continue;
    }

    const content = message.content.map(normalizeBlock);
    if (content.every((block, blockIndex) => block === message.content[blockIndex])) {
      continue;
    }

    rewritten ??= [...messages];
    const clone = Object.assign(
      Object.create(Object.getPrototypeOf(message)) as ToolMessage,
      message,
    );
    clone.content = content as ToolMessage["content"];
    rewritten[index] = clone;
  }
  return rewritten ?? messages;
}
