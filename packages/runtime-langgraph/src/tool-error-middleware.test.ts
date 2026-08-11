import { describe, it, expect } from "vitest";
import { ToolMessage } from "@langchain/core/messages";
import { GraphInterrupt } from "@langchain/langgraph";
import { ToolInvocationError } from "langchain";
import { toolErrorRecoveryMiddleware } from "./tool-error-middleware.js";

function wrapToolCall() {
  const mw = toolErrorRecoveryMiddleware() as unknown as {
    wrapToolCall: (
      req: { toolCall: { id?: string; name: string; args?: unknown } },
      handler: (req: unknown) => Promise<unknown>,
    ) => Promise<unknown>;
  };
  return mw.wrapToolCall;
}

const request = (name = "task", id = "call_1") => ({ toolCall: { id, name, args: {} } });

describe("toolErrorRecoveryMiddleware", () => {
  it("passes a successful tool result straight through", async () => {
    const wrap = wrapToolCall();
    const ok = new ToolMessage({ content: "done", tool_call_id: "call_1", name: "task" });
    const out = await wrap(request(), async () => ok);
    expect(out).toBe(ok);
  });

  it("converts a thrown tool error into a status:error ToolMessage the model can retry", async () => {
    const wrap = wrapToolCall();
    const out = (await wrap(request("task", "call_9"), async () => {
      throw new Error("subagent_type: Required");
    })) as ToolMessage;
    expect(ToolMessage.isInstance(out)).toBe(true);
    expect(out.status).toBe("error");
    expect(out.tool_call_id).toBe("call_9");
    expect(out.name).toBe("task");
    expect(String(out.content)).toContain("subagent_type: Required");
    expect(String(out.content)).toContain("try again");
  });

  it("RE-THROWS a graph interrupt (HITL must still pause, not be swallowed)", async () => {
    const wrap = wrapToolCall();
    const interrupt = new GraphInterrupt([{ value: "approve?", id: "i1" }]);
    await expect(
      wrap(request(), async () => {
        throw interrupt;
      }),
    ).rejects.toBe(interrupt);
  });

  it("handles a non-Error throw by stringifying it", async () => {
    const wrap = wrapToolCall();
    const out = (await wrap(request(), async () => {
      throw "boom";
    })) as ToolMessage;
    expect(out.status).toBe("error");
    expect(String(out.content)).toContain("boom");
  });

  it("unwraps tool input errors without exposing their embedded stack", async () => {
    const wrap = wrapToolCall();
    const parseError = new Error("Received tool input did not match expected schema");
    parseError.stack = `${parseError.message}\n    at DynamicStructuredTool.call (/workspace/tool.ts:1:1)`;
    const invocationError = new ToolInvocationError(parseError, {
      id: "call_2",
      name: "search_accounts",
      args: { condition: {} },
      type: "tool_call",
    });

    const out = (await wrap(request("search_accounts", "call_2"), async () => {
      throw invocationError;
    })) as ToolMessage;

    expect(String(out.content)).toContain(parseError.message);
    expect(String(out.content)).not.toContain("DynamicStructuredTool.call");
  });
});
