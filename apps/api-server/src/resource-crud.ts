import { Hono } from "hono";

// File-backed resource ids become single path segments; reject separators and traversal.
export const RESOURCE_ID_RE = /^[a-z0-9][a-z0-9_-]*$/i;

type ParseOk<P> = { ok: true } & P;
export type ParseResult<P> = ParseOk<P> | { ok: false; detail: string };

/**
 * The create/update/delete guard ladder shared verbatim by the skills and MCP
 * routes: a disabled→409 container gate, then id/parse/exists/reserved checks in
 * a fixed order, then write→reload→re-read. `container` resolves the backing
 * store (null = disabled); every other hook is a per-resource closure. GET routes
 * differ per resource, so callers add them to the returned app.
 */
export interface FileResourceConfig<C, P extends object> {
  base: string;
  disabledError: string;
  container: () => Promise<C | null>;
  parse: (raw: unknown) => ParseResult<P>;
  exists: (container: C, id: string) => Promise<boolean> | boolean;
  /** Allows PATCH to create an override for an existing read-only resource. */
  patchable?: (container: C, id: string) => Promise<boolean> | boolean;
  reserved?: (container: C, id: string, parsed: ParseOk<P>) => Promise<boolean> | boolean;
  writeConflict?: (
    container: C,
    id: string,
    parsed: ParseOk<P>,
  ) => Promise<Record<string, unknown> | undefined> | Record<string, unknown> | undefined;
  removeConflict?: (
    container: C,
    id: string,
  ) => Promise<Record<string, unknown> | undefined> | Record<string, unknown> | undefined;
  write: (container: C, id: string, parsed: ParseOk<P>) => Promise<void>;
  remove: (container: C, id: string) => Promise<void>;
  reload: () => Promise<void>;
  present: (id: string, parsed: ParseOk<P>) => Promise<unknown> | unknown;
}

export function fileResourceRoutes<C, P extends object>(cfg: FileResourceConfig<C, P>): Hono {
  const app = new Hono();

  app.post(cfg.base, async (c) => {
    const container = await cfg.container();
    if (!container) return c.json({ error: cfg.disabledError }, 409);

    const raw = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const id = typeof raw.id === "string" ? raw.id.trim() : "";
    if (!RESOURCE_ID_RE.test(id)) return c.json({ error: "invalid_id" }, 400);
    const parsed = cfg.parse(raw);
    if (!parsed.ok) return c.json({ error: "invalid", detail: parsed.detail }, 400);

    if (await cfg.exists(container, id)) return c.json({ error: "already_exists" }, 409);
    if (cfg.reserved && (await cfg.reserved(container, id, parsed))) {
      return c.json({ error: "reserved_id" }, 409);
    }
    const conflict = await cfg.writeConflict?.(container, id, parsed);
    if (conflict) return c.json(conflict, 409);

    await cfg.write(container, id, parsed);
    await cfg.reload();
    return c.json(await cfg.present(id, parsed), 201);
  });

  app.patch(`${cfg.base}/:id`, async (c) => {
    const container = await cfg.container();
    if (!container) return c.json({ error: cfg.disabledError }, 409);

    const id = c.req.param("id");
    if (!RESOURCE_ID_RE.test(id)) return c.json({ error: "invalid_id" }, 400);
    const exists = await cfg.exists(container, id);
    if (!exists && !(cfg.patchable && (await cfg.patchable(container, id)))) {
      return c.json({ error: "not_editable" }, 409);
    }

    const parsed = cfg.parse(await c.req.json().catch(() => ({})));
    if (!parsed.ok) return c.json({ error: "invalid", detail: parsed.detail }, 400);
    const conflict = await cfg.writeConflict?.(container, id, parsed);
    if (conflict) return c.json(conflict, 409);

    await cfg.write(container, id, parsed);
    await cfg.reload();
    return c.json(await cfg.present(id, parsed));
  });

  app.delete(`${cfg.base}/:id`, async (c) => {
    const container = await cfg.container();
    if (!container) return c.json({ error: cfg.disabledError }, 409);

    const id = c.req.param("id");
    if (!RESOURCE_ID_RE.test(id)) return c.json({ error: "invalid_id" }, 400);
    if (!(await cfg.exists(container, id))) return c.json({ error: "not_deletable" }, 409);
    const conflict = await cfg.removeConflict?.(container, id);
    if (conflict) return c.json(conflict, 409);

    await cfg.remove(container, id);
    await cfg.reload();
    return c.json({ deleted: true });
  });

  return app;
}
