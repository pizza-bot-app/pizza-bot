import { describe, it, expect } from "vitest";
import { parseCron, describeCron, nextCronRun, CRON_PRESETS } from "./cron.js";

describe("parseCron", () => {
  it("parses a plain daily expression", () => {
    const p = parseCron("0 9 * * *");
    expect(p).not.toBeNull();
    expect([...p!.minute]).toEqual([0]);
    expect([...p!.hour]).toEqual([9]);
    expect(p!.domStar).toBe(true);
    expect(p!.dowStar).toBe(true);
  });

  it("expands lists, ranges, and steps", () => {
    const p = parseCron("0,30 9-11 * * 1-5");
    expect([...p!.minute]).toEqual([0, 30]);
    expect([...p!.hour]).toEqual([9, 10, 11]);
    expect([...p!.dow]).toEqual([1, 2, 3, 4, 5]);

    const step = parseCron("*/15 * * * *");
    expect([...step!.minute]).toEqual([0, 15, 30, 45]);
  });

  it("normalizes dow 7 to 0 (Sunday)", () => {
    expect([...parseCron("0 0 * * 7")!.dow]).toEqual([0]);
  });

  it("rejects malformed or out-of-range expressions", () => {
    expect(parseCron("0 9 * *")).toBeNull();
    expect(parseCron("60 9 * * *")).toBeNull();
    expect(parseCron("0 9 * * abc")).toBeNull();
    expect(parseCron("0 9 * * */0")).toBeNull();
  });
});

describe("describeCron", () => {
  it("summarizes common shapes", () => {
    expect(describeCron("0 9 * * *")).toBe("Daily at 09:00");
    expect(describeCron("30 8 * * 1-5")).toBe("Mon, Tue, Wed, Thu, Fri at 08:30");
    expect(describeCron("0 8 * * 1")).toBe("Mon at 08:00");
  });

  it("falls back to the raw expression when unparseable", () => {
    expect(describeCron("weird nonsense here now")).toBe("weird nonsense here now");
  });
});

describe("nextCronRun", () => {
  it("finds the next daily fire after a given instant", () => {
    const now = new Date(2026, 6, 7, 10, 0, 0);
    const next = nextCronRun("0 9 * * *", now)!;
    expect(next.getHours()).toBe(9);
    expect(next.getMinutes()).toBe(0);
    expect(next.getDate()).toBe(8);
  });

  it("returns a time later the same day when it hasn't passed yet", () => {
    const now = new Date(2026, 6, 7, 6, 0, 0);
    const next = nextCronRun("0 9 * * *", now)!;
    expect(next.getDate()).toBe(7);
    expect(next.getHours()).toBe(9);
  });

  it("returns null for an unparseable expression", () => {
    expect(nextCronRun("nope")).toBeNull();
  });

  it("evaluates the schedule in an explicit timezone", () => {
    const now = new Date("2026-07-07T15:30:00.000Z");
    const next = nextCronRun("0 9 * * *", now, "America/Los_Angeles");
    expect(next?.toISOString()).toBe("2026-07-07T16:00:00.000Z");
  });

  it("returns null for an invalid timezone", () => {
    expect(nextCronRun("0 9 * * *", new Date(), "Mars/Olympus")).toBeNull();
  });
});

describe("CRON_PRESETS", () => {
  it("are all parseable", () => {
    for (const p of CRON_PRESETS) expect(parseCron(p.cron)).not.toBeNull();
  });

  it("uses a consistent morning time for calendar-based presets", () => {
    expect(CRON_PRESETS.map((preset) => preset.cron)).toEqual([
      "0 * * * *",
      "0 9 * * *",
      "0 9 * * 1-5",
      "0 9 * * 1",
      "0 9 1 * *",
    ]);
  });
});
