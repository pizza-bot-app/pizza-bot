import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  unlinkSync,
} from "node:fs";
import path from "node:path";
import type { LogQuery, LogQueryResult, LogRecord } from "./types.js";

const LOG_FILE = /^[a-z0-9_.-]+-\d{4}-\d{2}-\d{2}-\d+-\d+\.ndjson$/i;

export interface LogFileStoreOptions {
  dataRoot: string;
  processName: string;
  maxFileBytes?: number;
  maxTotalBytes?: number;
  retentionDays?: number;
  now?: () => Date;
}

export class LogFileStore {
  readonly logsDir: string;
  readonly #processName: string;
  readonly #maxFileBytes: number;
  readonly #maxTotalBytes: number;
  readonly #retentionMs: number;
  readonly #now: () => Date;
  #filePath = "";
  #fileBytes = 0;
  #day = "";
  #sequence = 0;

  constructor(options: LogFileStoreOptions) {
    this.logsDir = path.join(options.dataRoot, "logs");
    this.#processName = safeSegment(options.processName);
    this.#maxFileBytes = options.maxFileBytes ?? 5 * 1024 * 1024;
    this.#maxTotalBytes = options.maxTotalBytes ?? 50 * 1024 * 1024;
    this.#retentionMs = (options.retentionDays ?? 7) * 24 * 60 * 60 * 1000;
    this.#now = options.now ?? (() => new Date());
    mkdirSync(options.dataRoot, { recursive: true, mode: 0o700 });
    chmodSync(options.dataRoot, 0o700);
    mkdirSync(this.logsDir, { recursive: true, mode: 0o700 });
    chmodSync(this.logsDir, 0o700);
    for (const file of listLogFiles(this.logsDir)) {
      try {
        chmodSync(file.path, 0o600);
      } catch {
        // A concurrent cleanup may remove a retained file after listing it.
      }
    }
    this.maintain();
  }

  append(record: LogRecord): void {
    const line = `${JSON.stringify(record)}\n`;
    const bytes = Buffer.byteLength(line);
    this.#ensureFile(bytes);
    appendFileSync(this.#filePath, line, { encoding: "utf8", mode: 0o600 });
    this.#fileBytes += bytes;
  }

  maintain(): void {
    const now = this.#now().getTime();
    const files = listLogFiles(this.logsDir);
    for (const file of files) {
      if (now - file.mtimeMs > this.#retentionMs) {
        try {
          unlinkSync(file.path);
        } catch {
          // Logging must never make application startup fail.
        }
      }
    }
    const retained = listLogFiles(this.logsDir).sort((a, b) => b.mtimeMs - a.mtimeMs);
    let total = retained.reduce((sum, file) => sum + file.size, 0);
    for (const file of retained.reverse()) {
      if (total <= this.#maxTotalBytes) break;
      try {
        unlinkSync(file.path);
        total -= file.size;
      } catch {
        // Another process may be writing or cleaning the same directory.
      }
    }
  }

  #ensureFile(incomingBytes: number): void {
    const day = this.#now().toISOString().slice(0, 10);
    if (
      this.#filePath &&
      day === this.#day &&
      this.#fileBytes + incomingBytes <= this.#maxFileBytes
    ) {
      return;
    }
    this.#day = day;
    do {
      this.#filePath = path.join(
        this.logsDir,
        `${this.#processName}-${day}-${process.pid}-${this.#sequence++}.ndjson`,
      );
    } while (existsSync(this.#filePath) && statSync(this.#filePath).size >= this.#maxFileBytes);
    this.#fileBytes = existsSync(this.#filePath) ? statSync(this.#filePath).size : 0;
    this.maintain();
  }
}

export function queryLogFiles(logsDir: string, query: LogQuery = {}): LogQueryResult {
  const limit = Math.min(Math.max(query.limit ?? 500, 1), 5_000);
  const search = query.search?.trim().toLowerCase();
  const records: LogRecord[] = [];
  let matched = 0;
  for (const file of listLogFiles(logsDir)) {
    if (query.since && file.mtimeMs < Date.parse(query.since)) continue;
    let content: string;
    try {
      content = readFileSync(file.path, "utf8");
    } catch {
      continue;
    }
    for (const line of content.split("\n")) {
      if (!line) continue;
      let record: LogRecord;
      try {
        record = JSON.parse(line) as LogRecord;
      } catch {
        continue;
      }
      if (!matches(record, query, search)) continue;
      matched++;
      records.push(record);
    }
  }
  records.sort((a, b) => a.timestamp.localeCompare(b.timestamp) || a.id.localeCompare(b.id));
  const selected = records.length > limit ? records.slice(-limit) : records;
  const latestTimestamp = selected.at(-1)?.timestamp;
  return {
    records: selected,
    ...(latestTimestamp ? { latestTimestamp } : {}),
    truncated: matched > selected.length,
  };
}

export function deleteLogFiles(logsDir: string): number {
  let deleted = 0;
  for (const file of listLogFiles(logsDir)) {
    try {
      unlinkSync(file.path);
      deleted++;
    } catch {
      // Active files can be recreated by their owning process.
    }
  }
  return deleted;
}

function matches(record: LogRecord, query: LogQuery, search: string | undefined): boolean {
  if (query.levels?.length && !query.levels.includes(record.level)) return false;
  if (query.processes?.length && !query.processes.includes(record.process)) return false;
  if (query.components?.length && !query.components.includes(record.component)) return false;
  if (query.since && record.timestamp <= query.since) return false;
  if (query.until && record.timestamp > query.until) return false;
  if (search && !JSON.stringify(record).toLowerCase().includes(search)) return false;
  return true;
}

function listLogFiles(logsDir: string): Array<{ path: string; size: number; mtimeMs: number }> {
  let names: string[];
  try {
    names = readdirSync(logsDir);
  } catch {
    return [];
  }
  const out: Array<{ path: string; size: number; mtimeMs: number }> = [];
  for (const name of names) {
    if (!LOG_FILE.test(name)) continue;
    const filePath = path.join(logsDir, name);
    try {
      const stat = statSync(filePath);
      if (stat.isFile()) out.push({ path: filePath, size: stat.size, mtimeMs: stat.mtimeMs });
    } catch {
      // File may have been rotated between listing and stat.
    }
  }
  return out;
}

function safeSegment(value: string): string {
  const normalized = value.toLowerCase().replace(/[^a-z0-9_.-]+/g, "-");
  let start = 0;
  let end = normalized.length;
  while (normalized[start] === "-") start++;
  while (normalized[end - 1] === "-") end--;
  return normalized.slice(start, end) || "app";
}
