import { describe, it, expect } from "vitest";
import { ToolMessage } from "@langchain/core/messages";
import type { EvidenceEntry, NewEvidence } from "@pizza-bot/core";
import {
  evidenceBreadcrumb,
  evidenceLedgerMiddleware,
  type EvidenceLedgerOptions,
} from "./evidence-ledger-middleware.js";

interface FakeRequest {
  toolCall: { id?: string; name: string; args?: unknown };
  runtime: { configurable?: Record<string, unknown> };
}

type Wrap = (
  req: FakeRequest,
  handler: (req: FakeRequest) => Promise<unknown>,
) => Promise<unknown>;

function ledger(overrides: Partial<EvidenceLedgerOptions> = {}) {
  const recorded: NewEvidence[] = [];
  const options: EvidenceLedgerOptions = {
    recorder: async (entry) => {
      recorded.push(entry);
      return { ...entry, id: `ev_${recorded.length}`, excerpt: entry.body, createdAt: "t" } as
        unknown as EvidenceEntry;
    },
    refsByToolName: new Map([["mail__search", "mcp:mail:search"]]),
    gatedToolNames: new Set(["mail__send"]),
    ...overrides,
  };
  const mw = evidenceLedgerMiddleware(options) as unknown as { wrapToolCall: Wrap };
  return { wrap: mw.wrapToolCall, recorded };
}

const request = (name: string, args: unknown = {}, configurable: Record<string, unknown> = {
  thread_id: "t1",
  run_id: "r1",
}): FakeRequest => ({ toolCall: { id: "call_1", name, args }, runtime: { configurable } });

const result = (content: string, name = "mail__search") =>
  new ToolMessage({ content, tool_call_id: "call_1", name });

describe("evidenceLedgerMiddleware", () => {
  it("records a tool result and stamps it with the id the model must cite", async () => {
    const { wrap, recorded } = ledger();
    const out = (await wrap(request("mail__search", { query: "renewal" }), async () =>
      result("The renewal date is March 4th."))) as ToolMessage;

    expect(recorded).toEqual([
      {
        threadId: "t1",
        runId: "r1",
        toolRef: "mcp:mail:search",
        breadcrumb: "mcp:mail:search (query: renewal)",
        body: "The renewal date is March 4th.",
        bytes: 30,
        truncated: false,
      },
    ]);
    expect(out.content).toBe("[evidence ev_1]\nThe renewal date is March 4th.");
    expect(out.tool_call_id).toBe("call_1");
    expect(out.name).toBe("mail__search");
    expect(ToolMessage.isInstance(out)).toBe(true);
  });

  it("leaves the gated tool alone: the action under review is not its own evidence", async () => {
    const { wrap, recorded } = ledger({
      refsByToolName: new Map([["mail__send", "mcp:mail:send"]]),
    });
    const sent = result("sent", "mail__send");
    expect(await wrap(request("mail__send"), async () => sent)).toBe(sent);
    expect(recorded).toEqual([]);
  });

  it("ignores a tool that no ref names", async () => {
    const { wrap, recorded } = ledger();
    const out = result("ok", "write_file");
    expect(await wrap(request("write_file"), async () => out)).toBe(out);
    expect(recorded).toEqual([]);
  });

  it("does not record a failed call as evidence", async () => {
    const { wrap, recorded } = ledger();
    const failed = new ToolMessage({
      status: "error",
      content: "Error running tool",
      tool_call_id: "call_1",
      name: "mail__search",
    });
    expect(await wrap(request("mail__search"), async () => failed)).toBe(failed);
    expect(recorded).toEqual([]);
  });

  it("lets a thrown tool error propagate to the recovery wrapper", async () => {
    const { wrap, recorded } = ledger();
    await expect(
      wrap(request("mail__search"), async () => {
        throw new Error("upstream 500");
      }),
    ).rejects.toThrow("upstream 500");
    expect(recorded).toEqual([]);
  });

  it("passes the result through untouched when the ledger is full", async () => {
    const { wrap } = ledger({ recorder: async () => undefined });
    const out = result("body");
    expect(await wrap(request("mail__search"), async () => out)).toBe(out);
  });

  it("keeps the tool usable when the ledger write fails", async () => {
    const warnings: string[] = [];
    const { wrap } = ledger({
      recorder: async () => {
        throw new Error("disk full");
      },
      logger: { info: () => {}, warn: (m) => warnings.push(m), error: () => {}, debug: () => {} },
    });
    const out = result("body");
    expect(await wrap(request("mail__search"), async () => out)).toBe(out);
    expect(warnings[0]).toContain("disk full");
  });

  it("skips recording without a thread to scope the entry to", async () => {
    const { wrap, recorded } = ledger();
    const out = result("body");
    expect(await wrap(request("mail__search", {}, {}), async () => out)).toBe(out);
    expect(recorded).toEqual([]);
  });

  it("clips the output the model reads, so it can only quote what a reviewer can verify", async () => {
    const { wrap, recorded } = ledger({ maxBodyBytes: 8 });
    const out = (await wrap(request("mail__search"), async () =>
      result("0123456789"))) as ToolMessage;

    expect(recorded[0]?.body).toBe("01234567");
    expect(recorded[0]?.bytes).toBe(10);
    expect(recorded[0]?.truncated).toBe(true);
    expect(out.content).toBe("[evidence ev_1 — clipped to 262144 of 10 bytes]\n01234567");
  });

  it("prefixes a marker block when the result is structured content", async () => {
    const { wrap } = ledger();
    const structured = new ToolMessage({
      content: [{ type: "text", text: "a finding" }],
      tool_call_id: "call_1",
      name: "mail__search",
    });
    const out = (await wrap(request("mail__search"), async () => structured)) as ToolMessage;
    expect(out.content).toEqual([
      { type: "text", text: "[evidence ev_1]" },
      { type: "text", text: "a finding" },
    ]);
  });
});

describe("evidenceBreadcrumb", () => {
  it("names at most two scalar arguments", () => {
    expect(
      evidenceBreadcrumb("mcp:mail:search", { query: "q", folder: "Inbox", limit: 5 }),
    ).toBe("mcp:mail:search (query: q, folder: Inbox)");
  });

  it("truncates a long argument value", () => {
    const long = "x".repeat(80);
    expect(evidenceBreadcrumb("mcp:a:b", { q: long })).toBe(
      `mcp:a:b (q: ${"x".repeat(59)}…)`,
    );
  });

  it("falls back to the ref when nothing scalar identifies the call", () => {
    expect(evidenceBreadcrumb("mcp:a:b", { filter: { nested: true } })).toBe("mcp:a:b");
    expect(evidenceBreadcrumb("mcp:a:b", undefined)).toBe("mcp:a:b");
  });
});
