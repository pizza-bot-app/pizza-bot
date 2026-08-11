import { describe, expect, it } from "vitest";
import { formatLogContextSummary } from "./log-summary.js";

describe("formatLogContextSummary", () => {
  it("summarizes HTTP request context", () => {
    expect(
      formatLogContextSummary({
        message: "HTTP request",
        context: {
          method: "GET",
          path: "/threads/events",
          status: 200,
          durationMs: 0,
        },
      }),
    ).toBe("GET /threads/events · 200 · 0 ms");
  });

  it("summarizes failed and partial HTTP request context", () => {
    expect(
      formatLogContextSummary({
        message: "HTTP request failed",
        context: {
          method: "POST",
          path: "/runs",
          durationMs: 12,
        },
      }),
    ).toBe("POST /runs · 12 ms");
  });

  it("summarizes MCP lifecycle context without repeating the message status", () => {
    expect(
      formatLogContextSummary({
        message: "MCP server loading",
        context: {
          mcpServer: "mcp-status",
          status: "loading",
          attempt: 1,
          toolCount: null,
          detail: null,
        },
      }),
    ).toBe("mcp-status · attempt 1");

    expect(
      formatLogContextSummary({
        message: "MCP server connected",
        context: {
          mcpServer: "outlook",
          status: "connected",
          attempt: 1,
          toolCount: 1,
        },
      }),
    ).toBe("outlook · attempt 1 · 1 tool");
  });

  it("summarizes MCP tool calls, runs, and process failures", () => {
    expect(
      formatLogContextSummary({
        message: "MCP tool call completed",
        context: {
          mcpServer: "outlook",
          mcpTool: "search",
          toolRef: "mcp:outlook:search",
          durationMs: 420,
        },
      }),
    ).toBe("outlook · search · 420 ms");

    expect(
      formatLogContextSummary({
        message: "Run ended",
        context: {
          threadId: "thread-1",
          runId: "run-1",
          status: "completed",
        },
      }),
    ).toBe("completed");

    expect(
      formatLogContextSummary({
        message: "Electron child process exited",
        context: {
          type: "GPU",
          reason: "crashed",
          exitCode: 9,
        },
      }),
    ).toBe("GPU · crashed · exit 9");
  });

  it("does not expose arbitrary context for other events", () => {
    expect(
      formatLogContextSummary({
        message: "Agent event",
        context: {
          requestId: "request-1",
          threadId: "thread-1",
          runId: "run-1",
          detail: "Verbose detail",
        },
      }),
    ).toBeUndefined();
  });
});
