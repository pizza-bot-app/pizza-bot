import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { LogFileStore, queryLogFiles } from "./file-store.js";
import type { LogRecord } from "./types.js";

const tempRoots: string[] = [];

function tempRoot(prefix: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  tempRoots.push(dir);
  return dir;
}

afterAll(() => {
  for (const dir of tempRoots) rmSync(dir, { recursive: true, force: true });
});

function record(id: string, timestamp: string, level: LogRecord["level"] = "info"): LogRecord {
  return {
    id,
    timestamp,
    level,
    process: "api",
    pid: 1,
    component: "test",
    message: `message ${id}`,
  };
}

describe("LogFileStore", () => {
  it("rotates files and returns bounded, filtered records", () => {
    const root = tempRoot("pizza-logs-");
    const store = new LogFileStore({
      dataRoot: root,
      processName: "api",
      maxFileBytes: 260,
      maxTotalBytes: 10_000,
    });
    store.append(record("a", "2026-08-07T00:00:00.000Z"));
    store.append(record("b", "2026-08-07T00:00:01.000Z", "error"));
    store.append(record("c", "2026-08-07T00:00:02.000Z"));

    expect(readdirSync(store.logsDir).length).toBeGreaterThan(1);
    expect(queryLogFiles(store.logsDir, { levels: ["error"], limit: 10 }).records)
      .toEqual([record("b", "2026-08-07T00:00:01.000Z", "error")]);
    expect(queryLogFiles(store.logsDir, { limit: 2 })).toMatchObject({
      records: [
        record("b", "2026-08-07T00:00:01.000Z", "error"),
        record("c", "2026-08-07T00:00:02.000Z"),
      ],
      truncated: true,
    });
  });

  it("removes expired files during maintenance", () => {
    const root = tempRoot("pizza-logs-");
    const now = new Date("2026-08-07T12:00:00.000Z");
    const store = new LogFileStore({
      dataRoot: root,
      processName: "api",
      retentionDays: 1,
      now: () => now,
    });
    store.append(record("old", "2026-08-05T00:00:00.000Z"));
    const file = path.join(store.logsDir, readdirSync(store.logsDir)[0]!);
    const old = new Date("2026-08-05T00:00:00.000Z");
    utimesSync(file, old, old);
    store.maintain();
    expect(statSync(store.logsDir).isDirectory()).toBe(true);
    expect(readdirSync(store.logsDir)).toEqual([]);
  });

  it("writes private logs and repairs permissive existing modes", () => {
    const root = tempRoot("pizza-logs-");
    const logsDir = path.join(root, "logs");
    const existing = path.join(logsDir, "api-2026-08-06-1-0.ndjson");
    chmodSync(root, 0o755);
    mkdirSync(logsDir, { mode: 0o755 });
    writeFileSync(existing, `${JSON.stringify(record("old", "2026-08-06T00:00:00.000Z"))}\n`, {
      mode: 0o644,
    });

    const store = new LogFileStore({ dataRoot: root, processName: "api" });
    store.append(record("one", "2026-08-07T00:00:00.000Z"));
    const current = readdirSync(store.logsDir)
      .map((name) => path.join(store.logsDir, name))
      .find((file) => readFileSync(file, "utf8").includes('"id":"one"'));

    expect(current).toBeDefined();
    // Windows chmod only toggles the read-only bit, so POSIX modes never hold.
    if (process.platform !== "win32") {
      expect(statSync(root).mode & 0o777).toBe(0o700);
      expect(statSync(store.logsDir).mode & 0o777).toBe(0o700);
      expect(statSync(existing).mode & 0o777).toBe(0o600);
      expect(statSync(current!).mode & 0o777).toBe(0o600);
    }
  });
});
