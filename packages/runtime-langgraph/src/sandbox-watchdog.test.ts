import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Watchdog } from "./sandbox-watchdog.js";

describe("sandbox Watchdog", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("expires once its budget has run", () => {
    const onExpire = vi.fn();
    new Watchdog(1_000, onExpire).resume();

    vi.advanceTimersByTime(999);
    expect(onExpire).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onExpire).toHaveBeenCalledOnce();
  });

  it("does not elapse while paused and resumes with the remaining budget", () => {
    const onExpire = vi.fn();
    const watchdog = new Watchdog(1_000, onExpire);
    watchdog.resume();
    vi.advanceTimersByTime(600);
    watchdog.pause();
    vi.advanceTimersByTime(60_000);
    expect(onExpire).not.toHaveBeenCalled();

    watchdog.resume();
    vi.advanceTimersByTime(399);
    expect(onExpire).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onExpire).toHaveBeenCalledOnce();
  });

  it("treats repeated pause and resume as one", () => {
    const onExpire = vi.fn();
    const watchdog = new Watchdog(1_000, onExpire);
    watchdog.resume();
    vi.advanceTimersByTime(300);
    watchdog.resume();
    vi.advanceTimersByTime(300);
    watchdog.pause();
    watchdog.pause();
    watchdog.resume();
    vi.advanceTimersByTime(399);
    expect(onExpire).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onExpire).toHaveBeenCalledOnce();
  });

  it("never expires if it is never resumed", () => {
    const onExpire = vi.fn();
    new Watchdog(1_000, onExpire).pause();
    vi.advanceTimersByTime(60_000);
    expect(onExpire).not.toHaveBeenCalled();
  });
});
