import { describe, expect, it, vi } from "vitest";
import { probeRemoteConnection } from "./connection-probe.js";

const origin = "null";

function response(
  body: unknown,
  init: ResponseInit = {},
): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: {
      "content-type": "application/json",
      "access-control-allow-origin": origin,
    },
    ...init,
  });
}

describe("probeRemoteConnection", () => {
  it("sends bearer auth and validates the API identity", async () => {
    const doFetch = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) =>
      response({ service: "pizza-bot", apiVersion: "1" }),
    );

    await expect(
      probeRemoteConnection({
        remoteUrl: "https://pizza.example/",
        token: "secret",
        origin,
        expectedApiVersion: "1",
        fetch: doFetch,
      }),
    ).resolves.toEqual({ remoteUrl: "https://pizza.example", apiVersion: "1" });
    expect(doFetch).toHaveBeenCalledWith(
      "https://pizza.example/",
      expect.objectContaining({
        headers: { origin, authorization: "Bearer secret" },
      }),
    );
  });

  it("reports authentication and origin failures clearly", async () => {
    await expect(
      probeRemoteConnection({
        remoteUrl: "https://pizza.example",
        origin,
        expectedApiVersion: "1",
        fetch: async () => response({}, { status: 401 }),
      }),
    ).rejects.toThrow(/bearer token/i);

    await expect(
      probeRemoteConnection({
        remoteUrl: "https://pizza.example",
        origin,
        expectedApiVersion: "1",
        fetch: async () => response({}, { headers: {} }),
      }),
    ).rejects.toThrow(/desktop origin/i);
  });

  it("rejects non-Pizza Bot and incompatible APIs", async () => {
    await expect(
      probeRemoteConnection({
        remoteUrl: "https://pizza.example",
        origin,
        expectedApiVersion: "1",
        fetch: async () => response({ service: "other", apiVersion: "1" }),
      }),
    ).rejects.toThrow(/compatible Pizza Bot/i);

    await expect(
      probeRemoteConnection({
        remoteUrl: "https://pizza.example",
        origin,
        expectedApiVersion: "1",
        fetch: async () => response({ service: "pizza-bot", apiVersion: "2" }),
      }),
    ).rejects.toThrow(/API version 2/i);
  });
});
