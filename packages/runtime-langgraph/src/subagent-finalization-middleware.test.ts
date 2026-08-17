import { describe, expect, it, vi } from "vitest";
import {
  AIMessage,
  HumanMessage,
  SystemMessage,
  ToolMessage,
  type BaseMessage,
} from "@langchain/core/messages";
import { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { tool } from "@langchain/core/tools";
import { createSubAgent } from "deepagents";
import { modelCallLimitMiddleware, type AnyAgentMiddleware } from "langchain";
import {
  SUBAGENT_MODEL_CALL_COUNT,
  SUBAGENT_FINALIZATION_INSTRUCTION,
  subagentFinalizationMiddleware,
} from "./subagent-finalization-middleware.js";

function wrapModelCall(runLimit = 20) {
  const middleware = subagentFinalizationMiddleware(runLimit) as unknown as {
    wrapModelCall: (
      request: {
        state: { runSubagentModelCallCount: number };
        messages: BaseMessage[];
        systemMessage: SystemMessage;
        tools: unknown[];
      },
      handler: (request: {
        state: { runSubagentModelCallCount: number };
        messages: BaseMessage[];
        systemMessage: SystemMessage;
        tools: unknown[];
      }) => Promise<AIMessage>,
    ) => Promise<AIMessage>;
  };
  return middleware.wrapModelCall;
}

interface TestModelRequest {
  state: { runSubagentModelCallCount: number };
  messages: BaseMessage[];
  systemMessage: SystemMessage;
  tools: unknown[];
}

function request(runModelCallCount: number): TestModelRequest {
  return {
    state: { [SUBAGENT_MODEL_CALL_COUNT]: runModelCallCount },
    messages: [new HumanMessage("research")],
    systemMessage: new SystemMessage("You are a researcher."),
    tools: [{ name: "search" }],
  };
}

interface FinalizingTrace {
  calls: number;
  lookupCalls: number;
  sawFinalizationInstruction: boolean;
  finalCallHadToolProtocol: boolean;
}

class FinalizingModel extends BaseChatModel<Record<string, never>> {
  private boundToolCount = 0;

  constructor(private readonly trace: FinalizingTrace) {
    super({});
  }

  _llmType(): string {
    return "finalizing";
  }

  override bindTools(tools: Array<{ name: string }>): this {
    const bound = new FinalizingModel(this.trace);
    bound.boundToolCount = tools.length;
    return bound as this;
  }

  async _generate(
    messages: BaseMessage[],
  ): Promise<{ generations: Array<{ message: AIMessage; text: string }> }> {
    this.trace.calls += 1;
    this.trace.sawFinalizationInstruction ||= messages.some(
      (message) =>
        SystemMessage.isInstance(message) &&
        message.text.includes(SUBAGENT_FINALIZATION_INSTRUCTION),
    );
    if (this.boundToolCount === 0) {
      this.trace.finalCallHadToolProtocol ||= messages.some(
        (message) =>
          ToolMessage.isInstance(message) ||
          (AIMessage.isInstance(message) && Boolean(message.tool_calls?.length)),
      );
    }
    const message = this.boundToolCount > 0
      ? new AIMessage({
          content: "",
          tool_calls: [{
            id: "lookup-1",
            name: "lookup",
            args: {},
            type: "tool_call",
          }],
        })
      : new AIMessage(
          messages.some((message) => message.text.includes("verified finding"))
            ? "Partial result: verified finding"
            : "Partial result: nothing found",
        );
    return { generations: [{ message, text: message.text }] };
  }
}

describe("subagentFinalizationMiddleware", () => {
  it("leaves ordinary worker calls unchanged", async () => {
    const wrap = wrapModelCall();
    const input = request(18);
    const handler = vi.fn(async (_request: ReturnType<typeof request>) =>
      new AIMessage("continue")
    );

    await wrap(input, handler);

    expect(handler).toHaveBeenCalledWith(input);
  });

  it("makes the final allowed worker call tool-free and requests partial results", async () => {
    const wrap = wrapModelCall();
    const input = request(19);
    input.messages.push(
      new AIMessage({
        content: "",
        tool_calls: [{
          id: "lookup-1",
          name: "search",
          args: {},
          type: "tool_call",
        }],
      }),
      new ToolMessage({
        content: "verified finding",
        tool_call_id: "lookup-1",
        name: "search",
      }),
    );
    const handler = vi.fn(async (_request: ReturnType<typeof request>) =>
      new AIMessage("verified partial result")
    );

    const result = await wrap(input, handler);

    expect(result.text).toBe("verified partial result");
    const finalRequest = handler.mock.calls[0]![0];
    expect(finalRequest.tools).toEqual([]);
    expect(finalRequest.systemMessage.text).toContain(SUBAGENT_FINALIZATION_INSTRUCTION);
    expect(finalRequest.messages.some(ToolMessage.isInstance)).toBe(false);
    expect(finalRequest.messages.some(
      (message) => AIMessage.isInstance(message) && Boolean(message.tool_calls?.length),
    )).toBe(false);
    expect(finalRequest.messages.at(-1)?.text).toContain("verified finding");
  });

  it("rejects invalid limits", () => {
    expect(() => subagentFinalizationMiddleware(0)).toThrow("positive integer");
  });

  it("returns accumulated worker results on the last invocation-local model call", async () => {
    const trace: FinalizingTrace = {
      calls: 0,
      lookupCalls: 0,
      sawFinalizationInstruction: false,
      finalCallHadToolProtocol: false,
    };
    const lookup = tool(
      () => {
        trace.lookupCalls += 1;
        return "verified finding";
      },
      {
        name: "lookup",
        description: "Find a fact.",
        schema: {
          type: "object",
          properties: {},
          additionalProperties: false,
        },
      },
    );
    const worker = createSubAgent({
      name: "researcher",
      description: "Researches facts.",
      systemPrompt: "Use lookup before answering.",
      model: new FinalizingModel(trace),
      tools: [lookup],
      middleware: [
        (modelCallLimitMiddleware as unknown as (options: {
          runLimit: number;
          exitBehavior: "end";
        }) => AnyAgentMiddleware)({
          runLimit: 2,
          exitBehavior: "end",
        }),
        subagentFinalizationMiddleware(2),
      ],
    });

    for (const prompt of ["Find the fact.", "Find it again."]) {
      const result = await worker.invoke({
        messages: [new HumanMessage(prompt)],
      });
      const final = result.messages.at(-1);

      expect(final).toBeInstanceOf(AIMessage);
      expect(final?.text).toBe("Partial result: verified finding");
      expect(final?.text).not.toContain("Model call limits exceeded");
    }
    expect(trace).toEqual({
      calls: 4,
      lookupCalls: 2,
      sawFinalizationInstruction: true,
      finalCallHadToolProtocol: false,
    });
  });
});
