import {
  ToolMessage,
  type BaseMessage,
} from "@langchain/core/messages";

type InputContentBlock = Record<string, unknown> & {
  type: string;
};

function normalizeBlock(block: unknown): InputContentBlock | undefined {
  if (typeof block !== "object" || block === null || !("type" in block)) {
    return undefined;
  }
  const value = block as InputContentBlock;
  if (
    value.type === "input_text" ||
    value.type === "input_image" ||
    value.type === "input_file"
  ) {
    return value;
  }
  if (value.type === "text" && typeof value.text === "string") {
    return { type: "input_text", text: value.text };
  }
  if (
    value.type === "image" &&
    typeof value.mimeType === "string" &&
    typeof value.data === "string"
  ) {
    const detail = (value.metadata as { detail?: unknown } | undefined)?.detail;
    return {
      type: "input_image",
      detail:
        detail === "low" ||
        detail === "high"
          ? detail
          : "auto",
      image_url: `data:${value.mimeType};base64,${value.data}`,
    };
  }
  if (
    value.type === "file" &&
    typeof value.mimeType === "string" &&
    typeof value.data === "string"
  ) {
    const name = (value.metadata as { name?: unknown } | undefined)?.name;
    return {
      type: "input_file",
      file_data: `data:${value.mimeType};base64,${value.data}`,
      ...(typeof name === "string" && name ? { filename: name } : {}),
    };
  }
  return undefined;
}

/**
 * @langchain/openai stringifies standard multimodal ToolMessages for Responses.
 * Project them to native function output blocks without changing checkpoint state.
 */
export function normalizeMultimodalToolResultsForOpenAiResponses(
  messages: BaseMessage[],
): BaseMessage[] {
  let rewritten: BaseMessage[] | undefined;
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index]!;
    if (!ToolMessage.isInstance(message) || !Array.isArray(message.content)) {
      continue;
    }
    const content = message.content.map(normalizeBlock);
    if (content.some((block) => block === undefined)) continue;
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
