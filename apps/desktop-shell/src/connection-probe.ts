/** Validates a remote API before the desktop switches away from its current backend. */
import { normalizeRemoteUrl } from "./connection-store.js";

export interface ConnectionProbeOptions {
  remoteUrl: string;
  token?: string;
  origin: string;
  expectedApiVersion: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

export interface ConnectionProbeResult {
  remoteUrl: string;
  apiVersion: string;
}

export async function probeRemoteConnection(
  options: ConnectionProbeOptions,
): Promise<ConnectionProbeResult> {
  const remoteUrl = normalizeRemoteUrl(options.remoteUrl);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 10_000);
  timer.unref?.();
  try {
    const response = await (options.fetch ?? globalThis.fetch)(`${remoteUrl}/`, {
      headers: {
        origin: options.origin,
        ...(options.token
          ? { authorization: `Bearer ${options.token}` }
          : {}),
      },
      signal: controller.signal,
    });
    if (response.status === 401) {
      throw new Error("The backend rejected the bearer token.");
    }
    if (response.status === 403) {
      throw new Error(
        `The backend does not allow the desktop origin (${options.origin}).`,
      );
    }
    if (!response.ok) {
      throw new Error(
        `The backend returned ${response.status} ${response.statusText || "HTTP error"}.`,
      );
    }
    const allowedOrigin = response.headers.get("access-control-allow-origin");
    if (allowedOrigin !== options.origin && allowedOrigin !== "*") {
      throw new Error(
        `The backend did not allow the desktop origin (${options.origin}).`,
      );
    }
    const body = (await response.json().catch(() => undefined)) as
      | { service?: unknown; apiVersion?: unknown }
      | undefined;
    if (body?.service !== "pizza-bot" || typeof body.apiVersion !== "string") {
      throw new Error("The URL is not a compatible Pizza Bot backend.");
    }
    if (body.apiVersion !== options.expectedApiVersion) {
      throw new Error(
        `Incompatible backend API version ${body.apiVersion}; expected ${options.expectedApiVersion}.`,
      );
    }
    return { remoteUrl, apiVersion: body.apiVersion };
  } catch (err) {
    if (controller.signal.aborted) {
      throw new Error("The backend connection timed out.");
    }
    if (err instanceof Error) throw err;
    throw new Error(String(err));
  } finally {
    clearTimeout(timer);
  }
}
