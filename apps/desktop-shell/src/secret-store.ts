/** Persists keychain-encrypted secrets; plaintext reaches only the child at boot. */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname } from "node:path";

export interface SecretCrypto {
  isEncryptionAvailable(): boolean;
  encryptString(plaintext: string): Buffer;
  decryptString(ciphertext: Buffer): string;
}

interface StoredSecrets {
  version: 1;
  secrets: Record<string, string>;
}

export class SecretStore {
  private readonly crypto: SecretCrypto;
  private readonly filePath: string;
  private secrets: Map<string, Buffer>;

  constructor(crypto: SecretCrypto, filePath: string) {
    this.crypto = crypto;
    this.filePath = filePath;
    this.secrets = load(filePath);
  }

  list(): string[] {
    return [...this.secrets.keys()].sort();
  }

  has(name: string): boolean {
    return this.secrets.has(name);
  }

  /** Refuse storage when OS encryption is unavailable. */
  set(name: string, value: string): void {
    assertName(name);
    if (!this.crypto.isEncryptionAvailable()) {
      throw new Error("OS secret encryption is unavailable; refusing to store a secret in plaintext.");
    }
    this.secrets.set(name, this.crypto.encryptString(value));
    this.persist();
  }

  delete(name: string): void {
    if (this.secrets.delete(name)) this.persist();
  }

  /** Skip corrupt or keychain-invalid rows so one secret cannot block startup. */
  decryptAll(): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [name, ciphertext] of this.secrets) {
      try {
        out[name] = this.crypto.decryptString(ciphertext);
      } catch (err) {
        console.warn(`[secrets] failed to decrypt "${name}" — skipping. (${err instanceof Error ? err.message : String(err)})`);
      }
    }
    return out;
  }

  private persist(): void {
    const stored: StoredSecrets = {
      version: 1,
      secrets: Object.fromEntries([...this.secrets].map(([name, buf]) => [name, buf.toString("base64")])),
    };
    mkdirSync(dirname(this.filePath), { recursive: true });
    writeFileSync(this.filePath, JSON.stringify(stored, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
  }
}

function load(filePath: string): Map<string, Buffer> {
  const map = new Map<string, Buffer>();
  if (!existsSync(filePath)) return map;
  try {
    const parsed = JSON.parse(readFileSync(filePath, "utf8")) as StoredSecrets;
    if (parsed && parsed.version === 1 && parsed.secrets && typeof parsed.secrets === "object") {
      for (const [name, b64] of Object.entries(parsed.secrets)) {
        if (typeof b64 === "string") map.set(name, Buffer.from(b64, "base64"));
      }
    }
  } catch (err) {
    console.warn(`[secrets] could not read ${filePath} — starting empty. (${err instanceof Error ? err.message : String(err)})`);
  }
  return map;
}

function assertName(name: string): void {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
    throw new Error(`invalid secret name "${name}" — must be a valid environment-variable identifier`);
  }
}
