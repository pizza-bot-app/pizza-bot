import { describe, expect, it } from "vitest";
import { SystemMessage } from "@langchain/core/messages";
import {
  currentDateTimeContext,
  currentDateTimeMiddleware,
} from "./current-date-time-middleware.js";

describe("currentDateTimeMiddleware", () => {
  it("formats local and absolute time at minute precision", () => {
    expect(
      currentDateTimeContext(
        new Date("2026-08-07T16:34:56.789Z"),
        "America/Los_Angeles",
      ),
    ).toBe(
      "Current date and time: Friday, August 7, 2026 at 9:34 AM PDT " +
        "(America/Los_Angeles; 2026-08-07T16:34:00.000Z). " +
        "Treat this runtime-provided timestamp as authoritative for relative dates " +
        'such as "today" and do not infer the current date from training-data cutoffs.',
    );
  });

  it("refreshes the transient system context on every model call", async () => {
    const times = [
      new Date("2026-08-07T16:34:00.000Z"),
      new Date("2026-08-07T16:35:00.000Z"),
    ];
    const middleware = currentDateTimeMiddleware({
      now: () => times.shift()!,
      timeZone: "America/Los_Angeles",
    }) as unknown as {
      wrapModelCall: (
        request: { systemMessage: SystemMessage },
        handler: (request: { systemMessage: SystemMessage }) => Promise<SystemMessage>,
      ) => Promise<SystemMessage>;
    };

    const invoke = () =>
      middleware.wrapModelCall(
        { systemMessage: new SystemMessage("Base prompt.") },
        async (request) => request.systemMessage,
      );

    await expect(invoke()).resolves.toHaveProperty(
      "text",
      expect.stringContaining("9:34 AM PDT"),
    );
    await expect(invoke()).resolves.toHaveProperty(
      "text",
      expect.stringContaining("9:35 AM PDT"),
    );
  });
});
