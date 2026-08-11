import { describe, expect, it } from "vitest";
import {
  BoundedRetention,
  nativeNotificationCopy,
  nativeNotificationEnabled,
  type NativeNotificationRequest,
} from "./native-notifications.js";

const backgroundContext = {
  windowFocused: false,
  activeThreadId: null,
};

describe("native notifications", () => {
  it("builds concise platform copy for each notification kind", () => {
    expect(
      nativeNotificationCopy({
        kind: "run-complete",
        threadId: "thread-1",
        threadTitle: "  Daily   digest  ",
      }),
    ).toEqual({
      title: "Run finished",
      body: "Daily digest has finished.",
    });
    expect(
      nativeNotificationCopy({
        kind: "action-required",
        threadId: "thread-1",
        threadTitle: "Send report",
      }),
    ).toEqual({
      title: "Action required",
      body: "Send report is waiting for your input.",
    });
    expect(
      nativeNotificationCopy({
        kind: "run-failed",
        reason: "error",
        threadId: "thread-1",
        threadTitle: "Send report",
      }),
    ).toEqual({
      title: "Run failed",
      body: "Send report stopped before finishing.",
    });
    expect(
      nativeNotificationCopy({
        kind: "run-failed",
        reason: "timeout",
        threadId: "thread-1",
        threadTitle: "Send report",
      }),
    ).toEqual({
      title: "Run timed out",
      body: "Send report did not finish in time.",
    });
  });

  it("bounds long Unicode thread titles", () => {
    const copy = nativeNotificationCopy({
      kind: "run-complete",
      threadId: "thread-1",
      threadTitle: "🍕".repeat(80),
    });

    expect(Array.from(copy.body).length).toBeLessThan(80);
    expect(copy.body).toContain("...");
  });

  it("applies the finished-run preference to failures and timeouts", () => {
    const disabled = {
      notifyOnRunCompletion: false,
      notifyOnActionRequired: true,
    };
    expect(
      nativeNotificationEnabled(
        {
          kind: "run-failed",
          reason: "error",
          threadId: "thread-1",
          threadTitle: "Research",
        },
        disabled,
        backgroundContext,
      ),
    ).toBe(false);
    expect(
      nativeNotificationEnabled(
        {
          kind: "action-required",
          threadId: "thread-1",
          threadTitle: "Research",
        },
        disabled,
        backgroundContext,
      ),
    ).toBe(true);
  });

  it("suppresses every notification kind for the focused active thread", () => {
    const requests: NativeNotificationRequest[] = [
      {
        kind: "run-complete",
        threadId: "thread-1",
        threadTitle: "Research",
      },
      {
        kind: "run-failed",
        reason: "timeout",
        threadId: "thread-1",
        threadTitle: "Research",
      },
      {
        kind: "action-required",
        threadId: "thread-1",
        threadTitle: "Research",
      },
    ];
    const preferences = {
      notifyOnRunCompletion: true,
      notifyOnActionRequired: true,
    };

    for (const request of requests) {
      expect(
        nativeNotificationEnabled(request, preferences, {
          windowFocused: true,
          activeThreadId: "thread-1",
        }),
      ).toBe(false);
    }
  });

  it("keeps notifications enabled outside the focused active thread", () => {
    const request: NativeNotificationRequest = {
      kind: "run-complete",
      threadId: "thread-1",
      threadTitle: "Research",
    };
    const preferences = {
      notifyOnRunCompletion: true,
      notifyOnActionRequired: true,
    };

    expect(
      nativeNotificationEnabled(request, preferences, {
        windowFocused: false,
        activeThreadId: "thread-1",
      }),
    ).toBe(true);
    expect(
      nativeNotificationEnabled(request, preferences, {
        windowFocused: true,
        activeThreadId: "thread-2",
      }),
    ).toBe(true);
    expect(
      nativeNotificationEnabled(request, preferences, {
        windowFocused: true,
        activeThreadId: null,
      }),
    ).toBe(true);
  });

  it("bounds retained notification objects and supports idempotent release", () => {
    const retained = new BoundedRetention<object>(2);
    const first = {};
    const releaseFirst = retained.retain(first);
    retained.retain({});
    const releaseLatest = retained.retain({});

    expect(retained.size).toBe(2);
    releaseFirst();
    releaseFirst();
    expect(retained.size).toBe(2);
    releaseLatest();
    expect(retained.size).toBe(1);
  });
});
