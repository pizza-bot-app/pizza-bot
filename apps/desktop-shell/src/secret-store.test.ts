import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { SecretStore, type SecretCrypto } from "./secret-store.js";

/** Reversible non-identity fake used only to verify plaintext is absent on disk. */
function makeFakeCrypto(available = true): SecretCrypto {
  return {
    isEncryptionAvailable: () => available,
    encryptString: (s) => Buffer.from("ENC:" + [...s].reverse().join(""), "utf8"),
    decryptString: (b) => {
      const raw = b.toString("utf8");
      if (!raw.startsWith("ENC:")) throw new Error("bad ciphertext");
      return [...raw.slice(4)].reverse().join("");
    },
  };
}

let dir: string;
let file: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "secret-store-"));
  file = path.join(dir, "secrets.json");
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("SecretStore", () => {
  it("round-trips a secret without ever writing plaintext", () => {
    const store = new SecretStore(makeFakeCrypto(), file);
    store.set("PIZZA_SECRET_ANTHROPIC_APIKEY", "sk-super-secret-123");

    expect(store.decryptAll()).toEqual({ PIZZA_SECRET_ANTHROPIC_APIKEY: "sk-super-secret-123" });

    const onDisk = readFileSync(file, "utf8");
    expect(onDisk).not.toContain("sk-super-secret-123");
    expect(onDisk).toContain("PIZZA_SECRET_ANTHROPIC_APIKEY");
  });

  it("lists names only, sorted", () => {
    const store = new SecretStore(makeFakeCrypto(), file);
    store.set("B_KEY", "v1");
    store.set("A_KEY", "v2");
    expect(store.list()).toEqual(["A_KEY", "B_KEY"]);
    expect(store.has("A_KEY")).toBe(true);
    expect(store.has("NOPE")).toBe(false);
  });

  it("persists across instances (reload from disk)", () => {
    new SecretStore(makeFakeCrypto(), file).set("K", "value-42");
    const reloaded = new SecretStore(makeFakeCrypto(), file);
    expect(reloaded.decryptAll()).toEqual({ K: "value-42" });
  });

  it("delete removes a secret", () => {
    const store = new SecretStore(makeFakeCrypto(), file);
    store.set("K", "v");
    store.delete("K");
    expect(store.list()).toEqual([]);
    expect(store.decryptAll()).toEqual({});
  });

  it("refuses to store when encryption is unavailable (never plaintext)", () => {
    const store = new SecretStore(makeFakeCrypto(false), file);
    expect(() => store.set("K", "v")).toThrow(/unavailable/i);
    expect(existsSync(file)).toBe(false);
  });

  it("rejects an invalid env-ref name", () => {
    const store = new SecretStore(makeFakeCrypto(), file);
    expect(() => store.set("1bad-name", "v")).toThrow(/invalid secret name/i);
    expect(() => store.set("has space", "v")).toThrow(/invalid secret name/i);
  });

  it("skips an undecryptable row rather than throwing the whole boot", () => {
    const good = Buffer.from("ENC:" + [..."ok"].reverse().join(""), "utf8").toString("base64");
    const corrupt = Buffer.from("not-enc-tagged", "utf8").toString("base64");
    writeFileSync(file, JSON.stringify({ version: 1, secrets: { GOOD: good, BAD: corrupt } }));

    const store = new SecretStore(makeFakeCrypto(), file);
    const decrypted = store.decryptAll();
    expect(decrypted).toEqual({ GOOD: "ok" });
  });
});
