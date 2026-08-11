import { Hono } from "hono";
import { mkdir, readdir, readFile, writeFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import type { AgentHost } from "./agent-host.js";
import { RESOURCE_ID_RE as ID_RE } from "./resource-crud.js";

const fileFor = (id: string): string => `${id}.md`;

export interface MemoryInfo {
  id: string;
  preview: string;
  size: number;
  updatedAt: string;
}

export interface MemoryDoc {
  id: string;
  content: string;
  updatedAt?: string;
}

function previewOf(content: string): string {
  for (const raw of content.split("\n")) {
    const line = raw.replace(/^#+\s*/, "").trim();
    if (line) return line.length > 120 ? `${line.slice(0, 117)}…` : line;
  }
  return "";
}

async function readInfo(dir: string, id: string): Promise<MemoryInfo | null> {
  try {
    const [content, st] = await Promise.all([readFile(join(dir, fileFor(id)), "utf8"), stat(join(dir, fileFor(id)))]);
    return { id, preview: previewOf(content), size: st.size, updatedAt: st.mtime.toISOString() };
  } catch {
    return null;
  }
}

export function memoryRoutes(host: AgentHost): Hono {
  const app = new Hono();

  app.get("/memories", async (c) => {
    const dir = await host.memoriesDirectory();
    if (!dir) return c.json({ memories: [] });
    const names = await readdir(dir).catch(() => [] as string[]);
    const ids = names.filter((n) => n.endsWith(".md")).map((n) => n.slice(0, -3));
    const infos = (await Promise.all(ids.map((id) => readInfo(dir, id)))).filter((m): m is MemoryInfo => m !== null);
    infos.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    return c.json({ memories: infos });
  });

  app.get("/memories/:id", async (c) => {
    const dir = await host.memoriesDirectory();
    if (!dir) return c.json({ error: "memories_disabled" }, 409);
    const id = c.req.param("id");
    if (!ID_RE.test(id)) return c.json({ error: "invalid_id" }, 400);
    try {
      const [content, st] = await Promise.all([readFile(join(dir, fileFor(id)), "utf8"), stat(join(dir, fileFor(id)))]);
      return c.json({ id, content, updatedAt: st.mtime.toISOString() } satisfies MemoryDoc);
    } catch {
      return c.json({ error: "not_found" }, 404);
    }
  });

  app.post("/memories", async (c) => {
    const dir = await host.memoriesDirectory();
    if (!dir) return c.json({ error: "memories_disabled" }, 409);
    const raw = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const id = typeof raw.id === "string" ? raw.id.trim() : "";
    if (!ID_RE.test(id)) return c.json({ error: "invalid_id" }, 400);
    const content = typeof raw.content === "string" ? raw.content : "";
    const exists = await stat(join(dir, fileFor(id))).then(() => true).catch(() => false);
    if (exists) return c.json({ error: "already_exists" }, 409);

    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, fileFor(id)), content, "utf8");
    const st = await stat(join(dir, fileFor(id)));
    return c.json({ id, content, updatedAt: st.mtime.toISOString() } satisfies MemoryDoc, 201);
  });

  app.put("/memories/:id", async (c) => {
    const dir = await host.memoriesDirectory();
    if (!dir) return c.json({ error: "memories_disabled" }, 409);
    const id = c.req.param("id");
    if (!ID_RE.test(id)) return c.json({ error: "invalid_id" }, 400);
    const raw = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const content = typeof raw.content === "string" ? raw.content : "";

    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, fileFor(id)), content, "utf8");
    const st = await stat(join(dir, fileFor(id)));
    return c.json({ id, content, updatedAt: st.mtime.toISOString() } satisfies MemoryDoc);
  });

  app.delete("/memories/:id", async (c) => {
    const dir = await host.memoriesDirectory();
    if (!dir) return c.json({ error: "memories_disabled" }, 409);
    const id = c.req.param("id");
    if (!ID_RE.test(id)) return c.json({ error: "invalid_id" }, 400);
    await rm(join(dir, fileFor(id)), { force: true });
    return c.json({ deleted: true });
  });

  return app;
}
