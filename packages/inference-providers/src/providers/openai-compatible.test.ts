import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HumanMessage } from "@langchain/core/messages";
import { ModelsDevCatalogLoader } from "../models-dev.js";
import { catalogHttpError } from "../catalog-error.js";
import { OpenAiCompatibleProvider, type OpenAiCompatibleSpec } from "./openai-compatible.js";

const SPEC: OpenAiCompatibleSpec = {
  id: "gateway",
  label: "Gateway",
  defaultBaseUrl: "https://gateway.example/v1",
  envPrefix: "GATEWAY",
};

const noModelsDev = new ModelsDevCatalogLoader({
  fetch: async () => new Response("{}", { status: 200 }),
});

function chatReply(): Response {
  return new Response(JSON.stringify({
    id: "chatcmpl-1",
    model: "m",
    choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  }), { status: 200, headers: { "content-type": "application/json" } });
}

function catalogFetch(catalogs: Record<string, unknown>) {
  return vi.fn(async (input: Parameters<typeof fetch>[0]) => {
    const body = catalogs[String(input)];
    return body === undefined
      ? new Response("not found", { status: 404 })
      : new Response(JSON.stringify(body), { status: 200 });
  });
}

beforeEach(() => {
  vi.stubEnv("GATEWAY_API_KEY", "");
  vi.stubEnv("GATEWAY_BASE_URL", "");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("OpenAiCompatibleProvider", () => {
  it("reads common listing fields with the default reader", async () => {
    const fetchFn = vi.fn(async () => new Response(JSON.stringify({
      data: [
        {
          id: "vendor/chat",
          context_length: 200_000,
          max_output_tokens: 32_000,
          supports_tools: true,
          supports_vision: false,
        },
        { id: "bare" },
        { id: "vendor/chat" },
      ],
    }), { status: 200 }));
    const provider = new OpenAiCompatibleProvider(SPEC, {
      apiKey: "k",
      fetch: fetchFn,
      modelsDev: noModelsDev,
    });

    await expect(provider.listModels()).resolves.toEqual([
      {
        id: "vendor/chat",
        provider: "gateway",
        displayName: "vendor/chat (Gateway)",
        contextWindow: 200_000,
        maxOutputTokens: 32_000,
        supportsTools: true,
        supportsVision: false,
      },
      { id: "bare", provider: "gateway", displayName: "bare (Gateway)" },
    ]);
  });

  it("lists featured models first and survives a failed featured listing", async () => {
    const spec: OpenAiCompatibleSpec = {
      ...SPEC,
      featuredModelsPath: "/models/featured",
      readModel: (entry, featured) =>
        typeof entry.id === "string"
          ? { id: entry.id, ...(featured ? { label: "Gateway featured" } : {}) }
          : undefined,
    };
    const catalog = { data: [{ id: "a" }, { id: "b" }] };
    const withFeatured = new OpenAiCompatibleProvider(spec, {
      apiKey: "k",
      modelsDev: noModelsDev,
      fetch: catalogFetch({
        "https://gateway.example/v1/models/featured": { data: [{ id: "b" }] },
        "https://gateway.example/v1/models": catalog,
      }),
    });
    const withoutFeatured = new OpenAiCompatibleProvider(spec, {
      apiKey: "k",
      modelsDev: noModelsDev,
      fetch: catalogFetch({ "https://gateway.example/v1/models": catalog }),
    });

    expect((await withFeatured.listModels()).map((m) => m.displayName)).toEqual([
      "b (Gateway featured)",
      "a (Gateway)",
    ]);
    expect((await withoutFeatured.listModels()).map((m) => m.id)).toEqual(["a", "b"]);
  });

  it("reports rejected and missing credentials as catalog errors", async () => {
    const fetchFn = vi.fn(async () => new Response("forbidden", { status: 403 }));
    const rejected = new OpenAiCompatibleProvider(SPEC, { apiKey: "bad", fetch: fetchFn });
    const missing = new OpenAiCompatibleProvider(SPEC, { fetch: fetchFn });

    await expect(rejected.listModels()).rejects.toMatchObject({
      name: "ModelCatalogError",
      code: "authentication",
      retryable: false,
    });
    fetchFn.mockClear();
    await expect(missing.listModels()).rejects.toMatchObject({
      name: "ModelCatalogError",
      code: "credentials",
    });
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("caps output at the model's advertised limit and keeps its context window", async () => {
    const provider = new OpenAiCompatibleProvider(SPEC, {
      apiKey: "k",
      maxTokens: 32_000,
      models: [{
        id: "m",
        provider: "gateway",
        displayName: "m (Gateway)",
        contextWindow: 200_000,
        maxOutputTokens: 16_000,
      }],
    });

    const model = await provider.buildModel("m");

    expect(model).toMatchObject({ model: "m", apiKey: "k", maxTokens: 16_000 });
    expect(model._llmType()).toBe("openai");
    expect(model.profile.maxInputTokens).toBe(200_000);
  });

  it("drops cached descriptors when the configuration changes", async () => {
    const provider = new OpenAiCompatibleProvider(SPEC, {
      apiKey: "k",
      modelsDev: noModelsDev,
      fetch: catalogFetch({
        "https://gateway.example/v1/models": { data: [{ id: "m", max_output_tokens: 4_096 }] },
        "https://other.example/v1/models": { data: [] },
      }),
    });
    await provider.listModels();
    expect(await provider.buildModel("m")).toMatchObject({ maxTokens: 4_096 });

    provider.configure({
      method: "api-key",
      values: { apiKey: "k", baseUrl: "https://other.example/v1" },
    });

    expect(await provider.buildModel("m")).toMatchObject({ maxTokens: 8_192 });
  });

  it("names the spec's env variable when no key is configured", async () => {
    const provider = new OpenAiCompatibleProvider(SPEC);

    await expect(provider.buildModel("m")).rejects.toMatchObject({
      code: "AUTH_EXPIRED",
      message: "No Gateway API key configured (set GATEWAY_API_KEY).",
    });
  });

  it("falls back to the spec's env key and base URL when settings leave them blank", async () => {
    vi.stubEnv("GATEWAY_API_KEY", "env-key");
    vi.stubEnv("GATEWAY_BASE_URL", "https://env-gateway.example/v1/");
    const fetchFn = vi.fn(async () => new Response(JSON.stringify({ data: [] }), { status: 200 }));
    const provider = new OpenAiCompatibleProvider(SPEC, {
      baseUrl: "https://custom.example/v1",
      fetch: fetchFn,
      modelsDev: noModelsDev,
    });

    provider.configure({ method: "api-key", values: { apiKey: "", baseUrl: "" } });
    await provider.listModels();

    expect(fetchFn).toHaveBeenCalledWith(
      "https://env-gateway.example/v1/models",
      expect.objectContaining({ headers: { authorization: "Bearer env-key" } }),
    );
  });

  it("merges request overrides into the chat request body", async () => {
    const fetchFn = vi.fn(async (
      _input: Parameters<typeof fetch>[0],
      _init?: Parameters<typeof fetch>[1],
    ) => chatReply());
    const provider = new OpenAiCompatibleProvider(SPEC, {
      apiKey: "k",
      fetch: fetchFn,
      models: [{ id: "m", provider: "gateway", displayName: "m (Gateway)" }],
    });
    provider.configure({
      method: "api-key",
      values: { apiKey: "k", requestOverrides: '{"service_tier":"flex","temperature":0.2}' },
    });

    await (await provider.buildModel("m")).invoke([new HumanMessage("hi")]);

    const body = JSON.parse(String(fetchFn.mock.calls[0]?.[1]?.body)) as Record<string, unknown>;
    expect(body).toMatchObject({ model: "m", service_tier: "flex", temperature: 0.2 });
  });

  it("rejects invalid overrides without changing the live configuration", async () => {
    const provider = new OpenAiCompatibleProvider(SPEC, {
      apiKey: "k",
      models: [{ id: "m", provider: "gateway", displayName: "m (Gateway)" }],
    });

    expect(() => provider.configure({
      method: "api-key",
      values: { apiKey: "other", maxTokens: "10", requestOverrides: '{"stream":false}' },
    })).toThrow('cannot set "stream"');
    expect(await provider.buildModel("m")).toMatchObject({ apiKey: "k", maxTokens: 8_192 });
  });

  it("offers the overrides field in the settings form", () => {
    const provider = new OpenAiCompatibleProvider(SPEC);

    expect(provider.authSchema[0]?.fields.map((field) => [field.key, field.type])).toEqual([
      ["apiKey", "password"],
      ["maxTokens", "text"],
      ["baseUrl", "text"],
      ["requestOverrides", "json"],
    ]);
  });

  it("marks the key optional when the spec allows keyless access", () => {
    const provider = new OpenAiCompatibleProvider({ ...SPEC, keyOptional: true });

    expect(provider.authSchema[0]?.fields.find((field) => field.key === "apiKey")?.required).toBe(false);
  });

  describe("with an optional key", () => {
    const KEYLESS: OpenAiCompatibleSpec = { ...SPEC, keyOptional: true };

    it("lists and chats without an Authorization header or the OPENAI_API_KEY fallback", async () => {
      vi.stubEnv("OPENAI_API_KEY", "sk-real-openai-key");
      const fetchFn = vi.fn(async (input: Parameters<typeof fetch>[0], _init?: RequestInit) =>
        String(input).endsWith("/models")
          ? new Response(JSON.stringify({ data: [{ id: "m" }] }), { status: 200 })
          : chatReply());
      const provider = new OpenAiCompatibleProvider(KEYLESS, { fetch: fetchFn, modelsDev: noModelsDev });
      provider.configure({ method: "api-key", values: {} });

      await expect(provider.listModels()).resolves.toHaveLength(1);
      await (await provider.buildModel("m")).invoke([new HumanMessage("hi")]);

      const [listing, chat] = fetchFn.mock.calls;
      expect(listing?.[1]?.headers).toBeUndefined();
      expect(String(chat?.[0])).toBe("https://gateway.example/v1/chat/completions");
      expect(new Headers(chat?.[1]?.headers).get("authorization")).toBeNull();
    });

    it("does not probe the default URL until the provider is set up", async () => {
      const fetchFn = vi.fn(async () => new Response(JSON.stringify({ data: [] }), { status: 200 }));
      const unconfigured = new OpenAiCompatibleProvider(KEYLESS, { fetch: fetchFn });

      await expect(unconfigured.listModels()).rejects.toMatchObject({ code: "credentials" });
      expect(fetchFn).not.toHaveBeenCalled();

      vi.stubEnv("GATEWAY_BASE_URL", "https://env-gateway.example/v1");
      await expect(unconfigured.listModels()).resolves.toEqual([]);
      expect(fetchFn).toHaveBeenCalledTimes(1);
    });

    it("clears a stored key when the saved config leaves it blank", async () => {
      const fetchFn = vi.fn(async (_input: Parameters<typeof fetch>[0], _init?: RequestInit) =>
        new Response(JSON.stringify({ data: [] }), { status: 200 }));
      const provider = new OpenAiCompatibleProvider(KEYLESS, {
        apiKey: "old",
        fetch: fetchFn,
        modelsDev: noModelsDev,
      });

      provider.configure({ method: "api-key", values: { apiKey: " " } });
      await provider.listModels();

      expect(fetchFn.mock.calls[0]?.[1]).not.toHaveProperty("headers");
    });
  });

  describe("with a custom discovery hook", () => {
    it("dedupes the hook's models and authenticates its listing requests", async () => {
      const fetchFn = catalogFetch({ "https://gateway.example/v1/catalog": { data: [{ name: "a" }] } });
      const provider = new OpenAiCompatibleProvider({
        ...SPEC,
        async discoverModels(fetchListing) {
          const entries = await fetchListing("/catalog");
          return [...entries, ...entries].map((entry) => ({ id: String(entry.name), label: "Custom" }));
        },
      }, { apiKey: "k", fetch: fetchFn, modelsDev: noModelsDev });

      await expect(provider.listModels()).resolves.toEqual([
        { id: "a", provider: "gateway", displayName: "a (Custom)" },
      ]);
      expect(fetchFn).toHaveBeenCalledTimes(1);
      expect(fetchFn).toHaveBeenCalledWith(
        "https://gateway.example/v1/catalog",
        expect.objectContaining({ headers: { authorization: "Bearer k" } }),
      );
    });

    it("surfaces a catalog error the hook throws", async () => {
      const provider = new OpenAiCompatibleProvider({
        ...SPEC,
        discoverModels: async () => {
          throw catalogHttpError("Gateway", 401);
        },
      }, { apiKey: "k", modelsDev: noModelsDev });

      await expect(provider.listModels()).rejects.toMatchObject({ code: "authentication" });
    });
  });
});
