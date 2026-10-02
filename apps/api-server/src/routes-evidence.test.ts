import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildApp } from "./index.js";
import { AgentHost } from "./agent-host.js";
import type { ApprovalVerdict, EvidenceEntry } from "@pizza-bot/core";
import type { AppendApprovalVerdict } from "@pizza-bot/storage";

describe("evidence routes: GET /threads/:id/evidence, GET /evidence/:id", () => {
  let dataRoot: string;
  let pluginsDir: string;
  let host: AgentHost;
  let app: ReturnType<typeof buildApp>;

  beforeEach(async () => {
    dataRoot = mkdtempSync(join(tmpdir(), "route-evidence-data-"));
    pluginsDir = mkdtempSync(join(tmpdir(), "route-evidence-plugins-"));
    host = await AgentHost.create({ dataRoot, pluginsDir });
    app = buildApp(host);
  });

  afterEach(async () => {
    await host.close();
    for (const d of [dataRoot, pluginsDir]) rmSync(d, { recursive: true, force: true });
  });

  const record = (threadId: string, body: string) =>
    host.evidence!.record({
      threadId,
      runId: "run_1",
      toolRef: "mcp:mail:search",
      breadcrumb: "mcp:mail:search (query: renewal)",
      body,
      bytes: body.length,
      truncated: false,
    })!;

  it("lists only the requested thread's evidence, without bodies", async () => {
    const mine = record("t1", "The renewal date is March 4th.");
    record("t2", "unrelated");

    const res = await app.request("/threads/t1/evidence");
    expect(res.status).toBe(200);
    const { evidence } = (await res.json()) as { evidence: EvidenceEntry[] };
    expect(evidence).toHaveLength(1);
    expect(evidence[0]?.id).toBe(mine.id);
    expect(evidence[0]?.breadcrumb).toBe("mcp:mail:search (query: renewal)");
    expect(evidence[0]).not.toHaveProperty("body");
  });

  it("returns an empty list for a thread that gathered nothing", async () => {
    const res = await app.request("/threads/unknown/evidence");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ evidence: [] });
  });

  it("serves the body a citation audit resolves quotes against", async () => {
    const entry = record("t1", "The renewal date is March 4th.");
    const res = await app.request(`/evidence/${entry.id}`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ...entry, body: "The renewal date is March 4th." });
  });

  it("404s an unknown id", async () => {
    const res = await app.request("/evidence/ev_missing");
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "not_found" });
  });

  it("exposes no write route: evidence is recorded only server-side", async () => {
    const entry = record("t1", "body");
    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
      const res = await app.request(`/evidence/${entry.id}`, { method });
      expect(res.status).toBe(404);
    }
    expect(host.evidence!.get(entry.id)).toBeDefined();
  });

  it("drops a deleted thread's evidence", async () => {
    const entry = record("t1", "body");
    await host.deleteThread("t1");
    expect((await app.request(`/evidence/${entry.id}`)).status).toBe(404);
    expect(await (await app.request("/threads/t1/evidence")).json()).toEqual({ evidence: [] });
  });

  describe("GET /threads/:id/approval-verdicts", () => {
    const verdict = (threadId: string, overrides: Partial<AppendApprovalVerdict> = {}) =>
      host.approvalVerdicts.append({
        verdictId: `vd_${threadId}_${overrides.interruptId ?? "1"}`,
        threadId,
        runId: "run_1",
        interruptId: "call_1",
        toolName: "billing__send_reply",
        decision: "approve",
        spans: [
          { arg: "body", text: "Renewal: 4 March 2027", evidenceId: "ev_1", tier: "verifiable" },
        ],
        ...overrides,
      }).verdict;

    it("serves the stored tiers for one thread, oldest first", async () => {
      verdict("t1");
      verdict("t1", { interruptId: "call_2", decision: "edit" });
      verdict("t2");

      const res = await app.request("/threads/t1/approval-verdicts");
      expect(res.status).toBe(200);
      const { verdicts } = (await res.json()) as { verdicts: ApprovalVerdict[] };
      expect(verdicts.map((v) => v.decision)).toEqual(["approve", "edit"]);
      expect(verdicts[0]?.spans[0]).toMatchObject({ text: "Renewal: 4 March 2027", tier: "verifiable" });
    });

    it("returns an empty list for a thread that approved nothing", async () => {
      const res = await app.request("/threads/unknown/approval-verdicts");
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ verdicts: [] });
    });

    it("exposes no write route: only an approval decision records a verdict", async () => {
      for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
        const res = await app.request("/threads/t1/approval-verdicts", { method });
        expect(res.status).toBe(404);
      }
    });

    it("drops a deleted thread's verdicts", async () => {
      verdict("t1");
      await host.deleteThread("t1");
      expect(await (await app.request("/threads/t1/approval-verdicts")).json()).toEqual({
        verdicts: [],
      });
    });
  });
});
