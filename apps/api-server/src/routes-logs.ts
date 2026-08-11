import path from "node:path";
import { Hono } from "hono";
import {
  deleteLogFiles,
  getLogger,
  queryLogFiles,
  type LogLevel,
  type LogQuery,
} from "@pizza-bot/logging";

const LEVELS = new Set<LogLevel>(["debug", "info", "warn", "error"]);
const clientLog = getLogger("renderer");

export function logRoutes(dataRoot: string): Hono {
  const app = new Hono();
  const logsDir = path.join(dataRoot, "logs");

  app.get("/logs", (c) => {
    const query = queryFromUrl(c.req.query());
    return c.json(queryLogFiles(logsDir, query));
  });

  app.get("/logs/download", (c) => {
    const result = queryLogFiles(logsDir, { ...queryFromUrl(c.req.query()), limit: 5_000 });
    const content = result.records.map((record) => JSON.stringify(record)).join("\n");
    const day = new Date().toISOString().slice(0, 10);
    c.header("Content-Type", "application/x-ndjson; charset=utf-8");
    c.header("Content-Disposition", `attachment; filename="pizza-bot-logs-${day}.ndjson"`);
    return c.body(content ? `${content}\n` : "");
  });

  app.delete("/logs", (c) => {
    return c.json({ deleted: deleteLogFiles(logsDir) });
  });

  app.post("/logs/client", async (c) => {
    const body = await c.req.json().catch(() => undefined);
    if (!body || typeof body !== "object") {
      return c.json({ error: "invalid_log_record" }, 400);
    }
    const wrapper = body as Record<string, unknown>;
    const records = Array.isArray(wrapper.records) ? wrapper.records.slice(0, 100) : [body];
    for (const candidate of records) writeClientRecord(candidate);
    return c.json({ accepted: true }, 202);
  });

  function writeClientRecord(candidate: unknown): void {
    if (!candidate || typeof candidate !== "object") return;
    const value = candidate as Record<string, unknown>;
    const level = isLevel(value.level) ? value.level : "info";
    const message = typeof value.message === "string" ? value.message : "Renderer event";
    const component = typeof value.component === "string" ? value.component : "browser";
    const context =
      value.context && typeof value.context === "object"
        ? (value.context as Record<string, unknown>)
        : undefined;
    const logger = clientLog.child({ component });
    if (level === "error") logger.error(message, value.error, context);
    else logger[level](message, context);
  }

  return app;
}

function queryFromUrl(query: Record<string, string>): LogQuery {
  const levels = split(query.levels).filter(isLevel);
  const processes = split(query.processes);
  const components = split(query.components);
  const parsedLimit = Number(query.limit);
  return {
    ...(levels.length ? { levels } : {}),
    ...(processes.length ? { processes } : {}),
    ...(components.length ? { components } : {}),
    ...(query.search ? { search: query.search } : {}),
    ...(validDate(query.since) ? { since: query.since } : {}),
    ...(validDate(query.until) ? { until: query.until } : {}),
    ...(Number.isFinite(parsedLimit) ? { limit: parsedLimit } : {}),
  };
}

function split(value: string | undefined): string[] {
  return value?.split(",").map((part) => part.trim()).filter(Boolean) ?? [];
}

function isLevel(value: unknown): value is LogLevel {
  return typeof value === "string" && LEVELS.has(value as LogLevel);
}

function validDate(value: string | undefined): value is string {
  return value !== undefined && Number.isFinite(Date.parse(value));
}
