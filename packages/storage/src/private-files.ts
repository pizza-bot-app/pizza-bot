import fs from "node:fs";

export function ensurePrivateDirectory(directory: string): void {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  fs.chmodSync(directory, 0o700);
}

export function ensurePrivateFile(file: string): void {
  fs.chmodSync(file, 0o600);
}
