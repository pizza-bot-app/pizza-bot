import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HumanMessage } from "@langchain/core/messages";
import { TrustedRouterLangChainModelProvider } from "./trustedrouter.js";

beforeEach(() => {
  vi.stubEnv("TRUSTEDROUTER_API_KEY", "");
  vi.stubEnv("TRUSTEDROUTER_BASE_URL", "");
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

function catalogFetch(catalogs: Record<string, unknown>) {
  return vi.fn(async (input: Parameters<typeof fetch>[0]) => {
    const body = catalogs[String(input)];
    return body === undefined
      ? new Response("not found", { status: 404 })
      : new Response(JSON.stringify(body), { status: 200 });
  });
}

describe("TrustedRouter model discovery", () => {
  it("lists public chat models and presets while filtering internal, hidden, synthetic, and non-chat rows", async () => {
    const fetchFn = catalogFetch({
      "https://trustedrouter.example/v1/models": {
        object: "list",
        data: [
          {
            id: "trustedrouter/zdr",
            context_length: 1_048_576,
            top_provider: { context_length: 1_048_576, max_completion_tokens: null },
            architecture: { input_modalities: ["text", "image"] },
            supported_parameters: ["tools", "tool_choice", "max_tokens"],
            trustedrouter: {
              internal_only: false,
              configuration_hidden: false,
              synthetic_monitor: false,
              supports_chat: true,
            },
          },
          {
            id: "deepseek/deepseek-v4-flash",
            context_length: 1_048_576,
            top_provider: { context_length: 1_048_576, max_completion_tokens: 393_216 },
            architecture: { input_modalities: ["text"] },
            supported_parameters: ["tools", "max_tokens"],
            trustedrouter: {
              internal_only: false,
              configuration_hidden: false,
              synthetic_monitor: false,
              supports_chat: true,
            },
          },
          { id: "nyte/zdr" },
          { id: "deepseek/deepseek-v4-flash", trustedrouter: { supports_chat: true } },
          {
            id: "trustedrouter/athena-1.0",
            trustedrouter: { configuration_hidden: true, supports_chat: true },
          },
          {
            id: "internal/canary",
            trustedrouter: { internal_only: true, supports_chat: true },
          },
          {
            id: "monitor/probe",
            trustedrouter: { synthetic_monitor: true, supports_chat: true },
          },
          {
            id: "flat/hidden",
            configuration_hidden: true,
          },
          {
            id: "openai/text-embedding-3-large",
            trustedrouter: { supports_chat: false, supports_embeddings: true },
          },
        ],
      },
    });
    const provider = new TrustedRouterLangChainModelProvider({
      apiKey: "test-key",
      baseUrl: "https://trustedrouter.example/v1/",
      fetch: fetchFn,
    });

    await expect(provider.listModels()).resolves.toEqual([
      {
        id: "trustedrouter/zdr",
        provider: "trustedrouter",
        displayName: "trustedrouter/zdr (TrustedRouter)",
        contextWindow: 1_048_576,
        supportsTools: true,
        supportsVision: true,
      },
      {
        id: "deepseek/deepseek-v4-flash",
        provider: "trustedrouter",
        displayName: "deepseek/deepseek-v4-flash (TrustedRouter)",
        contextWindow: 1_048_576,
        maxOutputTokens: 393_216,
        supportsTools: true,
        supportsVision: false,
      },
      {
        id: "nyte/zdr",
        provider: "trustedrouter",
        displayName: "nyte/zdr (TrustedRouter)",
      },
    ]);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(fetchFn).toHaveBeenCalledWith(
      "https://trustedrouter.example/v1/models",
      expect.objectContaining({
        headers: { authorization: "Bearer test-key" },
      }),
    );
  });

  it("uses the default endpoint when no override is configured", async () => {
    const fetchFn = vi.fn(async () => Response.json({ data: [] }));
    const provider = new TrustedRouterLangChainModelProvider({ apiKey: "test-key", fetch: fetchFn });

    provider.configure({ method: "api-key", values: { apiKey: "test-key" } });
    await provider.listModels();

    expect(fetchFn).toHaveBeenCalledWith(
      "https://api.trustedrouter.com/v1/models",
      expect.any(Object),
    );
  });

  it("merges min_privacy from Advanced request JSON into outgoing chat requests", async () => {
    const fetchFn = vi.fn(async (
      _input: Parameters<typeof fetch>[0],
      _init?: Parameters<typeof fetch>[1],
    ) => new Response(JSON.stringify({
      id: "chatcmpl-tr-1",
      model: "deepseek/deepseek-v4-flash",
      choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    }), { status: 200, headers: { "content-type": "application/json" } }));

    const provider = new TrustedRouterLangChainModelProvider({
      apiKey: "tr-test-key",
      fetch: fetchFn,
      models: [{
        id: "deepseek/deepseek-v4-flash",
        provider: "trustedrouter",
        displayName: "deepseek/deepseek-v4-flash (TrustedRouter)",
      }],
    });
    provider.configure({
      method: "api-key",
      values: { apiKey: "tr-test-key", requestOverrides: '{"min_privacy":2}' },
    });

    await (await provider.buildModel("deepseek/deepseek-v4-flash")).invoke([new HumanMessage("hi")]);

    expect(String(fetchFn.mock.calls[0]?.[0])).toBe("https://api.trustedrouter.com/v1/chat/completions");
    const body = JSON.parse(String(fetchFn.mock.calls[0]?.[1]?.body)) as Record<string, unknown>;
    expect(body).toMatchObject({ model: "deepseek/deepseek-v4-flash", min_privacy: 2 });
  });
});
