// Electron injects preload values. Static deployments can replace
// public/pizza-config.js at deploy time without rebuilding the renderer.
export function resolveApiBase(): string {
  const browser = typeof window !== "undefined" ? window : undefined;
  const injected = browser?.__PIZZA_API_BASE__ ?? browser?.__PIZZA_CONFIG__?.apiBase;
  if (injected && injected.length > 0) {
    return new URL(injected, browser?.location.origin ?? "http://localhost").toString().replace(/\/$/, "");
  }
  const origin = typeof window !== "undefined" ? window.location.origin : "http://localhost";
  return new URL("/api", origin).toString().replace(/\/$/, "");
}

export function resolveApiHeaders(): Record<string, string> {
  const browser = typeof window !== "undefined" ? window : undefined;
  const token = (
    browser?.__PIZZA_API_TOKEN__ ??
    browser?.__PIZZA_CONFIG__?.apiToken
  )?.trim();
  return token ? { authorization: `Bearer ${token}` } : {};
}
