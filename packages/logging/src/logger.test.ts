import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { queryLogFiles } from "./file-store.js";
import { configureLogging, getLogger } from "./logger.js";

const tempRoots: string[] = [];

function tempRoot(prefix: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  tempRoots.push(dir);
  return dir;
}

afterAll(() => {
  for (const dir of tempRoots) rmSync(dir, { recursive: true, force: true });
});

describe("structured logger", () => {
  it("adds child context, serializes errors, and redacts before persistence", () => {
    const root = tempRoot("pizza-logger-");
    configureLogging({
      dataRoot: root,
      processName: "test",
      console: false,
      knownSecrets: ["known-secret"],
    });
    getLogger("worker").error("request Bearer abc failed", new Error("known-secret"), {
      event: "worker.failed",
      requestId: "r1",
      apiKey: "raw-key",
    });
    const [record] = queryLogFiles(path.join(root, "logs")).records;
    expect(record).toMatchObject({
      level: "error",
      process: "test",
      component: "worker",
      event: "worker.failed",
      message: "request Bearer <redacted> failed",
      error: { message: "<redacted>" },
      context: { requestId: "r1", apiKey: "<redacted>" },
    });
  });
});
