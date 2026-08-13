import { describe, expect, it } from "vitest";
import {
  applySidecarSecretUpdate,
  isDesktopSecretName,
  isSidecarSecretUpdate,
  isSidecarSecretUpdateResult,
  type SidecarSecretUpdate,
} from "./sidecar-ipc.js";

describe("sidecar secret IPC", () => {
  it("accepts only desktop-owned secret names", () => {
    expect(isDesktopSecretName("PIZZA_SECRET_OPENAI_APIKEY")).toBe(true);
    expect(isDesktopSecretName("OPENAI_API_KEY")).toBe(false);
    expect(isDesktopSecretName("PIZZA_API_TOKEN")).toBe(false);
  });

  it("validates update and acknowledgement messages", () => {
    expect(
      isSidecarSecretUpdate({
        type: "secrets.update",
        requestId: 1,
        values: {
          PIZZA_SECRET_OPENAI_APIKEY: "secret",
          PIZZA_SECRET_OLD_KEY: null,
        },
      }),
    ).toBe(true);
    expect(
      isSidecarSecretUpdate({
        type: "secrets.update",
        requestId: 1,
        values: { PATH: "untrusted" },
      }),
    ).toBe(false);
    expect(
      isSidecarSecretUpdateResult({
        type: "secrets.updated",
        requestId: 1,
        ok: true,
      }),
    ).toBe(true);
  });

  it("applies additions and removals without retaining plaintext elsewhere", () => {
    const env: NodeJS.ProcessEnv = {
      PIZZA_SECRET_OLD_KEY: "old",
      FIXED_VALUE: "unchanged",
    };
    const update: SidecarSecretUpdate = {
      type: "secrets.update",
      requestId: 1,
      values: {
        PIZZA_SECRET_OPENAI_APIKEY: "new",
        PIZZA_SECRET_OLD_KEY: null,
      },
    };

    applySidecarSecretUpdate(update, env);

    expect(env).toEqual({
      PIZZA_SECRET_OPENAI_APIKEY: "new",
      FIXED_VALUE: "unchanged",
    });
  });
});
