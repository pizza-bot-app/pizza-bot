import { describe, it, expect } from "vitest";
import { classifyError } from "./classify-error.js";

describe("classifyError", () => {
  it("maps AWS credential/auth expiry to AUTH_EXPIRED", () => {
    expect(classifyError(new Error("The security token included in the request is expired"))).toBe(
      "AUTH_EXPIRED",
    );
    expect(classifyError(new Error("Your AWS session has expired, please reauthenticate"))).toBe(
      "AUTH_EXPIRED",
    );
    expect(classifyError({ name: "ExpiredTokenException", message: "token" })).toBe("AUTH_EXPIRED");
    expect(classifyError({ name: "UnrecognizedClientException", message: "bad key" })).toBe(
      "AUTH_EXPIRED",
    );
    expect(classifyError({ Code: "AccessDeniedException", message: "no" })).toBe("AUTH_EXPIRED");
  });

  it("maps Bedrock throttling / rate limits to RATE_LIMIT", () => {
    expect(classifyError({ name: "ThrottlingException", message: "slow down" })).toBe("RATE_LIMIT");
    expect(classifyError(new Error("Rate limit exceeded"))).toBe("RATE_LIMIT");
    expect(classifyError(new Error("HTTP 429 Too Many Requests"))).toBe("RATE_LIMIT");
  });

  it("maps context/prompt length overruns to CONTEXT_LENGTH", () => {
    expect(classifyError(new Error("Input is too long for requested model"))).toBe("CONTEXT_LENGTH");
    expect(classifyError(new Error("prompt is too long: 210000 tokens"))).toBe("CONTEXT_LENGTH");
    expect(classifyError(new Error("This model's maximum context length is 200000 tokens"))).toBe(
      "CONTEXT_LENGTH",
    );
    expect(
      classifyError(
        new Error(
          "400 request (43448 tokens) exceeds the available context size (32768 tokens)",
        ),
      ),
    ).toBe("CONTEXT_LENGTH");
  });

  it("maps timeouts to TIMEOUT", () => {
    expect(classifyError(new Error("Request timed out"))).toBe("TIMEOUT");
    expect(classifyError({ name: "TimeoutError", message: "ETIMEDOUT" })).toBe("TIMEOUT");
  });

  it("falls back to GENERAL for unrecognized errors", () => {
    expect(classifyError(new Error("something weird happened"))).toBe("GENERAL");
    expect(classifyError("plain string error")).toBe("GENERAL");
    expect(classifyError(undefined)).toBe("GENERAL");
    expect(classifyError({ unexpected: true })).toBe("GENERAL");
  });

  it("prioritizes auth over other categories when multiple keywords collide", () => {
    expect(classifyError(new Error("session has expired due to throttling"))).toBe("AUTH_EXPIRED");
  });

  it("honors a self-classified `code` over message matching", () => {
    expect(classifyError(Object.assign(new Error("something weird"), { code: "MODEL_UNAVAILABLE" }))).toBe(
      "MODEL_UNAVAILABLE",
    );
    expect(classifyError(Object.assign(new Error("rate limit exceeded"), { code: "bogus" }))).toBe(
      "RATE_LIMIT",
    );
  });
});
