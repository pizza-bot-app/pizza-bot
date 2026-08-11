import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveApiBase, resolveApiHeaders } from "./api-config.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("browser API runtime configuration", () => {
  it("reads a deploy-time API token without putting it in the URL", () => {
    vi.stubGlobal("window", {
      location: { origin: "https://app.example" },
      __PIZZA_CONFIG__: {
        apiBase: "https://api.example",
        apiToken: " browser-secret ",
      },
    });

    expect(resolveApiBase()).toBe("https://api.example");
    expect(resolveApiHeaders()).toEqual({ authorization: "Bearer browser-secret" });
  });

  it("prefers Electron preload credentials over browser runtime configuration", () => {
    vi.stubGlobal("window", {
      location: { origin: "file://" },
      __PIZZA_API_TOKEN__: "sidecar-secret",
      __PIZZA_CONFIG__: { apiToken: "browser-secret" },
    });

    expect(resolveApiHeaders()).toEqual({ authorization: "Bearer sidecar-secret" });
  });

  it("omits authorization when no non-empty token is configured", () => {
    vi.stubGlobal("window", {
      location: { origin: "https://app.example" },
      __PIZZA_CONFIG__: { apiToken: "  " },
    });

    expect(resolveApiHeaders()).toEqual({});
  });
});
