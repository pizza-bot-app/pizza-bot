import { pathToFileURL } from "node:url";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { isIP } from "node:net";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { PROTOCOL_VERSION } from "@pizza-bot/core";
import { loadDotEnv, resolveDataRoot } from "./load-env.js";
import { AgentHost } from "./agent-host.js";
import { langGraphRoutes } from "./routes-langgraph.js";
import { triggerRoutes } from "./routes-triggers.js";
import {
  MAX_SKILL_JSON_BODY_BYTES,
  skillRoutes,
} from "./routes-skills.js";
import { mcpRoutes } from "./routes-mcp.js";
import { memoryRoutes } from "./routes-memories.js";
import { settingsRoutes } from "./routes-settings.js";
import { lifecycleRoutes } from "./routes-lifecycle.js";
import { providerRoutes } from "./routes-providers.js";
import { threadRoutes } from "./routes-threads.js";
import { pluginRoutes } from "./routes-plugins.js";
import { statusRoutes } from "./routes-status.js";
import { toolsRoutes } from "./routes-tools.js";
import { protocolRoutes } from "./routes-protocol.js";
import { attachmentRoutes } from "./routes-attachments.js";
import { folderRoutes } from "./routes-folders.js";
import { logRoutes } from "./routes-logs.js";
import { limitJsonBody, MAX_JSON_BODY_BYTES } from "./request-limits.js";
import {
  configureLogging,
  getLogger,
  installConsoleCapture,
  installProcessErrorHandlers,
  withLogContext,
} from "@pizza-bot/logging";
import {
  applySidecarSecretUpdate,
  isSidecarSecretUpdate,
  type SidecarSecretUpdateResult,
} from "./sidecar-ipc.js";

export const API_VERSION = String(PROTOCOL_VERSION);

const LOCAL_ORIGINS = ["http://localhost:5173", "http://127.0.0.1:5173"];
const MIN_REMOTE_TOKEN_LENGTH = 32;

export interface ApiSecurityOptions {
  allowedOrigins?: string[];
  apiToken?: string;
}

export interface ApiLoggingOptions {
  dataRoot?: string;
}

export interface ServerNetworkConfig extends ApiSecurityOptions {
  hostname: string;
}

export function resolveServerNetworkConfig(
  env: NodeJS.ProcessEnv = process.env,
): ServerNetworkConfig {
  const hostname = env.PIZZA_HOST?.trim() || "127.0.0.1";
  const configuredOrigins = parseOrigins(env.PIZZA_ALLOWED_ORIGINS);
  const apiToken = env.PIZZA_API_TOKEN?.trim() || undefined;
  if (!isLoopbackHost(hostname)) {
    if (!apiToken) {
      throw new Error("Refusing non-loopback PIZZA_HOST without PIZZA_API_TOKEN");
    }
    if (apiToken.length < MIN_REMOTE_TOKEN_LENGTH) {
      throw new Error(
        `Refusing non-loopback PIZZA_HOST with PIZZA_API_TOKEN shorter than ${MIN_REMOTE_TOKEN_LENGTH} characters`,
      );
    }
    if (configuredOrigins.length === 0) {
      throw new Error("Refusing non-loopback PIZZA_HOST without PIZZA_ALLOWED_ORIGINS");
    }
  }
  return {
    hostname,
    allowedOrigins: configuredOrigins.length > 0 ? configuredOrigins : LOCAL_ORIGINS,
    ...(apiToken ? { apiToken } : {}),
  };
}

export function buildApp(
  host: AgentHost,
  security: ApiSecurityOptions = {},
  logging: ApiLoggingOptions = {},
): Hono {
  const app = new Hono();
  const httpLog = getLogger("http");
  const allowedOrigins = security.allowedOrigins ?? LOCAL_ORIGINS;
  const allowedOriginSet = new Set(allowedOrigins);
  app.use("*", async (c, next) => {
    const origin = c.req.header("origin");
    if (origin !== undefined && !allowedOriginSet.has(origin)) {
      return c.json({ error: "origin_not_allowed" }, 403);
    }
    return next();
  });
  app.use(
    "*",
    cors({
      origin: allowedOrigins,
      allowHeaders: ["Authorization", "Content-Type", "X-Trigger-Secret"],
      allowMethods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    }),
  );
  app.use(
    "*",
    limitJsonBody((method, path) => {
      const writesSkillBundle =
        (method === "POST" && path === "/skills") ||
        (method === "PATCH" && /^\/skills\/[^/]+$/.test(path));
      return writesSkillBundle ? MAX_SKILL_JSON_BODY_BYTES : MAX_JSON_BODY_BYTES;
    }),
  );
  app.use("*", async (c, next) => {
    const requestId = c.req.header("x-request-id")?.slice(0, 128) || randomUUID();
    const startedAt = performance.now();
    c.header("X-Request-Id", requestId);
    try {
      await withLogContext({ requestId }, next);
    } catch (error) {
      httpLog.error("HTTP request failed", error, {
        event: "http.request.failed",
        method: c.req.method,
        path: c.req.path,
        durationMs: Math.round(performance.now() - startedAt),
      });
      throw error;
    }
    const context = {
      event: "http.request",
      method: c.req.method,
      path: c.req.path,
      status: c.res.status,
      durationMs: Math.round(performance.now() - startedAt),
    };
    if (isQuietRoute(c.req.method, c.req.path)) httpLog.debug("HTTP request", context);
    else if (c.res.status >= 500) httpLog.error("HTTP request", undefined, context);
    else if (c.res.status >= 400) httpLog.warn("HTTP request", context);
    else httpLog.info("HTTP request", context);
  });
  if (security.apiToken) {
    const expected = security.apiToken;
    app.use("*", async (c, next) => {
      if (
        c.req.method === "OPTIONS" ||
        c.req.path === "/ping" ||
        isWebhookInvocation(c.req.method, c.req.path)
      ) {
        return next();
      }
      const authorization = c.req.header("authorization");
      const presented = authorization?.startsWith("Bearer ")
        ? authorization.slice("Bearer ".length)
        : undefined;
      if (!presented || !sameSecret(presented, expected)) {
        return c.json({ error: "unauthorized" }, 401);
      }
      return next();
    });
  }
  app.get("/", (c) =>
    c.json({
      service: "pizza-bot",
      protocolVersion: PROTOCOL_VERSION,
      apiVersion: API_VERSION,
    }),
  );
  app.get("/ping", (c) => {
    if (host.readiness === "failed") return c.json({ status: "Unhealthy" }, 503);
    return c.json({ status: host.readiness === "warming" ? "HealthyBusy" : "Healthy" });
  });
  app.route("/", pluginRoutes(host));
  app.route("/", statusRoutes(host));
  app.route("/", toolsRoutes(host));
  // Literal thread routes and protocol endpoints must precede parameterized
  // LangGraph routes that could otherwise capture the same paths.
  app.route("/", threadRoutes(host));
  app.route("/", folderRoutes(host));
  app.route("/", protocolRoutes(host));
  app.route("/", langGraphRoutes(host));
  app.route("/", triggerRoutes(host.triggers, host.triggerService));
  app.route("/", skillRoutes(host));
  app.route("/", mcpRoutes(host));
  app.route("/", memoryRoutes(host));
  app.route("/", settingsRoutes(host));
  app.route("/", lifecycleRoutes(host));
  app.route("/", providerRoutes(host));
  app.route("/", attachmentRoutes(host));
  if (logging.dataRoot) app.route("/", logRoutes(logging.dataRoot));
  return app;
}

export async function main(): Promise<void> {
  loadDotEnv();
  const dataRoot = resolveDataRoot();
  const logger = configureLogging({ processName: "api", dataRoot });
  installConsoleCapture(logger.child({ component: "console" }));
  installProcessErrorHandlers(logger.child({ component: "process" }));
  logger.info("API server starting", { event: "api.starting", dataRoot });
  const port = Number(process.env.PORT ?? 8080);
  const network = resolveServerNetworkConfig();

  // Listen while initialization continues; interactive runs await the model and
  // automations await the bounded initial MCP connection pass.
  const host = AgentHost.createPhased({ dataRoot });
  const app = buildApp(host, network, { dataRoot });
  void host
    .startAutomations()
    .catch((err) => console.error("[trigger-service] startup failed:", err));

  const onParentMessage = (message: unknown): void => {
    if (!isSidecarSecretUpdate(message)) return;
    let ok = true;
    try {
      applySidecarSecretUpdate(message);
    } catch {
      ok = false;
    }
    const result: SidecarSecretUpdateResult = {
      type: "secrets.updated",
      requestId: message.requestId,
      ok,
    };
    process.send?.(result);
  };
  process.on("message", onParentMessage);

  const server = serve({ fetch: app.fetch, hostname: network.hostname, port }, (info) => {
    console.log(
      `[api-server] listening on http://${network.hostname}:${info.port} ` +
        `model=${host.modelId} ` +
        `apiVersion=${API_VERSION} dataRoot=${dataRoot} (warming in background)`,
    );
    process.send?.({ type: "ready", port: info.port, pid: process.pid, apiVersion: API_VERSION });
  });

  host
    .whenReady()
    .then(() => console.log(`[api-server] warm: model=${host.modelId} ready`))
    .catch((err) => console.error("[api-server] warmup failed:", err));

  let closing = false;
  const shutdown = async (reason: string, exitAfter = false): Promise<void> => {
    if (closing) return;
    closing = true;
    process.off("message", onParentMessage);
    console.log(`[api-server] ${reason}: shutting down`);
    const stopped = new Promise<void>((resolve) => server.close(() => resolve()));
    await host.close().catch((err) => console.error("[api-server] host close failed:", err));
    const forceClose = (server as { closeAllConnections?: () => void }).closeAllConnections;
    forceClose?.call(server);
    await stopped;
    if (exitAfter) process.exit(0);
  };
  process.once("SIGTERM", () => void shutdown("SIGTERM"));
  process.once("SIGINT", () => void shutdown("SIGINT"));
  // A forked sidecar must reap MCP subprocesses when its parent disappears.
  process.once("disconnect", () => void shutdown("parent disconnect", true));
  // Development may insert a wrapper process, so poll the actual supervisor too.
  const supervisorPid = Number(process.env.PIZZA_SUPERVISOR_PID);
  if (Number.isInteger(supervisorPid) && supervisorPid > 0) {
    const watch = setInterval(() => {
      try {
        process.kill(supervisorPid, 0);
      } catch {
        clearInterval(watch);
        void shutdown("supervisor gone", true);
      }
    }, 1_000);
    watch.unref();
  }
}

function isQuietRoute(method: string, path: string): boolean {
  return path.startsWith("/logs") || (method === "GET" && (path === "/ping" || path === "/status"));
}

function parseOrigins(value: string | undefined): string[] {
  return [...new Set((value ?? "").split(",").map((origin) => origin.trim()).filter(Boolean))];
}

function isLoopbackHost(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (normalized === "localhost" || normalized === "::1") return true;
  return isIP(normalized) === 4 && normalized.split(".", 1)[0] === "127";
}

function sameSecret(presented: string, expected: string): boolean {
  const left = Buffer.from(presented);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

// This endpoint enforces its own per-trigger secret, so it stays outside bearer auth.
function isWebhookInvocation(method: string, path: string): boolean {
  return method === "POST" && /^\/triggers\/[^/]+\/invoke$/.test(path);
}

// pathToFileURL handles spaces, percent encoding, and Windows drive-letter paths
// so the entry-module guard matches import.meta.url on every platform.
function pathFromArgv(): string {
  const p = process.argv[1];
  if (!p) return "";
  try {
    return pathToFileURL(p).href;
  } catch {
    return `file://${p}`;
  }
}
if (process.env.PIZZA_SERVE === "1" || import.meta.url === pathFromArgv()) {
  void main();
}
