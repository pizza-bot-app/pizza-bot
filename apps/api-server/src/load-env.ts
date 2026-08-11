import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";

export function resolveDataRoot(): string {
  return process.env.PIZZA_DATA_ROOT ?? resolve(homedir(), ".pizza-bot-oss");
}

// Backfill unset env from `.env`/`.env.local` in each candidate; loadEnvFile
// never overrides an already-set var, so exported vars always win. The data
// root is the candidate that exists inside a packaged `.app` (whose bundle dir
// has no `.env`); cwd covers headless launches; repo root covers dev.
export function loadDotEnv(log: (msg: string) => void = () => {}): void {
  const here = dirname(fileURLToPath(import.meta.url));
  const dataRoot = resolveDataRoot();
  const candidateDirs = [dataRoot, process.cwd(), resolve(here, "../../..")];
  const seen = new Set<string>();
  for (const dir of candidateDirs) {
    if (seen.has(dir)) continue;
    seen.add(dir);
    for (const name of [".env", ".env.local"]) {
      const file = resolve(dir, name);
      try {
        process.loadEnvFile(file);
        log(`loaded ${file}`);
      } catch {
        // Missing or unreadable env files are optional and leave process.env unchanged.
      }
    }
  }
}
