import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Hono } from "hono";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { configureLogging } from "@pizza-bot/logging";
import { logRoutes } from "./routes-logs.js";

const tempRoots: string[] = [];

function tempRoot(prefix: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  tempRoots.push(dir);
  return dir;
}

afterAll(() => {
  for (const dir of tempRoots) rmSync(dir, { recursive: true, force: true });
});

describe("log routes", () => {
  let app: Hono;

  beforeEach(() => {
    const root = tempRoot("pizza-log-routes-");
    configureLogging({
      dataRoot: root,
      processName: "api",
      console: false,
      knownSecrets: ["known-secret"],
    });
    app = new Hono();
    app.route("/", logRoutes(root));
  });

  it("accepts renderer batches and returns redacted filtered records", async () => {
    const accepted = await app.request("/logs/client", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        records: [
          {
            level: "error",
            component: "chat",
            message: "failed with Bearer raw-token and known-secret",
            context: { apiKey: "do-not-store", threadId: "t1" },
          },
          { level: "info", component: "theme", message: "loaded" },
        ],
      }),
    });
    expect(accepted.status).toBe(202);

    const response = await app.request("/logs?levels=error&components=chat");
    const body = await response.json() as { records: Array<Record<string, unknown>> };
    expect(body.records).toHaveLength(1);
    expect(body.records[0]).toMatchObject({
      level: "error",
      component: "chat",
      message: "failed with Bearer <redacted> and <redacted>",
      context: { apiKey: "<redacted>", threadId: "t1" },
    });
  });

  it("downloads newline-delimited structured records", async () => {
    await app.request("/logs/client", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ level: "warn", message: "diagnostic" }),
    });
    const response = await app.request("/logs/download?levels=warn");
    expect(response.headers.get("content-type")).toContain("application/x-ndjson");
    expect(response.headers.get("content-disposition")).toContain("pizza-bot-logs-");
    expect(JSON.parse((await response.text()).trim())).toMatchObject({
      level: "warn",
      message: "diagnostic",
    });
  });

  it("deletes log files from disk", async () => {
    await app.request("/logs/client", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ level: "info", message: "remove me" }),
    });

    const response = await app.request("/logs", { method: "DELETE" });
    expect(response.status).toBe(200);
    const body = await response.json() as { deleted: number };
    expect(body.deleted).toBeGreaterThan(0);

    const remaining = await app.request("/logs");
    expect(await remaining.json()).toMatchObject({ records: [] });
  });
});
