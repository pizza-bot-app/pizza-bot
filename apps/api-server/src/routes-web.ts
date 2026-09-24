/** Serves the built browser app beside the API so both share one origin. */
import { serveStatic } from "@hono/node-server/serve-static";
import type { Hono } from "hono";

export interface WebAppOptions {
  dir: string;
  apiToken?: string;
}

const HASHED_ASSET_PREFIX = "/assets/";

/**
 * Vite content-hashes everything under `assets/`; the shell and the icons keep
 * their names across builds. `serveStatic` sends only `Last-Modified` and answers
 * no conditional request, so a name-stable file left without `Cache-Control` falls
 * to a browser's heuristic freshness — and a stale shell pins the client to the
 * previous build's hashed bundles.
 */
function cacheControlFor(path: string): string {
  return path.startsWith(HASHED_ASSET_PREFIX)
    ? "public, max-age=31536000, immutable"
    : "no-store";
}

/**
 * Must be mounted ahead of bearer auth: a browser has to load the app and its
 * configuration before it can present a token.
 */
export function mountWebApp(app: Hono, options: WebAppOptions): void {
  // serveStatic builds its Response before it calls onFound, so a Cache-Control
  // set on the context there never reaches it. Mark the hit and stamp the Response
  // itself; a miss resolves undefined and falls through to the API routes.
  const served = new WeakSet<object>();
  const files = serveStatic({
    root: options.dir,
    onFound: (_path, c) => {
      served.add(c);
    },
  });

  // Generated per request instead of built into the bundle so one image serves
  // any origin. The token it carries is readable by every client that can reach
  // this listener, so the listener's network boundary is the access control.
  app.get("/pizza-config.js", (c) => {
    const config = {
      apiBase: "/",
      ...(options.apiToken ? { apiToken: options.apiToken } : {}),
    };
    c.header("Content-Type", "text/javascript; charset=utf-8");
    c.header("Cache-Control", "no-store");
    return c.body(`window.__PIZZA_CONFIG__ = ${JSON.stringify(config)};\n`);
  });

  app.use("*", async (c, next) => {
    if (c.req.method !== "GET" && c.req.method !== "HEAD") return next();
    // `/` is also the service-identity endpoint the desktop connection probe
    // parses, so only a navigating browser is answered with the app shell.
    if (c.req.path === "/" && !c.req.header("accept")?.includes("text/html")) {
      return next();
    }
    // Any path without a matching file falls through to the API routes.
    const res = await files(c, next);
    if (res && served.delete(c)) {
      res.headers.set("Cache-Control", cacheControlFor(c.req.path));
    }
    return res;
  });
}
