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
    for (const command of [42, null, true, ["npx"]]) {
      expect(parseMcpJson(JSON.stringify({ mcpServers: { local: { command } } }))).toEqual({
        ok: false,
        error: "command must be a string.",
      });
    }
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

  it("rejects urls the server would refuse, before they reach the form", () => {
    for (const url of ["", "   ", "not a url", "example.com/mcp", "http://"]) {
      expect(parseMcpJson(JSON.stringify({ mcpServers: { remote: { url } } }))).toEqual({
        ok: false,
        error: "url must be a valid URL.",
      });
    }
  });

  it("enforces mutually exclusive transports and type values", () => {
    expect(parseMcpJson(JSON.stringify({ mcpServers: { invalid: { command: "uvx", url: "https://example.com" } } }))).toMatchObject({ ok: false });
    expect(parseMcpJson(JSON.stringify({ mcpServers: { invalid: {} } }))).toMatchObject({ ok: false });
    expect(parseMcpJson(JSON.stringify({ mcpServers: { invalid: { type: "stdio", url: "https://example.com" } } }))).toMatchObject({ ok: false });
    expect(parseMcpJson(JSON.stringify({ mcpServers: { invalid: { type: "grpc", url: "https://example.com" } } }))).toMatchObject({ ok: false });
    expect(parseMcpJson(JSON.stringify({ mcpServers: { invalid: { type: "http", command: "npx" } } }))).toEqual({
      ok: false,
      error: "The transport type does not match the server fields.",
    });
    expect(parseMcpJson(JSON.stringify({ mcpServers: { remote: { type: "streamable-http", url: "https://example.com" } } }))).toMatchObject({ ok: true });
    expect(parseMcpJson(JSON.stringify({ mcpServers: { local: { type: "stdio", command: "npx" } } }))).toMatchObject({ ok: true });
  });

  it("drops fields it does not recognize and reports them", () => {
    expect(
      parseMcpJson(
        JSON.stringify({
          mcpServers: {
            local: { command: "npx", disabled: false, autoApprove: [], timeout: 60, transportType: "stdio" },
          },
        }),
      ),
    ).toEqual({
      ok: true,
      value: {
        name: "local",
        entry: { command: "npx" },
        warnings: ["Ignored unsupported fields: disabled, autoApprove, timeout, transportType"],
      },
    });
    expect(
      parseMcpJson(JSON.stringify({ mcpServers: { remote: { url: "https://example.com/mcp", env: { API_KEY: "x" } } } })),
    ).toEqual({
      ok: true,
      value: { name: "remote", entry: { url: "https://example.com/mcp" }, warnings: ["Ignored unsupported fields: env"] },
    });
  });

  it("carries enabled through on both transports and rejects non-boolean values", () => {
    expect(parseMcpJson(JSON.stringify({ mcpServers: { local: { command: "npx", enabled: false } } }))).toEqual({
      ok: true,
      value: { name: "local", entry: { command: "npx", enabled: false }, warnings: [] },
    });
    expect(parseMcpJson(JSON.stringify({ mcpServers: { remote: { url: "https://example.com/mcp", enabled: true } } }))).toEqual({
      ok: true,
      value: { name: "remote", entry: { url: "https://example.com/mcp", enabled: true }, warnings: [] },
    });
    expect(parseMcpJson(JSON.stringify({ mcpServers: { local: { command: "npx", enabled: "no" } } }))).toEqual({
      ok: false,
      error: "enabled must be true or false.",
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
