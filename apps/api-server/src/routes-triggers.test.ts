import { describe, it, expect, afterEach } from "vitest";
import { Hono } from "hono";
import type { RunHandle } from "@pizza-bot/core";
import { openAppDatabase, type AppDatabase, type TriggerStore } from "@pizza-bot/storage";
import { triggerRoutes } from "./routes-triggers.js";
import type { TriggerService } from "./trigger-service.js";

const apps: AppDatabase[] = [];
function memStore(): TriggerStore {
  const app = openAppDatabase(":memory:");
  apps.push(app);
  return app.triggers;
}
afterEach(() => {
  for (const app of apps.splice(0)) app.close();
});

function fakeService(store: TriggerStore) {
  const invoked: Array<{ id: string; body: unknown }> = [];
  const ran: string[] = [];
  let reloads = 0;
  const service = {
    reload() {
      reloads++;
      return true;
    },
    invokeWebhook(id: string, body: unknown): { handle: RunHandle } | undefined {
      const t = store.get(id);
      if (!t || t.kind !== "webhook" || !t.enabled) return undefined;
      invoked.push({ id, body });
      return { handle: { runId: "run_wh", threadId: "thread_wh", status: "running", startedAt: 0 } };
    },
    runNow(id: string): { handle: RunHandle } | undefined {
      const t = store.get(id);
      if (!t || !t.enabled) return undefined;
      ran.push(id);
      return { handle: { runId: "run_now", threadId: "thread_now", status: "running", startedAt: 0 } };
    },
  } as unknown as TriggerService;
  return { service, invoked, ran, reloads: () => reloads };
}

function appWith(store: TriggerStore, service?: TriggerService): Hono {
  const app = new Hono();
  app.route("/", triggerRoutes(store, service));
  return app;
}

describe("trigger routes: CRUD", () => {
  it("creates, lists, gets, patches, and deletes a trigger", async () => {
    const store = memStore();
    const app = appWith(store, fakeService(store).service);

    const created = await app.request("/triggers", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "t1", kind: "cron", cron: "0 9 * * *", prompt: "hi" }),
    });
    expect(created.status).toBe(201);
    expect(((await created.json()) as { id: string }).id).toBe("t1");

    const list = (await (await app.request("/triggers")).json()) as Array<{ id: string }>;
    expect(list.map((t) => t.id)).toEqual(["t1"]);

    const got = await app.request("/triggers/t1");
    expect(((await got.json()) as { cron: string }).cron).toBe("0 9 * * *");

    const patched = await app.request("/triggers/t1", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ enabled: false }),
    });
    expect(((await patched.json()) as { enabled: boolean }).enabled).toBe(false);

    const del = await app.request("/triggers/t1", { method: "DELETE" });
    expect(((await del.json()) as { deleted: boolean }).deleted).toBe(true);
    expect((await app.request("/triggers/t1")).status).toBe(404);
  });

  it("validates cron expressions and timezones before persistence or reload", async () => {
    const store = memStore();
    const fake = fakeService(store);
    const app = appWith(store, fake.service);
    const invalidCron = await app.request("/triggers", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "bad", kind: "cron", cron: "not a cron", prompt: "run" }),
    });
    expect(invalidCron.status).toBe(400);
    expect(store.get("bad")).toBeUndefined();
    expect(fake.reloads()).toBe(0);

    const invalidTimezone = await app.request("/triggers", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        id: "bad-tz",
        kind: "cron",

        cron: "0 9 * * *",
        prompt: "run",
        timezone: "Mars/Olympus",
      }),
    });
    expect(invalidTimezone.status).toBe(400);
    expect(store.get("bad-tz")).toBeUndefined();
    expect(fake.reloads()).toBe(0);

    const weakWebhookSecret = await app.request("/triggers", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        id: "weak-webhook",
        kind: "webhook",

        webhookSecret: "short",
      }),
    });
    expect(weakWebhookSecret.status).toBe(400);
    expect(store.get("weak-webhook")).toBeUndefined();
  });

  it("requires a non-empty seed prompt for cron triggers", async () => {
    const store = memStore();
    const fake = fakeService(store);
    const app = appWith(store, fake.service);

    for (const [id, prompt] of [["missing", undefined], ["blank", "   "]] as const) {
      const response = await app.request("/triggers", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id, kind: "cron", cron: "0 9 * * *", prompt }),
      });
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({
        error: "invalid",
        detail: "prompt is required for cron triggers",
      });
      expect(store.get(id)).toBeUndefined();
    }
    expect(fake.reloads()).toBe(0);
  });

  it("rejects clearing the seed prompt from an existing cron trigger", async () => {
    const store = memStore();
    store.create({
      id: "t",
      kind: "cron",
      enabled: true,
      cron: "0 9 * * *",
      prompt: "daily digest",
    });
    const fake = fakeService(store);
    const app = appWith(store, fake.service);

    const response = await app.request("/triggers/t", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt: " " }),
    });
    expect(response.status).toBe(400);
    expect(store.get("t")?.prompt).toBe("daily digest");
    expect(fake.reloads()).toBe(0);
  });

  it("rejects an invalid patch without changing the stored schedule", async () => {
    const store = memStore();
    store.create({
      id: "t",
      kind: "cron",

      enabled: true,
      cron: "0 9 * * *",
      timezone: "America/Los_Angeles",
    });
    const fake = fakeService(store);
    const app = appWith(store, fake.service);
    const response = await app.request("/triggers/t", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ timezone: "invalid/timezone" }),
    });
    expect(response.status).toBe(400);
    expect(store.get("t")?.timezone).toBe("America/Los_Angeles");
    expect(fake.reloads()).toBe(0);
  });
});

describe("trigger routes: webhook invoke", () => {
  function seedWebhook(store: TriggerStore) {
    store.create({ id: "wh", kind: "webhook", enabled: true, webhookSecret: "topsecret" });
  }

  it("rejects a missing secret with 401 and does not start a run", async () => {
    const store = memStore();
    seedWebhook(store);
    const { service, invoked } = fakeService(store);
    const app = appWith(store, service);

    const res = await app.request("/triggers/wh/invoke", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt: "go" }),
    });
    expect(res.status).toBe(401);
    expect(invoked).toHaveLength(0);
  });

  it("rejects a wrong secret with 401", async () => {
    const store = memStore();
    seedWebhook(store);
    const { service, invoked } = fakeService(store);
    const app = appWith(store, service);

    const res = await app.request("/triggers/wh/invoke", {
      method: "POST",
      headers: { authorization: "Bearer nope" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(401);
    expect(invoked).toHaveLength(0);
  });

  it("starts a run on the correct Bearer secret", async () => {
    const store = memStore();
    seedWebhook(store);
    const { service, invoked } = fakeService(store);
    const app = appWith(store, service);

    const res = await app.request("/triggers/wh/invoke", {
      method: "POST",
      headers: { authorization: "Bearer topsecret", "content-type": "application/json" },
      body: JSON.stringify({ prompt: "go now" }),
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { run_id: string };
    expect(json.run_id).toBe("run_wh");
    expect(invoked).toHaveLength(1);
    expect(invoked[0]!.body).toEqual({ prompt: "go now" });
  });

  it("never returns a webhook secret from CRUD responses", async () => {
    const store = memStore();
    const app = appWith(store, fakeService(store).service);
    const created = await app.request("/triggers", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        id: "redacted",
        kind: "webhook",

        webhookSecret: "topsecret-123456",
      }),
    });
    expect(created.status).toBe(201);
    const body = (await created.json()) as Record<string, unknown>;
    expect(body.webhookSecret).toBeUndefined();
    expect(body.hasWebhookSecret).toBe(true);

    const fetched = (await (await app.request("/triggers/redacted")).json()) as Record<
      string,
      unknown
    >;
    expect(fetched.webhookSecret).toBeUndefined();
    expect(fetched.hasWebhookSecret).toBe(true);
  });

  it("also accepts the X-Trigger-Secret header", async () => {
    const store = memStore();
    seedWebhook(store);
    const { service, invoked } = fakeService(store);
    const app = appWith(store, service);

    const res = await app.request("/triggers/wh/invoke", {
      method: "POST",
      headers: { "x-trigger-secret": "topsecret", "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(200);
    expect(invoked).toHaveLength(1);
  });

  it("404s invoking a non-webhook trigger", async () => {
    const store = memStore();
    store.create({ id: "c", kind: "cron", enabled: true, cron: "0 * * * *" });
    const { service } = fakeService(store);
    const app = appWith(store, service);
    const res = await app.request("/triggers/c/invoke", { method: "POST", body: "{}" });
    expect(res.status).toBe(404);
  });
});

describe("trigger routes: run now (manual)", () => {
  it("runs an enabled cron trigger without a secret and returns the run ids", async () => {
    const store = memStore();
    store.create({ id: "c", kind: "cron", enabled: true, cron: "0 9 * * *" });
    const { service, ran } = fakeService(store);
    const app = appWith(store, service);

    const res = await app.request("/triggers/c/run", { method: "POST" });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { run_id: string; thread_id: string };
    expect(json.run_id).toBe("run_now");
    expect(json.thread_id).toBe("thread_now");
    expect(ran).toEqual(["c"]);
  });

  it("404s an unknown trigger", async () => {
    const store = memStore();
    const { service } = fakeService(store);
    const app = appWith(store, service);
    const res = await app.request("/triggers/nope/run", { method: "POST" });
    expect(res.status).toBe(404);
  });

  it("409s a disabled trigger and does not run it", async () => {
    const store = memStore();
    store.create({ id: "c", kind: "cron", enabled: false, cron: "0 9 * * *" });
    const { service, ran } = fakeService(store);
    const app = appWith(store, service);
    const res = await app.request("/triggers/c/run", { method: "POST" });
    expect(res.status).toBe(409);
    expect(ran).toHaveLength(0);
  });
});
