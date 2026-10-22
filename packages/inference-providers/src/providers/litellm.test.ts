import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HumanMessage } from "@langchain/core/messages";
import { LiteLLMLangChainModelProvider } from "./litellm.js";

beforeEach(() => {
  vi.stubEnv("LITELLM_BASE_URL", "");
  vi.stubEnv("LITELLM_API_KEY", "");
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

function catalogFetch(catalogs: Record<string, unknown>) {
  return vi.fn(async (input: Parameters<typeof fetch>[0], _init?: RequestInit) => {
    const body = catalogs[String(input)];
    return body === undefined
      ? new Response("not found", { status: 404 })
      : new Response(JSON.stringify(body), { status: 200 });
  });
}

const MODEL_INFO = {
  data: [
    {
      model_name: "claude-sonnet",
      model_info: {
        mode: "chat",
        max_input_tokens: 200_000,
        max_output_tokens: 64_000,
        supports_function_calling: true,
        supports_vision: true,
      },
    },
    // A second deployment behind the same alias is listed once.
    { model_name: "claude-sonnet", model_info: { mode: "chat" } },
    {
      model_name: "bedrock-llama",
      model_info: { mode: "chat", max_tokens: 8_192, supports_function_calling: false },
    },
    { model_name: "emb-small", model_info: { mode: "embedding" } },
    { model_name: "imagen", model_info: { mode: "image_generation" } },
  ],
};

describe("LiteLLM model discovery", () => {
  it("lists chat models with the limits and capabilities from /model/info", async () => {
    const fetchFn = catalogFetch({ "https://litellm.example/v1/model/info": MODEL_INFO });
    const provider = new LiteLLMLangChainModelProvider({
      apiKey: "sk-virtual",
      baseUrl: "https://litellm.example/v1/",
      fetch: fetchFn,
    });

    await expect(provider.listModels()).resolves.toEqual([
      {
        id: "claude-sonnet",
        provider: "litellm",
        displayName: "claude-sonnet (LiteLLM)",
        contextWindow: 200_000,
        maxOutputTokens: 64_000,
        supportsTools: true,
        supportsVision: true,
      },
      {
        id: "bedrock-llama",
        provider: "litellm",
        displayName: "bedrock-llama (LiteLLM)",
        maxOutputTokens: 8_192,
        supportsTools: false,
      },
    ]);
    expect(fetchFn).toHaveBeenCalledWith(
      "https://litellm.example/v1/model/info",
      expect.objectContaining({ headers: { authorization: "Bearer sk-virtual" } }),
    );
  });

  it("sends no Authorization header to a proxy without a master key", async () => {
    const fetchFn = catalogFetch({ "http://localhost:4000/v1/model/info": MODEL_INFO });
    const provider = new LiteLLMLangChainModelProvider({ fetch: fetchFn });

    await provider.listModels();
    const init = fetchFn.mock.calls[0]?.[1] as RequestInit | undefined;
    expect(fetchFn.mock.calls[0]?.[0]).toBe("http://localhost:4000/v1/model/info");
    expect(init?.headers).toBeUndefined();
  });

  it("falls back to /models when /model/info is unavailable", async () => {
    const fetchFn = catalogFetch({
      "https://litellm.example/v1/models": { data: [{ id: "gpt-4o-mini" }, { id: "claude-sonnet" }] },
    });
    const provider = new LiteLLMLangChainModelProvider({
      baseUrl: "https://litellm.example/v1",
      fetch: fetchFn,
    });

    await expect(provider.listModels()).resolves.toEqual([
      { id: "gpt-4o-mini", provider: "litellm", displayName: "gpt-4o-mini (LiteLLM)" },
      { id: "claude-sonnet", provider: "litellm", displayName: "claude-sonnet (LiteLLM)" },
    ]);
  });

  it("surfaces a rejected key instead of falling back", async () => {
    const fetchFn = vi.fn(async () => new Response("unauthorized", { status: 401 }));
    const provider = new LiteLLMLangChainModelProvider({ apiKey: "sk-wrong", fetch: fetchFn });

    await expect(provider.listModels()).rejects.toMatchObject({ code: "authentication" });
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("reads the base URL and key from LITELLM_BASE_URL and LITELLM_API_KEY", async () => {
    vi.stubEnv("LITELLM_BASE_URL", "https://env-proxy.example/v1");
    vi.stubEnv("LITELLM_API_KEY", "sk-env");
    const fetchFn = catalogFetch({ "https://env-proxy.example/v1/model/info": MODEL_INFO });
    const provider = new LiteLLMLangChainModelProvider({ fetch: fetchFn });

    await provider.listModels();
    expect(fetchFn).toHaveBeenCalledWith(
      "https://env-proxy.example/v1/model/info",
      expect.objectContaining({ headers: { authorization: "Bearer sk-env" } }),
    );
  });

  it("clears a stored key when the saved config leaves it blank", () => {
    const provider = new LiteLLMLangChainModelProvider({ apiKey: "sk-old" });
    provider.configure({ method: "api-key", values: { baseUrl: "https://p.example/v1", apiKey: " " } });
    expect((provider as unknown as { apiKey?: string }).apiKey).toBeUndefined();
  });
});

describe("LiteLLM chat model", () => {
  function chatCompletion(content: string) {
    return {
      id: "chatcmpl-1",
      object: "chat.completion",
      created: 0,
      model: "claude-sonnet",
      choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
      usage: { prompt_tokens: 5, completion_tokens: 1, total_tokens: 6 },
    };
  }

  it("calls the proxy without credentials when no key is configured", async () => {
    vi.stubEnv("OPENAI_API_KEY", "sk-real-openai-key");
    const seen: { url: string; headers: Headers; body: Record<string, unknown> }[] = [];
    const fetchFn = vi.fn(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/model/info")) return new Response(JSON.stringify(MODEL_INFO));
      seen.push({ url, headers: new Headers(init?.headers), body: JSON.parse(String(init?.body)) });
      return new Response(JSON.stringify(chatCompletion("pong")), {
        headers: { "content-type": "application/json" },
      });
    });
    const provider = new LiteLLMLangChainModelProvider({ fetch: fetchFn });

    const model = await provider.buildModel("claude-sonnet");
    const result = await model.invoke([new HumanMessage("ping")]);

    expect(result.content).toBe("pong");
    expect(seen[0]?.url).toBe("http://localhost:4000/v1/chat/completions");
    expect(seen[0]?.body.model).toBe("claude-sonnet");
    // Neither a placeholder nor the user's OPENAI_API_KEY reaches the proxy.
    expect(seen[0]?.headers.get("authorization")).toBeNull();
  });

  it("sends the virtual key and caps output tokens at the model limit", async () => {
    const seen: { headers: Headers; body: Record<string, unknown> }[] = [];
    const fetchFn = vi.fn(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      if (String(input).endsWith("/model/info")) return new Response(JSON.stringify(MODEL_INFO));
      seen.push({ headers: new Headers(init?.headers), body: JSON.parse(String(init?.body)) });
      return new Response(JSON.stringify(chatCompletion("ok")), {
        headers: { "content-type": "application/json" },
      });
    });
    const provider = new LiteLLMLangChainModelProvider({
      apiKey: "sk-virtual",
      maxTokens: 100_000,
      fetch: fetchFn,
    });

    const model = await provider.buildModel("claude-sonnet");
    await model.invoke([new HumanMessage("hi")]);

    expect(seen[0]?.headers.get("authorization")).toBe("Bearer sk-virtual");
    expect(seen[0]?.body.max_tokens ?? seen[0]?.body.max_completion_tokens).toBe(64_000);
  });
});
