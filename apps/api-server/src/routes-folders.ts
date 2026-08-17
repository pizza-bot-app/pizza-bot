import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import type { AgentHost } from "./agent-host.js";

const MAX_FOLDER_NAME_LENGTH = 80;

export function folderRoutes(host: AgentHost): Hono {
  const app = new Hono();

  app.get("/folders", (c) => c.json(host.folderStore.list()));

  app.post("/folders", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { name?: unknown };
    const name = validName(body.name);
    if (!name) {
      return c.json(
        { error: `name must contain 1-${MAX_FOLDER_NAME_LENGTH} characters` },
        400,
      );
    }
    try {
      return c.json(host.folderStore.create({ folderId: randomUUID(), name }), 201);
    } catch (error) {
      if (isUniqueConstraint(error)) {
        return c.json({ error: "a folder with that name already exists" }, 409);
      }
      throw error;
    }
  });

  app.patch("/folders/:folder_id", async (c) => {
    const folderId = c.req.param("folder_id");
    const body = (await c.req.json().catch(() => ({}))) as {
      name?: unknown;
      sortOrder?: unknown;
    };
    const patch: { name?: string; sortOrder?: number } = {};
    if ("name" in body) {
      const name = validName(body.name);
      if (!name) {
        return c.json(
          { error: `name must contain 1-${MAX_FOLDER_NAME_LENGTH} characters` },
          400,
        );
      }
      patch.name = name;
    }
    if ("sortOrder" in body) {
      if (
        typeof body.sortOrder !== "number" ||
        !Number.isSafeInteger(body.sortOrder) ||
        body.sortOrder < 0
      ) {
        return c.json({ error: "sortOrder must be a non-negative integer" }, 400);
      }
      patch.sortOrder = body.sortOrder;
    }
    try {
      const folder = host.folderStore.update(folderId, patch);
      if (!folder) return c.json({ error: "folder not found" }, 404);
      return c.json(folder);
    } catch (error) {
      if (isUniqueConstraint(error)) {
        return c.json({ error: "a folder with that name already exists" }, 409);
      }
      throw error;
    }
  });

  app.delete("/folders/:folder_id", (c) =>
    c.json({ deleted: host.folderStore.delete(c.req.param("folder_id")) }),
  );

  return app;
}

function validName(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const name = value.trim();
  return name.length > 0 && name.length <= MAX_FOLDER_NAME_LENGTH ? name : undefined;
}

function isUniqueConstraint(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as Error & { code?: string }).code === "SQLITE_CONSTRAINT_UNIQUE"
  );
}
