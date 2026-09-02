import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { chmodSync, mkdtempSync, statSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { connectMcpServers, McpClientPool } from "./plugin-host.js";
import {
  loadUserMcpServers,
  writeUserMcpServers,
  expandMcpEnvVars,
} from "./mcp-servers-config.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const STATUS_SERVER = resolve(
  __dirname,
  "../../../examples/plugins/mcp-status/src/server.js",
);
const EMPTY_DESC_SERVER = resolve(__dirname, "__fixtures__/mcp-empty-desc-server.mjs");
const DELAYED_SERVER = resolve(__dirname, "__fixtures__/mcp-delayed-server.mjs");
const UNION_SCHEMA_SERVER = resolve(__dirname, "__fixtures__/mcp-union-schema-server.mjs");

describe("connectMcpServers", () => {
  it("returns an empty result (no client) for no entries", async () => {
    const r = await connectMcpServers({}, undefined);
    expect(r.client).toBeUndefined();
    expect(r.tools).toEqual({});
    expect(r.catalog).toEqual({});
    expect(r.errors).toEqual({});
  });

  it("connects a real stdio MCP server and returns its tools + catalog", async () => {
    const r = await connectMcpServers(
      { "mcp-status": { command: "node", args: [STATUS_SERVER] } },
      undefined,
    );
    try {
      expect(r.catalog["mcp-status"]).toContain("get_mcp_status");
      expect(r.tools).toHaveProperty("mcp:mcp-status:get_mcp_status");
      expect(r.tools["mcp:mcp-status:get_mcp_status"]?.name)
        .toBe("mcp-status__get_mcp_status");
    } finally {
      await r.client?.close().catch(() => {});
    }
  }, 20_000);

  it("launches a Node MCP server with Electron's Node mode enabled", async () => {
    const r = await connectMcpServers(
      {
        electron: {
          command: "node",
          args: [DELAYED_SERVER],
          env: { MCP_REQUIRE_ELECTRON_RUN_AS_NODE: "1" },
        },
      },
      process.execPath,
      undefined,
      "pipe",
      undefined,
      { electronRunAsNode: true, maxAttempts: 1 },
    );
    try {
      expect(r.catalog.electron).toContain("get_mcp_status");
      expect(r.errors).toEqual({});
    } finally {
      await r.client?.close().catch(() => {});
    }
  }, 20_000);

  it("preserves nullable primitive types from the MCP server schema", async () => {
    const r = await connectMcpServers(
      { delayed: { command: "node", args: [DELAYED_SERVER] } },
      undefined,
    );
    try {
      const tool = r.tools["mcp:delayed:get_mcp_status"];
      expect(tool).toBeDefined();
      expect(tool!.schema).toMatchObject({
        type: "object",
        properties: {
          value: { type: "string" },
        },
      });
    } finally {
      await r.client?.close().catch(() => {});
    }
  }, 20_000);

  it("calls a tool with either branch of a union its server accepts", async () => {
    const r = await connectMcpServers(
      { union: { command: "node", args: [UNION_SCHEMA_SERVER] } },
      undefined,
    );
    try {
      const tool = r.tools["mcp:union:search_records"];
      expect(tool).toBeDefined();

      const leaf = { condition: { field: "accountId", operator: "EXACT_MATCH", value: "a-1" } };
      const compound = {
        condition: { operator: "AND", conditions: [leaf.condition] },
      };
      await expect(tool!.invoke(leaf)).resolves.toContain("EXACT_MATCH");
      await expect(tool!.invoke(compound)).resolves.toContain("AND");
      await expect(tool!.invoke({ aliases: "solo" })).resolves.toContain("solo");
      await expect(tool!.invoke({ aliases: ["a", "b"] })).resolves.toContain("b");
    } finally {
      await r.client?.close().catch(() => {});
    }
  }, 20_000);

  it("names the failing constraint when a tool call really is malformed", async () => {
    const r = await connectMcpServers(
      { union: { command: "node", args: [UNION_SCHEMA_SERVER] } },
      undefined,
    );
    try {
      const tool = r.tools["mcp:union:search_records"];
      await expect(
        tool!.invoke({ condition: { field: "accountId", operator: "NOPE", value: "a-1" } }),
      ).rejects.toThrow(/operator/);
    } finally {
      await r.client?.close().catch(() => {});
    }
  }, 20_000);

  it("backfills an empty tool description with the tool name (Bedrock 400 guard)", async () => {
    const r = await connectMcpServers(
      { "empty-desc": { command: "node", args: [EMPTY_DESC_SERVER] } },
      undefined,
    );
    try {
      const tool = r.tools["mcp:empty-desc:blank_tool"];
      expect(tool).toBeDefined();
      expect(tool!.description.length).toBeGreaterThan(0);
      expect(tool!.description).toBe("blank_tool");
    } finally {
      await r.client?.close().catch(() => {});
    }
  }, 20_000);

  it("ignores a broken server without sinking the rest", async () => {
    const events: Array<{ server: string; status: string; detail?: string }> = [];
    const r = await connectMcpServers(
      {
        "mcp-status": { command: "node", args: [STATUS_SERVER] },
        broken: { command: "node", args: ["/no/such/server.js"] },
      },
      undefined,
      undefined,
      "inherit",
      undefined,
      {
        retryDelayMs: 0,
        onStatus: (event) => events.push(event),
      },
    );
    try {
      expect(r.catalog["mcp-status"]).toContain("get_mcp_status");
      expect(r.catalog.broken).toBeUndefined();
      expect(r.errors.broken).toBeTypeOf("string");
      expect(events).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ server: "mcp-status", status: "connected" }),
          expect.objectContaining({ server: "broken", status: "loading" }),
          expect.objectContaining({ server: "broken", status: "retrying" }),
          expect.objectContaining({ server: "broken", status: "error" }),
        ]),
      );
      expect(events.find((event) => event.server === "broken" && event.status === "error")?.detail)
        .toBeTypeOf("string");
    } finally {
      await r.client?.close().catch(() => {});
    }
  }, 20_000);

  it("publishes cumulative progress while respecting the startup concurrency limit", async () => {
    let active = 0;
    let maxActive = 0;
    const snapshots: string[][] = [];
    const r = await connectMcpServers(
      {
        first: {
          command: "node",
          args: [DELAYED_SERVER],
          env: { MCP_STARTUP_DELAY_MS: "50" },
        },
        second: {
          command: "node",
          args: [DELAYED_SERVER],
          env: { MCP_STARTUP_DELAY_MS: "50" },
        },
      },
      undefined,
      undefined,
      "pipe",
      undefined,
      {
        concurrency: 1,
        onStatus: (event) => {
          if (event.status === "loading") {
            active++;
            maxActive = Math.max(maxActive, active);
          } else if (event.status === "connected" || event.status === "error") {
            active--;
          }
        },
        onProgress: ({ catalog }) => snapshots.push(Object.keys(catalog).sort()),
      },
    );
    try {
      expect(maxActive).toBe(1);
      expect(snapshots).toEqual([["first"], ["first", "second"]]);
    } finally {
      await r.client?.close().catch(() => {});
    }
  }, 20_000);

  it("bounds a connection attempt with a timeout", async () => {
    const r = await connectMcpServers(
      {
        delayed: {
          command: "node",
          args: [DELAYED_SERVER],
          env: { MCP_STARTUP_DELAY_MS: "1000" },
        },
      },
      undefined,
      undefined,
      "pipe",
      undefined,
      { maxAttempts: 1, connectionTimeoutMs: 25 },
    );
    expect(r.catalog).toEqual({});
    expect(r.errors.delayed).toContain("timed out");
  }, 5_000);

  it("does not launch disabled servers", async () => {
    const events: string[] = [];
    const r = await connectMcpServers(
      { disabled: { command: "node", args: ["/no/such/server.js"], enabled: false } },
      undefined,
      undefined,
      "pipe",
      undefined,
      { onStatus: (event) => events.push(event.status) },
    );
    expect(r).toMatchObject({ tools: {}, catalog: {}, errors: {} });
    expect(events).toEqual([]);
  });
});

describe("McpClientPool", () => {
  it("transfers one replacement without disturbing sibling ownership", async () => {
    const oldMail = {
      getClient: vi.fn(async () => ({ id: "old-mail" })),
      close: vi.fn(async () => {}),
    };
    const calendar = {
      getClient: vi.fn(async () => ({ id: "calendar" })),
      close: vi.fn(async () => {}),
    };
    const newMail = {
      getClient: vi.fn(async () => ({ id: "new-mail" })),
      close: vi.fn(async () => {}),
    };
    const pool = new McpClientPool(
      new Map([
        ["mail", oldMail as never],
        ["calendar", calendar as never],
      ]),
    );
    const replacement = new McpClientPool(
      new Map([["mail", newMail as never]]),
    );

    const displaced = pool.replaceServer("mail", replacement);

    expect(replacement.size).toBe(0);
    await expect(pool.getClient("mail")).resolves.toEqual({ id: "new-mail" });
    await expect(pool.getClient("calendar")).resolves.toEqual({ id: "calendar" });
    await displaced?.close();
    expect(oldMail.close).toHaveBeenCalledOnce();
    expect(calendar.close).not.toHaveBeenCalled();
    expect(newMail.close).not.toHaveBeenCalled();
  });
});

describe("loadUserMcpServers (single .mcp.json config file)", () => {
  let dir: string;
  let configFile: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "user-mcp-"));
    configFile = join(dir, ".mcp.json");
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const write = (mcpServers: Record<string, unknown>) =>
    writeFileSync(configFile, JSON.stringify({ mcpServers }));

  it("returns {} for a missing file", async () => {
    expect(await loadUserMcpServers(join(dir, "nope.json"))).toEqual({});
  });

  it("returns {} for a file with no mcpServers key (defaulted to empty)", async () => {
    writeFileSync(configFile, JSON.stringify({}));
    expect(await loadUserMcpServers(configFile)).toEqual({});
  });

  it("reads a valid stdio entry keyed by its map key", async () => {
    write({ echo: { command: "node", args: ["s.js"] } });
    const out = await loadUserMcpServers(configFile);
    expect(out).toHaveProperty("echo");
    expect(out.echo).toMatchObject({ command: "node", args: ["s.js"] });
  });

  it("preserves an explicit disabled state", async () => {
    write({ echo: { command: "node", args: ["s.js"], enabled: false } });
    const out = await loadUserMcpServers(configFile);
    expect(out.echo).toMatchObject({ enabled: false });
  });

  it("reads a valid url entry (defaulting type to http)", async () => {
    write({ remote: { url: "https://example.com/mcp" } });
    const out = await loadUserMcpServers(configFile);
    expect(out.remote).toMatchObject({ url: "https://example.com/mcp", type: "http" });
  });

  it("reads MULTIPLE servers from one file", async () => {
    write({
      echo: { command: "node", args: ["s.js"] },
      remote: { url: "https://example.com/mcp" },
    });
    const out = await loadUserMcpServers(configFile);
    expect(Object.keys(out).sort()).toEqual(["echo", "remote"]);
  });

  it("reports non-JSON once and yields {}", async () => {
    writeFileSync(configFile, "{ not valid json");
    const errs: string[] = [];
    const out = await loadUserMcpServers(configFile, (f) => errs.push(f));
    expect(out).toEqual({});
    expect(errs.length).toBe(1);
  });

  it("skips only the individually-invalid entries, keeping the valid ones", async () => {
    write({
      good: { url: "https://example.com/mcp" },
      bad: { nonsense: true },
    });
    const errs: string[] = [];
    const out = await loadUserMcpServers(configFile, (f) => errs.push(f));
    expect(out).toHaveProperty("good");
    expect(out).not.toHaveProperty("bad");
    expect(errs.length).toBe(1);
  });

  it("loads a `${ENV_VAR}` reference RAW (expansion is a connect-time concern)", async () => {
    write({ remote: { type: "http", url: "https://example.com/mcp", headers: { Authorization: "Bearer ${MY_TOKEN}" } } });
    const out = await loadUserMcpServers(configFile);
    expect((out.remote as { headers: Record<string, string> }).headers.Authorization).toBe("Bearer ${MY_TOKEN}");
  });

  it("writes configuration with user-only permissions", async () => {
    chmodSync(dir, 0o755);
    await writeUserMcpServers(configFile, {
      remote: { type: "http", url: "https://example.com/mcp" },
    });

    if (process.platform !== "win32") {
      expect(statSync(dir).mode & 0o777).toBe(0o700);
      expect(statSync(configFile).mode & 0o777).toBe(0o600);
    }
  });
});

describe("expandMcpEnvVars", () => {
  const prev = process.env.MY_TOKEN;
  afterEach(() => {
    if (prev === undefined) delete process.env.MY_TOKEN;
    else process.env.MY_TOKEN = prev;
  });

  it("expands `${ENV_VAR}` in nested strings (headers, env, args)", () => {
    process.env.MY_TOKEN = "sekret";
    const expanded = expandMcpEnvVars({
      remote: { type: "http", url: "https://example.com/mcp", headers: { Authorization: "Bearer ${MY_TOKEN}" } },
      local: { command: "node", args: ["--token=${MY_TOKEN}"], env: { API_KEY: "${MY_TOKEN}" } },
    });
    expect(expanded.remote.headers!.Authorization).toBe("Bearer sekret");
    expect(expanded.local.args![0]).toBe("--token=sekret");
    expect(expanded.local.env!.API_KEY).toBe("sekret");
  });

  it("expands an unset var to the empty string, leaving non-refs untouched", () => {
    delete process.env.MY_TOKEN;
    const expanded = expandMcpEnvVars({ url: "https://x/${MY_TOKEN}", type: "http" as const });
    expect(expanded.url).toBe("https://x/");
    expect(expanded.type).toBe("http");
  });
});
