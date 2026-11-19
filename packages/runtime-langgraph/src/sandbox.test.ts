import { describe, expect, it } from "vitest";
import {
  AIMessage,
  BaseMessage,
  SystemMessage,
  ToolMessage,
} from "@langchain/core/messages";
import { BaseChatModel } from "@langchain/core/language_models/chat_models";
import type {
  ExecuteResponse,
  FileInfo,
  LsResult,
  ReadResult,
  SandboxBackendProtocolV2,
  WriteResult,
} from "deepagents";
import type { SkillCatalog } from "@pizza-bot/core";
import { createPizzaBotAgent } from "./index.js";

class FakeSandbox implements SandboxBackendProtocolV2 {
  readonly id = "fake-vm";
  readonly files = new Map<string, string>();
  readonly commands: string[] = [];

  async execute(command: string): Promise<ExecuteResponse> {
    this.commands.push(command);
    return { output: [...this.files.keys()].join("\n"), exitCode: 0, truncated: false };
  }

  async ls(dir: string): Promise<LsResult> {
    const prefix = dir.endsWith("/") ? dir : `${dir}/`;
    const files: FileInfo[] = [...this.files.keys()]
      .filter((file) => file.startsWith(prefix))
      .map((file) => ({ path: file, is_dir: false, size: 0 }));
    return { files };
  }

  async read(file: string): Promise<ReadResult> {
    const content = this.files.get(file);
    return content === undefined ? { error: `not found: ${file}` } : { content };
  }

  async readRaw(): Promise<never> {
    throw new Error("unused");
  }

  async grep(): Promise<never> {
    throw new Error("unused");
  }

  async glob(): Promise<never> {
    throw new Error("unused");
  }

  async write(file: string, content: string): Promise<WriteResult> {
    this.files.set(file, content);
    return { path: file };
  }

  async edit(): Promise<never> {
    throw new Error("unused");
  }

  async uploadFiles(): Promise<never> {
    throw new Error("unused");
  }

  async downloadFiles(): Promise<never> {
    throw new Error("unused");
  }
}

const toolCall = (id: string, name: string, args: Record<string, unknown>) =>
  new AIMessage({ content: "", tool_calls: [{ id, name, args, type: "tool_call" }] });

class SandboxScriptModel extends BaseChatModel<Record<string, never>> {
  private call = 0;
  private boundTools: string[] = [];
  readonly toolsByCall: string[][] = [];
  /** Keyed by the call that received the result. */
  readonly toolResults: Record<number, string> = {};
  systemPrompt = "";

  _llmType(): string {
    return "sandbox-script";
  }

  override bindTools(tools: Array<{ name?: string }>): this {
    this.boundTools = tools.map((tool) => tool.name ?? "");
    return this;
  }

  async _generate(
    messages: BaseMessage[],
  ): Promise<{ generations: Array<{ message: AIMessage; text: string }> }> {
    const call = this.call++;
    this.toolsByCall.push(this.boundTools);
    const last = messages.at(-1);
    if (last && ToolMessage.isInstance(last)) this.toolResults[call] = last.text;
    if (call === 0) {
      this.systemPrompt = messages
        .filter(SystemMessage.isInstance)
        .map((message) => message.text)
        .join("\n");
    }

    const message =
      call === 0
        ? toolCall("write", "write_file", {
            file_path: "/workspace/notes/plan.txt",
            content: "preheat",
          })
        : call === 1
          ? toolCall("run", "execute", { command: "ls -R" })
          : call === 2
            ? toolCall("list", "ls", { path: "/workspace/notes" })
            : call === 3
              ? toolCall("delegate", "task", {
                  description: "Read the plan.",
                  subagent_type: "reader",
                })
              : call === 4
                ? toolCall("worker-read", "read_file", {
                    file_path: "/workspace/notes/plan.txt",
                  })
                : new AIMessage({ content: "done" });
    return { generations: [{ message, text: String(message.content) }] };
  }
}

const skills: SkillCatalog = new Map([
  [
    "reader",
    {
      id: "reader",
      name: "Reader",
      description: "Reads workspace files.",
      source: "user",
      declaredTools: [],
      interruptOn: {},
      files: [{
        path: "/skills/reader/SKILL.md",
        content: "---\nname: reader\ndescription: Reads workspace files.\n---\n\nRead the plan.",
      }],
    },
  ],
]);

describe("sandbox", () => {
  it("mounts the guest workspace and gives execute to the orchestrator only", async () => {
    const model = new SandboxScriptModel({});
    const sandbox = new FakeSandbox();
    const agent = await createPizzaBotAgent("Use the sandbox.", { model, skills, sandbox });

    for await (const _ of agent.streamProtocol(
      { messages: [{ id: "u1", role: "user", parts: [{ type: "text", text: "Go." }] }] },
      { threadId: `sandbox_${Math.random().toString(36).slice(2)}` },
    )) {
      // Drain the stream so delegated work completes.
    }

    expect([...sandbox.files.keys()]).toEqual(["/workspace/notes/plan.txt"]);
    expect(sandbox.commands).toEqual(["ls -R"]);
    expect(model.systemPrompt).toContain("isolated Linux virtual machine");
    expect(model.toolsByCall[0]).toContain("execute");
    expect(model.toolResults[2]).toContain("/workspace/notes/plan.txt");
    expect(model.toolResults[3]).toContain("/workspace/notes/plan.txt");
    expect(model.toolResults[3]).not.toContain("/workspace/workspace");
    expect(model.toolsByCall[4]).toContain("read_file");
    expect(model.toolsByCall[4]).not.toContain("execute");
    expect(model.toolResults[5]).toContain("preheat");
  });

  it("rejects a sandbox that cannot execute", async () => {
    await expect(
      createPizzaBotAgent("x", { model: new SandboxScriptModel({}), sandbox: {} }),
    ).rejects.toThrow("sandbox protocol");
  });
});
