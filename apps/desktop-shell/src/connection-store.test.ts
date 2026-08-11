import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  ConnectionStore,
  normalizeRemoteUrl,
} from "./connection-store.js";
import type { SecretCrypto } from "./secret-store.js";

function crypto(available = true): SecretCrypto {
  return {
    isEncryptionAvailable: () => available,
    encryptString: (value) => Buffer.from(`ENC:${value.split("").reverse().join("")}`),
    decryptString: (value) => {
      const raw = value.toString();
      if (!raw.startsWith("ENC:")) throw new Error("bad ciphertext");
      return raw.slice(4).split("").reverse().join("");
    },
  };
}

let dir: string;
let file: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "connection-store-"));
  file = path.join(dir, "desktop-connection.json");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("ConnectionStore", () => {
  it("defaults to the embedded backend", () => {
    expect(new ConnectionStore(crypto(), file).settings()).toEqual({
      mode: "local",
      hasToken: false,
    });
  });

  it("persists a normalized URL and encrypted token", () => {
    const store = new ConnectionStore(crypto(), file);
    store.useRemote(" https://pizza.example/api/ ", "remote-secret");

    expect(store.settings()).toEqual({
      mode: "remote",
      remoteUrl: "https://pizza.example/api",
      hasToken: true,
    });
    expect(store.remoteToken()).toBe("remote-secret");
    expect(store.remoteTokenFor("https://pizza.example/api/")).toBe("remote-secret");
    expect(store.remoteTokenFor("https://other.example/api")).toBeUndefined();
    expect(readFileSync(file, "utf8")).not.toContain("remote-secret");

    const reloaded = new ConnectionStore(crypto(), file);
    expect(reloaded.settings()).toEqual(store.settings());
    expect(reloaded.remoteToken()).toBe("remote-secret");
  });

  it("retains remote details when toggled back to local", () => {
    const store = new ConnectionStore(crypto(), file);
    store.useRemote("https://pizza.example", "secret");
    store.useLocal();

    expect(store.settings()).toEqual({
      mode: "local",
      remoteUrl: "https://pizza.example",
      hasToken: true,
    });
    expect(store.remoteToken()).toBe("secret");
  });

  it("refuses to persist a token without OS encryption", () => {
    const store = new ConnectionStore(crypto(false), file);
    expect(() => store.useRemote("https://pizza.example", "secret")).toThrow(/encryption/i);
  });
});

describe("normalizeRemoteUrl", () => {
  it("accepts loopback HTTP and remote HTTPS, removing one trailing slash", () => {
    expect(normalizeRemoteUrl("http://localhost:8080/")).toBe("http://localhost:8080");
    expect(normalizeRemoteUrl("http://127.0.0.2:8080/")).toBe("http://127.0.0.2:8080");
    expect(normalizeRemoteUrl("http://[::1]:8080/")).toBe("http://[::1]:8080");
    expect(normalizeRemoteUrl("https://pizza.example/api/")).toBe(
      "https://pizza.example/api",
    );
  });

  it("rejects unsupported or credential-bearing URLs", () => {
    expect(() => normalizeRemoteUrl("file:///tmp/api")).toThrow(/http/i);
    expect(() => normalizeRemoteUrl("http://pizza.example")).toThrow(/https/i);
    expect(() => normalizeRemoteUrl("https://user:pass@pizza.example")).toThrow(
      /token field/i,
    );
    expect(() => normalizeRemoteUrl("https://pizza.example?token=nope")).toThrow(
      /query string/i,
    );
  });
});
