import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openPersistence } from "./persistence.js";

const tmpRoots: string[] = [];
function tmpRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pizza-persist-"));
  tmpRoots.push(root);
  return root;
}

afterEach(() => {
  for (const r of tmpRoots.splice(0)) fs.rmSync(r, { recursive: true, force: true });
});

describe("openPersistence (SqliteSaver-backed durable threads)", () => {
  it("creates checkpoints.sqlite on disk under the resolved layout", async () => {
    const root = tmpRoot();
    const p = await openPersistence({ root });
    expect(fs.existsSync(p.layout.checkpointsDb)).toBe(true);
    p.close();
  });

  it("persists a checkpoint across reopen (durability, not just in-memory)", async () => {
    const root = tmpRoot();
    const cfg = { configurable: { thread_id: "t1", checkpoint_ns: "" } };

    const first = await openPersistence({ root });
    const checkpoint = {
      v: 4,
      id: "chk-1",
      ts: "2026-07-04T00:00:00.000Z",
      channel_values: { messages: ["hello"] },
      channel_versions: {},
      versions_seen: {},
    };
    await first.checkpointer.put(cfg, checkpoint as never, { source: "input", step: 0 } as never);
    first.close();

    const second = await openPersistence({ root });
    const tuple = await second.checkpointer.getTuple(cfg);
    expect(tuple?.checkpoint.id).toBe("chk-1");
    second.close();
  });

  it("supports an ephemeral :memory: root for tests", async () => {
    const p = await openPersistence({ root: ":memory:" });
    expect(p.checkpointer).toBeDefined();
    expect(p.store).toBeDefined();
    p.close();
  });
});
