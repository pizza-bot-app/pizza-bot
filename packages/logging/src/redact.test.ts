import { describe, expect, it } from "vitest";
import { createRedactor } from "./redact.js";

describe("redaction", () => {
  it("redacts sensitive keys, bearer values, URL credentials, and known secrets", () => {
    const redact = createRedactor(["exact-secret"]);
    expect(
      redact.value({
        apiKey: "abc",
        webhookSecret: "hook-value",
        nested: {
          authorization: "Bearer raw-token",
          safe: "token=another https://x.test/?access_token=query exact-secret",
        },
      }),
    ).toEqual({
      apiKey: "<redacted>",
      webhookSecret: "<redacted>",
      nested: {
        authorization: "<redacted>",
        safe: "token=<redacted> https://x.test/?access_token=<redacted> <redacted>",
      },
    });
  });

  it("serializes errors without leaking secrets", () => {
    const redact = createRedactor(["hidden-value"]);
    const error = new Error("failed with Bearer abc123 and hidden-value");
    (error as Error & { code: string }).code = "E_AUTH";
    expect(redact.error(error)).toMatchObject({
      name: "Error",
      message: "failed with Bearer <redacted> and <redacted>",
      code: "E_AUTH",
    });
  });

  it("bounds cyclic and binary values", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(createRedactor().value({ cyclic, bytes: new Uint8Array(8) })).toEqual({
      cyclic: { self: "<circular>" },
      bytes: "<binary:8 bytes>",
    });
  });
});
