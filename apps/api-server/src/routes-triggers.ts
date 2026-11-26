import { Hono } from "hono";
import { CronTime } from "cron";
import { z } from "zod";
import { GRAPH_ID_PATTERN, type TriggerDef } from "@pizza-bot/core";
import type { TriggerStore } from "@pizza-bot/storage";
import type { TriggerService } from "./trigger-service.js";
import { RESOURCE_ID_RE as ID_RE } from "./resource-crud.js";

let triggerCounter = 0;
const newTriggerId = () => `trg_${Date.now().toString(36)}_${triggerCounter++}`;

const triggerFieldsSchema = z.object({
  kind: z.enum(["cron", "webhook"]),
  enabled: z.boolean(),
  name: z.string().max(80).optional(),
  prompt: z.string().optional(),
  // An empty string clears the graph target, returning the trigger to its prompt.
  graphId: z.union([z.string().regex(GRAPH_ID_PATTERN), z.literal("")]).optional(),
  cron: z.string().trim().min(1).optional(),
  timezone: z.string().trim().min(1).optional(),
  webhookSecret: z.string().min(16).optional(),
});

const triggerCreateSchema = triggerFieldsSchema.extend({
  id: z
    .string()
    .regex(ID_RE)
    .refine((id) => !id.startsWith("todo_"), "ids starting with todo_ are reserved for Todo check-ins")
    .optional(),
});

const triggerPatchSchema = triggerFieldsSchema.partial().strict();

async function unknownGraph(
  graphId: string | undefined,
  graphExists: ((graphId: string) => Promise<boolean>) | undefined,
): Promise<string | undefined> {
  if (!graphId || !graphExists) return undefined;
  return (await graphExists(graphId)) ? undefined : `graph ${graphId} does not exist`;
}

function presentedSecret(auth: string | undefined, header: string | undefined): string | undefined {
  if (header) return header;
  if (auth?.startsWith("Bearer ")) return auth.slice("Bearer ".length);
  return undefined;
}

function validateTrigger(
  def: Omit<TriggerDef, "createdAt">,
  defaultTimezone: string,
): string | undefined {
  if (def.kind === "cron") {
    if (!def.cron) return "cron is required for cron triggers";
    if (!def.graphId && !def.prompt?.trim()) return "prompt is required for cron triggers";
    try {
      new CronTime(def.cron, def.timezone ?? defaultTimezone);
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  }
  if (def.timezone) {
    try {
      new Intl.DateTimeFormat("en-US", { timeZone: def.timezone }).format();
    } catch {
      return `invalid timezone: ${def.timezone}`;
    }
  }
  if (def.kind === "webhook" && !def.webhookSecret && !def.hasWebhookSecret) {
    return "webhookSecret is required for webhook triggers";
  }
  return undefined;
}

export function triggerRoutes(
  store: TriggerStore,
  service?: TriggerService,
  graphExists?: (graphId: string) => Promise<boolean>,
): Hono {
  const app = new Hono();
  const defaultTimezone = Intl.DateTimeFormat().resolvedOptions().timeZone;

  // A Todo's check-in schedule is managed from the Todo, so this surface does not show it.
  const scheduleOf = (id: string) => {
    const trigger = store.get(id);
    return trigger && !trigger.todoId ? trigger : undefined;
  };

  app.get("/triggers", (c) => c.json(store.list().filter((trigger) => !trigger.todoId)));

  app.post("/triggers", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const parsed = triggerCreateSchema.safeParse({
      kind: "cron",
      enabled: true,
      ...(body && typeof body === "object" ? body : {}),
    });
    if (!parsed.success) {
      return c.json({ error: "invalid", detail: parsed.error.message }, 400);
    }
    const data = parsed.data;
    const def: Omit<TriggerDef, "createdAt"> = {
      id: parsed.data.id ?? newTriggerId(),
      kind: data.kind,
      enabled: data.enabled,
      ...(data.name !== undefined ? { name: data.name } : {}),
      ...(data.prompt !== undefined ? { prompt: data.prompt } : {}),
      ...(data.graphId ? { graphId: data.graphId } : {}),
      ...(data.cron !== undefined ? { cron: data.cron } : {}),
      ...(data.timezone !== undefined ? { timezone: data.timezone } : {}),
      ...(data.webhookSecret !== undefined ? { webhookSecret: data.webhookSecret } : {}),
    };
    const invalid =
      validateTrigger(def, defaultTimezone) ?? (await unknownGraph(def.graphId, graphExists));
    if (invalid) return c.json({ error: "invalid", detail: invalid }, 400);
    const created = store.create(def);
    service?.reload?.();
    return c.json(created, 201);
  });

  app.get("/triggers/:id", (c) => {
    const t = scheduleOf(c.req.param("id"));
    return t ? c.json(t) : c.json({ error: "not_found" }, 404);
  });

  app.patch("/triggers/:id", async (c) => {
    const id = c.req.param("id");
    const existing = scheduleOf(id);
    if (!existing) return c.json({ error: "not_found" }, 404);
    const parsed = triggerPatchSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) {
      return c.json({ error: "invalid", detail: parsed.error.message }, 400);
    }
    const data = parsed.data;
    const patch: Partial<Omit<TriggerDef, "id" | "createdAt">> = {
      ...(data.kind !== undefined ? { kind: data.kind } : {}),
      ...(data.enabled !== undefined ? { enabled: data.enabled } : {}),
      ...(data.name !== undefined ? { name: data.name } : {}),
      ...(data.prompt !== undefined ? { prompt: data.prompt } : {}),
      ...(data.graphId !== undefined ? { graphId: data.graphId } : {}),
      ...(data.cron !== undefined ? { cron: data.cron } : {}),
      ...(data.timezone !== undefined ? { timezone: data.timezone } : {}),
      ...(data.webhookSecret !== undefined ? { webhookSecret: data.webhookSecret } : {}),
    };
    const merged: TriggerDef = { ...existing, ...patch, id, createdAt: existing.createdAt };
    if (merged.graphId === "") delete merged.graphId;
    const invalid =
      validateTrigger(merged, defaultTimezone) ??
      (data.graphId ? await unknownGraph(data.graphId, graphExists) : undefined);
    if (invalid) return c.json({ error: "invalid", detail: invalid }, 400);
    const updated = store.update(id, patch);
    if (!updated) return c.json({ error: "not_found" }, 404);
    service?.reload?.();
    return c.json(updated);
  });

  app.delete("/triggers/:id", (c) => {
    const ok = scheduleOf(c.req.param("id")) !== undefined && store.delete(c.req.param("id"));
    if (!ok) return c.json({ error: "not_found" }, 404);
    service?.reload?.();
    return c.json({ deleted: true });
  });

  app.post("/triggers/:id/invoke", async (c) => {
    // This inbound endpoint authenticates before parsing a body or launching work.
    const id = c.req.param("id");
    const t = store.get(id);
    if (!t || t.kind !== "webhook") return c.json({ error: "not_found" }, 404);
    if (!t.enabled) return c.json({ error: "disabled" }, 409);

    const presented = presentedSecret(c.req.header("authorization"), c.req.header("x-trigger-secret"));
    if (!store.verifyWebhookSecret(id, presented)) {
      return c.json({ error: "unauthorized" }, 401);
    }
    if (!service) return c.json({ error: "no_service" }, 503);

    const body = await c.req.json().catch(() => ({}));
    const result = service.invokeWebhook(id, body);
    if (!result) return c.json({ error: "not_invokable" }, 409);
    return c.json({ run_id: result.handle.runId, thread_id: result.handle.threadId, status: result.handle.status });
  });

  app.post("/triggers/:id/run", (c) => {
    // Manual execution belongs to the deployment-trusted CRUD surface and does
    // not accept the public webhook credential.
    const id = c.req.param("id");
    const t = scheduleOf(id);
    if (!t) return c.json({ error: "not_found" }, 404);
    if (!t.enabled) return c.json({ error: "disabled" }, 409);
    if (!service) return c.json({ error: "no_service" }, 503);

    const result = service.runNow(id);
    if (!result) return c.json({ error: "not_runnable" }, 409);
    return c.json({ run_id: result.handle.runId, thread_id: result.handle.threadId, status: result.handle.status });
  });

  return app;
}
