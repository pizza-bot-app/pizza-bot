import { describe, expect, it, vi } from "vitest";
import { AIMessage, HumanMessage, SystemMessage, type BaseMessage } from "@langchain/core/messages";
import {
  RESPONSE_TOOL_INSTRUCTION,
  RESPONSE_TOOL_NAME,
  RESPONSE_TOOL_REMINDER,
  asResponseFormat,
  structuredResponseMiddleware,
} from "./structured-response-middleware.js";

interface TestModelRequest {
  messages: BaseMessage[];
  systemMessage: SystemMessage;
  responseFormat?: unknown;
  toolChoice?: unknown;
  model?: unknown;
}

type Handler = (request: TestModelRequest) => Promise<unknown>;

const wrapModelCall = (
  structuredResponseMiddleware() as unknown as {
    wrapModelCall: (request: TestModelRequest, handler: Handler) => Promise<unknown>;
  }
).wrapModelCall;

const schema = { type: "object", properties: { ok: { type: "boolean" } } };

function request(responseFormat?: unknown): TestModelRequest {
  return {
    messages: [new HumanMessage("research")],
    systemMessage: new SystemMessage("You are a researcher."),
    ...(responseFormat ? { responseFormat } : {}),
  };
}

describe("structuredResponseMiddleware", () => {
  it("leaves a call without a response format untouched", async () => {
    const handler = vi.fn<Handler>(async () => new AIMessage("done"));
    const original = request();
    await wrapModelCall(original, handler);
    expect(handler).toHaveBeenCalledExactlyOnceWith(original);
  });

  it("leaves a model with native structured output untouched", async () => {
    const handler = vi.fn<Handler>(async () => new AIMessage("{\"ok\":true}"));
    const original = { ...request(schema), model: { profile: { structuredOutput: true } } };
    await wrapModelCall(original, handler);
    expect(handler).toHaveBeenCalledExactlyOnceWith(original);
  });

  it("asks for the response tool with auto tool choice", async () => {
    const parsed = { structuredResponse: { ok: true }, messages: [] };
    const handler = vi.fn<Handler>(async () => parsed);
    await expect(wrapModelCall(request(schema), handler)).resolves.toBe(parsed);
    expect(handler).toHaveBeenCalledOnce();
    const sent = handler.mock.calls[0]![0];
    expect(sent.toolChoice).toBe("auto");
    expect(sent.systemMessage.text).toContain(RESPONSE_TOOL_INSTRUCTION);
  });

  it("does not retry a turn that calls other tools", async () => {
    const working = new AIMessage({
      content: "",
      tool_calls: [{ id: "c1", name: "search", args: {} }],
    });
    const handler = vi.fn<Handler>(async () => working);
    await expect(wrapModelCall(request(schema), handler)).resolves.toBe(working);
    expect(handler).toHaveBeenCalledOnce();
  });

  it("reminds a prose answer once to call the response tool", async () => {
    const prose = new AIMessage("ok is true");
    const parsed = { structuredResponse: { ok: true }, messages: [] };
    const handler = vi.fn<Handler>()
      .mockResolvedValueOnce(prose)
      .mockResolvedValueOnce(parsed);
    await expect(wrapModelCall(request(schema), handler)).resolves.toBe(parsed);
    const retry = handler.mock.calls[1]![0];
    expect(retry.toolChoice).toBe("auto");
    expect(retry.messages.at(-2)).toBe(prose);
    expect(retry.messages.at(-1)?.text).toBe(RESPONSE_TOOL_REMINDER);
  });
});

describe("asResponseFormat", () => {
  it("names the tool and gives it a description, keeping an authored one", () => {
    const bare = { ...schema, title: "Country Info" };
    expect(asResponseFormat(bare).title).toBe(RESPONSE_TOOL_NAME);
    expect(asResponseFormat(bare).description).toEqual(expect.stringMatching(/\S/));
    expect(asResponseFormat({ ...bare, description: " " }).description).not.toBe(" ");
    expect(asResponseFormat({ ...bare, description: "Verdict." }).description).toBe("Verdict.");
  });
});
