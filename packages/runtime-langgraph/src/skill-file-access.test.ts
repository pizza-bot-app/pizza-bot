import { describe, expect, it } from "vitest";
import {
  AIMessage,
  BaseMessage,
  SystemMessage,
  ToolMessage,
} from "@langchain/core/messages";
import { BaseChatModel } from "@langchain/core/language_models/chat_models";
import type { AgentCatalog, SkillCatalog } from "@pizza-bot/core";
import { createPizzaBotAgent } from "./index.js";

const REFERENCE_CONTENT = "The reference oven temperature is 500 F.";
const HIDDEN_MARKER = "hidden-skill-only-marker";

class SkillFileReadingModel extends BaseChatModel<Record<string, never>> {
  private call = 0;
  delegationResult = "";
  skillReadResult = "";
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
            subagent_type: "cook",
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
      message = readFile("read-skill", "/skills/reader/SKILL.md");
    } else if (call === 2) {
      this.skillReadResult = lastToolContent(messages);
      message = readFile("read-reference", "/skills/reader/references/oven.txt");
    } else {
      const content = lastToolContent(messages);
      if (call === 3) this.readResult = content;
      if (call === 4) this.delegationResult = content;
      message = new AIMessage({ content });
    }

    return { generations: [{ message, text: String(message.content) }] };
  }
}

function readFile(id: string, path: string): AIMessage {
  return new AIMessage({
    content: "",
    tool_calls: [{ id, name: "read_file", args: { file_path: path }, type: "tool_call" }],
  });
}

function lastToolContent(messages: BaseMessage[]): string {
  const toolContent = [...messages].reverse().find(ToolMessage.isInstance)?.content ?? "";
  return typeof toolContent === "string" ? toolContent : JSON.stringify(toolContent);
}

const agents: AgentCatalog = new Map([[
  "cook",
  {
    id: "cook",
    name: "Cook",
    description: "Answers oven questions.",
    systemPrompt: "Answer oven questions using your skills.",
    source: "user",
    declaredTools: [],
    skills: ["reader"],
    interruptOn: {},
  },
]]);

const skills: SkillCatalog = new Map([
  [
    "reader",
    {
      id: "reader",
      name: "Reader",
      description: "Reads its bundled oven reference.",
      source: "user",
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

describe("subagent files", () => {
  it("discloses only its mounted skills and reads their files through the backend", async () => {
    const model = new SkillFileReadingModel({});
    const agent = await createPizzaBotAgent("Delegate this request.", { model, agents, skills });

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

    expect(model.workerSystemPrompt).toContain("Answer oven questions using your skills.");
    expect(model.workerSystemPrompt).toContain("/skills/reader/SKILL.md");
    expect(model.workerSystemPrompt).toContain("Reads its bundled oven reference.");
    expect(model.workerSystemPrompt).not.toContain(HIDDEN_MARKER);
    expect(model.skillReadResult).toContain("Read /skills/reader/references/oven.txt before answering.");
    expect(model.readResult).toContain(REFERENCE_CONTENT);
    expect(model.delegationResult).toContain(REFERENCE_CONTENT);
  });
});
