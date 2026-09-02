/** Drives the real graph to pin what a skill worker receives on dispatch. */
import { describe, expect, it } from "vitest";
import { AIMessage, type BaseMessage } from "@langchain/core/messages";
import { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { MemorySaver } from "@langchain/langgraph";
import type { SkillCatalog } from "@pizza-bot/core";
import { createPizzaBotAgent } from "./index.js";
import { TASK_USAGE_NOTES } from "./task-dispatch-middleware.js";

const skills: SkillCatalog = new Map([[
  "worker",
  {
    id: "worker",
    name: "Worker",
    description: "Handles delegated work.",
    source: "user",
    declaredTools: [],
    interruptOn: {},
    files: [{
      path: "/skills/worker/SKILL.md",
      content: "---\nname: worker\ndescription: Handles delegated work.\n---\n\nComplete the task.",
    }],
  },
]]);

/** Dispatches once, then records the human turns every later model call sees. */
class DispatchingModel extends BaseChatModel<Record<string, never>> {
  readonly humanTurns: string[][] = [];
  readonly boundTools: Array<{ name?: unknown; description?: unknown }> = [];
  private readonly dispatch: string;
  private call = 0;

  constructor(dispatch: string) {
    super({});
    this.dispatch = dispatch;
  }

  _llmType(): string {
    return "dispatching";
  }

  override bindTools(tools: Array<{ name?: unknown; description?: unknown }>): this {
    this.boundTools.push(...tools);
    return this;
  }

  async _generate(
    messages: BaseMessage[],
  ): Promise<{ generations: Array<{ message: AIMessage; text: string }> }> {
    this.humanTurns.push(
      messages.filter((message) => message.getType() === "human").map((message) => message.text),
    );
    const message = this.call++ === 0
      ? new AIMessage({
          content: "",
          tool_calls: [{
            id: "task-1",
            name: "task",
            args: { description: this.dispatch, subagent_type: "worker" },
            type: "tool_call",
          }],
        })
      : new AIMessage({ content: "done" });
    return { generations: [{ message, text: message.text }] };
  }
}

async function dispatch(
  userRequest: string,
  description: string,
): Promise<{ workerTurn: string; frames: string; taskDescription: string }> {
  const model = new DispatchingModel(description);
  const agent = await createPizzaBotAgent("Help the user.", {
    model,
    skills,
    checkpointer: new MemorySaver(),
  });
  const frames: unknown[] = [];
  for await (const frame of agent.streamProtocol(
    { messages: [{ id: "u1", role: "user", parts: [{ type: "text", text: userRequest }] }] },
    { threadId: `dispatch_${Math.random().toString(36).slice(2)}` },
  )) {
    frames.push(frame);
  }
  const task = model.boundTools.find((tool) => tool.name === "task");
  return {
    // The orchestrator opens and closes the run; the worker is the call between.
    workerTurn: model.humanTurns[1]?.join("\n\n") ?? "",
    frames: JSON.stringify(frames),
    taskDescription: typeof task?.description === "string" ? task.description : "",
  };
}

describe("skill worker dispatch", () => {
  it("reaches the worker as the orchestrator wrote it", async () => {
    const { workerTurn } = await dispatch(
      "Book the cheapest flight to Tokyo.",
      "Research Tokyo flight prices and return a markdown table sorted by price.",
    );
    expect(workerTurn).toBe(
      "Research Tokyo flight prices and return a markdown table sorted by price.",
    );
  });

  it("streams the same text the worker saw, so the UI shows no machinery", async () => {
    const { workerTurn, frames } = await dispatch(
      "Book the cheapest flight to Tokyo.",
      "Research Tokyo flight prices and return a markdown table sorted by price.",
    );
    expect(frames).toContain(workerTurn);
    // Prompt scaffolding belongs to the model call, never to a transcript.
    expect(frames).not.toContain("user_request");
    expect(frames).not.toContain("relay instruction");
  });

  // Our middleware replaces DeepAgents' by name, so a renamed upstream entry would
  // leave theirs in place and quietly reinstate "put full detail in the prompt".
  it("offers the task tool with routing notes instead of upstream's briefing notes", async () => {
    const { taskDescription } = await dispatch("Find flights.", "Find flights.");
    expect(taskDescription).toContain("- worker: Handles delegated work.");
    expect(taskDescription).toContain(TASK_USAGE_NOTES);
    expect(taskDescription).not.toContain("Put full detail in the prompt");
    expect(taskDescription).not.toContain("relay a summary yourself");
  });
});
