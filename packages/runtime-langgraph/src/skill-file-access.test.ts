import { describe, expect, it } from "vitest";
import {
  AIMessage,
  BaseMessage,
  SystemMessage,
  ToolMessage,
} from "@langchain/core/messages";
import { BaseChatModel } from "@langchain/core/language_models/chat_models";
import type { SkillCatalog } from "@pizza-bot/core";
import { createPizzaBotAgent } from "./index.js";

const REFERENCE_CONTENT = "The reference oven temperature is 500 F.";
const HIDDEN_MARKER = "hidden-skill-only-marker";

class SkillFileReadingModel extends BaseChatModel<Record<string, never>> {
  private call = 0;
  delegationResult = "";
  readResult = "";
  workerSystemPrompt = "";

  _llmType(): string {
    return "skill-file-reading";
  }

  override bindTools(): this {
    return this;
  }

  async _generate(
    messages: BaseMessage[],
  ): Promise<{ generations: Array<{ message: AIMessage; text: string }> }> {
    const call = this.call++;
    let message: AIMessage;

    if (call === 0) {
      message = new AIMessage({
        content: "",
        tool_calls: [{
          id: "delegate-reader",
          name: "task",
          args: {
            description: "Read the bundled oven reference and return its contents.",
            subagent_type: "reader",
          },
          type: "tool_call",
        }],
      });
    } else if (call === 1) {
      this.workerSystemPrompt = messages
        .filter(SystemMessage.isInstance)
        .map((item) => typeof item.content === "string"
          ? item.content
          : JSON.stringify(item.content))
        .join("\n");
      message = new AIMessage({
        content: "",
        tool_calls: [{
          id: "read-reference",
          name: "read_file",
          args: { path: "/skills/reader/references/oven.txt" },
          type: "tool_call",
        }],
      });
    } else {
      const toolMessage = [...messages].reverse().find(ToolMessage.isInstance);
      const toolContent = toolMessage?.content ?? "";
      const content = typeof toolContent === "string"
        ? toolContent
        : JSON.stringify(toolContent);
      if (call === 2) this.readResult = content;
      if (call === 3) this.delegationResult = content;
      message = new AIMessage({ content });
    }

    return { generations: [{ message, text: String(message.content) }] };
  }
}

const skills: SkillCatalog = new Map([
  [
    "reader",
    {
      id: "reader",
      name: "Reader",
      description: "Reads its bundled oven reference.",
      source: "user",
      declaredTools: [],
      interruptOn: {},
      files: [
        {
          path: "/skills/reader/SKILL.md",
          content: [
            "---",
            "name: reader",
            "description: Reads its bundled oven reference.",
            "---",
            "",
            "Read /skills/reader/references/oven.txt before answering.",
          ].join("\n"),
        },
        {
          path: "/skills/reader/references/oven.txt",
          content: REFERENCE_CONTENT,
        },
      ],
    },
  ],
  [
    "hidden",
    {
      id: "hidden",
      name: "Hidden",
      description: HIDDEN_MARKER,
      source: "user",
      declaredTools: [],
      interruptOn: {},
      files: [{
        path: "/skills/hidden/SKILL.md",
        content: [
          "---",
          "name: hidden",
          `description: ${HIDDEN_MARKER}`,
          "---",
          "",
          HIDDEN_MARKER,
        ].join("\n"),
      }],
    },
  ],
]);

describe("skill worker files", () => {
  it("reads its sibling reference without exposing another skill", async () => {
    const model = new SkillFileReadingModel({});
    const agent = await createPizzaBotAgent("Delegate this request.", { model, skills });

    for await (const _ of agent.streamProtocol(
      {
        messages: [{
          id: "u1",
          role: "user",
          parts: [{ type: "text", text: "What oven temperature should I use?" }],
        }],
      },
      { threadId: `skill_file_${Math.random().toString(36).slice(2)}` },
    )) {
      // Drain the stream so delegated work completes.
    }

    expect(model.readResult).toContain(REFERENCE_CONTENT);
    expect(model.delegationResult).toContain(REFERENCE_CONTENT);
    expect(model.workerSystemPrompt).toContain("/skills/reader/references/oven.txt");
    expect(model.workerSystemPrompt).toContain("Reads its bundled oven reference.");
    expect(model.workerSystemPrompt).not.toContain(HIDDEN_MARKER);
  });
});
