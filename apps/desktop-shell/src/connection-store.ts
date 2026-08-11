/** Persists desktop backend selection while keeping remote tokens encrypted. */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { isIP } from "node:net";
import { dirname } from "node:path";
import type { SecretCrypto } from "./secret-store.js";

export type ConnectionMode = "local" | "remote";

export interface ConnectionSettings {
  mode: ConnectionMode;
  remoteUrl?: string;
  hasToken: boolean;
}

interface StoredConnection {
  version: 1;
  mode: ConnectionMode;
  remoteUrl?: string;
  remoteToken?: string;
}

export class ConnectionStore {
  private stored: StoredConnection;

  constructor(
    private readonly crypto: SecretCrypto,
    private readonly filePath: string,
  ) {
    this.stored = load(filePath);
  }

  settings(): ConnectionSettings {
    return {
      mode: this.stored.mode,
      ...(this.stored.remoteUrl ? { remoteUrl: this.stored.remoteUrl } : {}),
      hasToken: this.stored.remoteToken !== undefined,
    };
  }

  remoteToken(): string | undefined {
    if (!this.stored.remoteToken) return undefined;
    try {
      return this.crypto.decryptString(Buffer.from(this.stored.remoteToken, "base64"));
    } catch (err) {
      console.warn(
        `[connection] failed to decrypt remote token; ignoring it. (${
          err instanceof Error ? err.message : String(err)
        })`,
      );
      return undefined;
    }
  }

  remoteTokenFor(remoteUrl: string): string | undefined {
    return this.stored.remoteUrl === normalizeRemoteUrl(remoteUrl)
      ? this.remoteToken()
      : undefined;
  }

  useLocal(): void {
    this.stored = { ...this.stored, mode: "local" };
    this.persist();
  }

  useRemote(remoteUrl: string, token: string | undefined): void {
    const normalized = normalizeRemoteUrl(remoteUrl);
    let remoteToken: string | undefined;
    if (token) {
      if (!this.crypto.isEncryptionAvailable()) {
        throw new Error(
          "OS secret encryption is unavailable; refusing to store the remote token in plaintext.",
        );
      }
      remoteToken = this.crypto.encryptString(token).toString("base64");
    }
    this.stored = {
      version: 1,
      mode: "remote",
      remoteUrl: normalized,
      ...(remoteToken ? { remoteToken } : {}),
    };
    this.persist();
  }

  private persist(): void {
    mkdirSync(dirname(this.filePath), { recursive: true });
    writeFileSync(this.filePath, JSON.stringify(this.stored, null, 2) + "\n", {
      encoding: "utf8",
      mode: 0o600,
    });
  }
}

export function normalizeRemoteUrl(input: string): string {
  const value = input.trim();
  if (!value) throw new Error("Enter a remote backend URL.");
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Enter a valid remote backend URL.");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Remote backend URLs must use http:// or https://.");
  }
  if (url.protocol === "http:" && !isLoopbackHost(url.hostname)) {
    throw new Error("Remote backend URLs outside this machine must use https://.");
  }
  if (url.username || url.password) {
    throw new Error("Put credentials in the token field, not in the URL.");
  }
  if (url.search || url.hash) {
    throw new Error("Remote backend URLs cannot contain a query string or fragment.");
  }
  return url.toString().replace(/\/$/, "");
}

function isLoopbackHost(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (normalized === "localhost" || normalized.endsWith(".localhost") || normalized === "::1") {
    return true;
  }
  return isIP(normalized) === 4 && normalized.split(".", 1)[0] === "127";
}

function load(filePath: string): StoredConnection {
  if (!existsSync(filePath)) return { version: 1, mode: "local" };
  try {
    const parsed = JSON.parse(readFileSync(filePath, "utf8")) as Partial<StoredConnection>;
    if (
      parsed.version === 1 &&
      (parsed.mode === "local" || parsed.mode === "remote") &&
      (parsed.remoteUrl === undefined || typeof parsed.remoteUrl === "string") &&
      (parsed.remoteToken === undefined || typeof parsed.remoteToken === "string")
    ) {
      const remoteUrl = parsed.remoteUrl
        ? normalizeRemoteUrl(parsed.remoteUrl)
        : undefined;
      if (parsed.mode === "remote" && !remoteUrl) {
        throw new Error("remote mode has no URL");
      }
      return {
        version: 1,
        mode: parsed.mode,
        ...(remoteUrl ? { remoteUrl } : {}),
        ...(parsed.remoteToken ? { remoteToken: parsed.remoteToken } : {}),
      };
    }
  } catch (err) {
    console.warn(
      `[connection] could not read ${filePath}; using embedded backend. (${
        err instanceof Error ? err.message : String(err)
      })`,
    );
  }
  return { version: 1, mode: "local" };
}
