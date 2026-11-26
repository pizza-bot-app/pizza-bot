import { describe, expect, it } from "vitest";
import { applyStepEdit, serialQueue, stepDrafts, stepsPatch } from "./todo-steps.js";

const steps = stepDrafts([
  { id: "a", title: "Book flight", completed: false },
  { id: "b", title: "Pack", completed: false },
]);

describe("applyStepEdit", () => {
  it("applies each edit to the latest list, so quick successive edits all survive", () => {
    const toggledA = applyStepEdit(steps, { kind: "toggle", key: "a" });
    const toggledB = applyStepEdit(toggledA, { kind: "toggle", key: "b" });
    expect(toggledB.map((step) => step.completed)).toEqual([true, true]);
  });

  it("adds with a client key, then edits that step before the server names it", () => {
    const added = applyStepEdit(steps, { kind: "add", key: "local-1", title: "Water plants" });
    const renamed = applyStepEdit(added, { kind: "rename", key: "local-1", title: "Water the plants" });
    expect(stepsPatch(renamed)).toEqual([
      { id: "a", title: "Book flight", completed: false },
      { id: "b", title: "Pack", completed: false },
      { title: "Water the plants", completed: false },
    ]);
    expect(applyStepEdit(renamed, { kind: "remove", key: "a" }).map((step) => step.key)).toEqual(["b", "local-1"]);
  });
});

describe("serialQueue", () => {
  it("runs tasks one at a time in order and counts what is still pending", async () => {
    const queue = serialQueue();
    const order: string[] = [];
    let release!: () => void;
    const first = queue.run(
      () =>
        new Promise<void>((resolve) => {
          order.push("first:start");
          release = () => {
            order.push("first:end");
            resolve();
          };
        }),
    );
    const second = queue.run(async () => {
      order.push("second");
    });
    await Promise.resolve();
    expect(queue.pending).toBe(2);
    release();
    await Promise.all([first, second]);
    expect(order).toEqual(["first:start", "first:end", "second"]);
    expect(queue.pending).toBe(0);
  });

  it("keeps going after a failed task and reports the failure to its caller", async () => {
    const queue = serialQueue();
    const failed = queue.run(async () => {
      throw new Error("boom");
    });
    const next = queue.run(async () => "ok");
    await expect(failed).rejects.toThrow("boom");
    await expect(next).resolves.toBe("ok");
  });

  it("has settled its count by the time a caller sees the result", async () => {
    const queue = serialQueue();
    let pendingSeen = -1;
    await queue.run(async () => undefined).finally(() => {
      pendingSeen = queue.pending;
    });
    expect(pendingSeen).toBe(0);
  });
});
