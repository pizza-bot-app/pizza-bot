import { describe, expect, it } from "vitest";
import { parseMcpJson } from "./mcp-json.js";

describe("parseMcpJson", () => {
  it("requires the mcpServers wrapper and preserves the server name", () => {
    expect(parseMcpJson(JSON.stringify({ command: "uvx" }))).toMatchObject({ ok: false });
    expect(parseMcpJson(JSON.stringify({ mcpServers: { arbitrary: { command: "uvx" } } }))).toEqual({
      ok: true,
      value: { name: "arbitrary", entry: { command: "uvx" }, warnings: [] },
    });
  });

  it("accepts local stdio servers and validates args and env", () => {
    expect(
      parseMcpJson(
        JSON.stringify({
          mcpServers: {
            local: {
              command: "uvx",
              args: ["server", "${VAR}"],
              env: { API_KEY: "${MY_API_KEY}", DEBUG: "true" },
            },
          },
        }),
      ),
    ).toMatchObject({ ok: true, value: { entry: { command: "uvx", args: ["server", "${VAR}"] } } });
    expect(parseMcpJson(JSON.stringify({ mcpServers: { local: { args: ["server"] } } }))).toMatchObject({ ok: false });
    expect(parseMcpJson(JSON.stringify({ mcpServers: { local: { command: "" } } }))).toMatchObject({ ok: false });
    expect(parseMcpJson(JSON.stringify({ mcpServers: { local: { command: "   " } } }))).toMatchObject({ ok: false });
    expect(parseMcpJson(JSON.stringify({ mcpServers: { local: { command: "uvx", env: { PORT: 8080 } } } }))).toMatchObject({ ok: false });
    expect(parseMcpJson(JSON.stringify({ mcpServers: { local: { command: "uvx", env: { DEBUG: true } } } }))).toMatchObject({ ok: false });
  });

  it("accepts remote HTTP and SSE servers with string headers", () => {
    expect(parseMcpJson(JSON.stringify({ mcpServers: { remote: { url: "https://example.com/mcp" } } }))).toMatchObject({
      ok: true,
      value: { entry: { url: "https://example.com/mcp" } },
    });
    expect(parseMcpJson(JSON.stringify({ mcpServers: { remote: { type: "sse", url: "https://example.com/sse" } } }))).toMatchObject({
      ok: true,
      value: { entry: { type: "sse" } },
    });
    expect(parseMcpJson(JSON.stringify({ mcpServers: { remote: { url: "https://example.com", headers: { Authorization: "Bearer ${TOKEN}" } } } }))).toMatchObject({ ok: true });
    expect(parseMcpJson(JSON.stringify({ mcpServers: { remote: { url: "https://example.com", headers: { Port: 8080 } } } }))).toMatchObject({ ok: false });
  });

  it("enforces mutually exclusive transports and type values", () => {
    expect(parseMcpJson(JSON.stringify({ mcpServers: { invalid: { command: "uvx", url: "https://example.com" } } }))).toMatchObject({ ok: false });
    expect(parseMcpJson(JSON.stringify({ mcpServers: { invalid: {} } }))).toMatchObject({ ok: false });
    expect(parseMcpJson(JSON.stringify({ mcpServers: { invalid: { type: "stdio", url: "https://example.com" } } }))).toMatchObject({ ok: false });
    expect(parseMcpJson(JSON.stringify({ mcpServers: { invalid: { type: "grpc", url: "https://example.com" } } }))).toMatchObject({ ok: false });
    expect(parseMcpJson(JSON.stringify({ mcpServers: { remote: { type: "streamable-http", url: "https://example.com" } } }))).toMatchObject({ ok: true });
    expect(parseMcpJson(JSON.stringify({ mcpServers: { local: { type: "stdio", command: "npx" } } }))).toMatchObject({ ok: true });
  });

  it("drops fields it does not recognize and reports them", () => {
    expect(
      parseMcpJson(
        JSON.stringify({
          mcpServers: {
            local: { command: "npx", disabled: false, autoApprove: [], timeout: 60, transportType: "stdio", enabled: false },
          },
        }),
      ),
    ).toEqual({
      ok: true,
      value: {
        name: "local",
        entry: { command: "npx" },
        warnings: ["Ignored unsupported fields: disabled, autoApprove, timeout, transportType, enabled"],
      },
    });
    expect(
      parseMcpJson(JSON.stringify({ mcpServers: { remote: { url: "https://example.com/mcp", env: { API_KEY: "x" }, enabled: false } } })),
    ).toEqual({
      ok: true,
      value: { name: "remote", entry: { url: "https://example.com/mcp" }, warnings: ["Ignored unsupported fields: env, enabled"] },
    });
  });

  it("uses only the first server and reports the skipped ones", () => {
    expect(
      parseMcpJson(JSON.stringify({ mcpServers: { first: { command: "a" }, second: { command: "b" }, third: { url: "https://c" } } })),
    ).toEqual({
      ok: true,
      value: { name: "first", entry: { command: "a" }, warnings: ["Only the first server was used; skipped: second, third"] },
    });
  });

  it("rejects other tools' names for the wrapper and the endpoint", () => {
    expect(parseMcpJson(JSON.stringify({ servers: { local: { command: "npx" } } }))).toEqual({
      ok: false,
      error: "JSON must contain an mcpServers object.",
    });
    expect(parseMcpJson(JSON.stringify({ mcpServers: { remote: { serverUrl: "https://example.com/mcp" } } }))).toEqual({
      ok: false,
      error: "A server must define command or url.",
    });
  });
});
