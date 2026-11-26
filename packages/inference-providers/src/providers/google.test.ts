import { describe, expect, it, vi } from "vitest";
import {
  GoogleLangChainModelProvider,
  googleModelDescriptor,
  translateGoogleError,
} from "./google.js";

describe("Google Gemini model discovery", () => {
  it("paginates Google AI generateContent models and maps endpoint limits", async () => {
    const fetchFn = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        models: [
          {
            name: "models/gemini-2.5-flash",
            displayName: "Gemini 2.5 Flash",
            inputTokenLimit: 1_048_576,
            outputTokenLimit: 65_536,
            supportedGenerationMethods: ["generateContent", "countTokens"],
          },
          {
            name: "models/text-embedding-004",
            supportedGenerationMethods: ["embedContent"],
          },
        ],
        nextPageToken: "page-2",
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        models: [
          {
            name: "models/gemini-2.5-pro",
            displayName: "Gemini 2.5 Pro",
            inputTokenLimit: 1_048_576,
            outputTokenLimit: 65_536,
            supportedGenerationMethods: ["generateContent"],
          },
        ],
      }), { status: 200 }));
    const provider = new GoogleLangChainModelProvider({
      apiKey: "test-key",
      apiBase: "https://google.example/",
      fetch: fetchFn,
    });

    await expect(provider.listModels()).resolves.toEqual([
      {
        id: "gemini-2.5-flash",
        provider: "google",
        displayName: "Gemini 2.5 Flash (Google)",
        contextWindow: 1_048_576,
        maxOutputTokens: 65_536,
        supportsTools: true,
        supportsVision: true,
      },
      expect.objectContaining({ id: "gemini-2.5-pro" }),
    ]);
    expect(fetchFn).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        href: "https://google.example/v1beta/models?pageSize=1000",
      }),
      expect.objectContaining({ headers: { "x-goog-api-key": "test-key" } }),
    );
    expect(fetchFn).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        href: "https://google.example/v1beta/models?pageSize=1000&pageToken=page-2",
      }),
      expect.anything(),
    );
  });

  it("falls back to the advisory Vertex catalog when Google AI rejects the key", async () => {
    const fetchFn = vi.fn().mockResolvedValue(
      new Response("denied", { status: 403 }),
    );
    const modelsDevFetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      "google-vertex": {
        models: {
          "gemini-2.5-flash": {
            name: "Gemini 2.5 Flash",
            tool_call: true,
            modalities: { input: ["text", "image"], output: ["text"] },
            limit: { context: 1_048_576, output: 65_536 },
          },
          "claude-sonnet": {
            name: "Claude Sonnet",
            modalities: { input: ["text"], output: ["text"] },
          },
          "gemini-image-only": {
            name: "Gemini Image",
            modalities: { input: ["text"], output: ["image"] },
          },
          "gemini-embedding-001": {
            name: "Gemini Embedding 001",
            modalities: { input: ["text"], output: ["text"] },
          },
        },
      },
    }), { status: 200 }));
    const provider = new GoogleLangChainModelProvider({
      apiKey: "test-key",
      aiApiBase: "https://google-ai.example",
      fetch: fetchFn,
      modelsDevFetch,
    });

    await expect(provider.listModels()).resolves.toEqual([
      {
        id: "gemini-2.5-flash",
        provider: "google",
        displayName: "Gemini 2.5 Flash (Google)",
        contextWindow: 1_048_576,
        maxOutputTokens: 65_536,
        supportsTools: true,
        supportsVision: true,
      },
    ]);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(modelsDevFetch).toHaveBeenCalledWith(
      "https://models.dev/api.json",
      expect.anything(),
    );
  });

  it("uses a stable Vertex fallback model when metadata is unavailable", async () => {
    const provider = new GoogleLangChainModelProvider({
      apiKey: "test-key",
      platform: "gcp",
      fetch: vi.fn().mockResolvedValue(new Response("{}", { status: 200 })),
      modelsDevFetch: vi.fn().mockResolvedValue(new Response("", { status: 503 })),
    });

    await expect(provider.listModels()).resolves.toEqual([
      expect.objectContaining({
        id: "gemini-2.5-flash",
        provider: "google",
      }),
    ]);
  });

  it("reports missing credentials without calling discovery", async () => {
    const fetchFn = vi.fn();
    const provider = new GoogleLangChainModelProvider({
      apiKey: "",
      fetch: fetchFn,
    });

    await expect(provider.listModels()).rejects.toMatchObject({
      name: "ModelCatalogError",
      code: "credentials",
      retryable: false,
    });
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("caps generation at the configured or advertised output limit", async () => {
    const provider = new GoogleLangChainModelProvider({
      apiKey: "test-key",
      maxOutputTokens: 20_000,
      models: [{
        id: "gemini-test",
        provider: "google",
        displayName: "Gemini Test",
        contextWindow: 1_048_576,
        maxOutputTokens: 12_000,
      }],
    });

    const model = await provider.buildModel("gemini-test");
    expect(
      model.invocationParams({}).generationConfig.maxOutputTokens,
    ).toBe(12_000);
    expect(model.profile.maxInputTokens).toBe(1_048_576);
  });

  it("falls through to Vertex when Google AI lists models but cannot generate", async () => {
    const listing = () => new Response(JSON.stringify({
      models: [{ name: "models/gemini-flash-lite", supportedGenerationMethods: ["generateContent"] }],
    }), { status: 200 });
    const fetchFn = vi.fn().mockImplementation((input: URL | string, init?: RequestInit) =>
      init?.method === "POST"
        ? Promise.resolve(new Response(JSON.stringify({
            error: { message: "Requests to this API are blocked." },
          }), { status: 403 }))
        : Promise.resolve(listing()));
    const provider = new GoogleLangChainModelProvider({
      apiKey: "test-key",
      aiApiBase: "https://google-ai.example",
      fetch: fetchFn,
      modelsDevFetch: vi.fn().mockResolvedValue(new Response("", { status: 503 })),
    });

    await expect(provider.listModels()).resolves.toEqual([
      expect.objectContaining({ id: "gemini-2.5-flash" }),
    ]);
    expect(fetchFn).toHaveBeenNthCalledWith(
      2,
      "https://google-ai.example/v1beta/models/gemini-flash-lite:generateContent",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("keeps Google AI when the verification probe only hits a rate limit", async () => {
    const fetchFn = vi.fn().mockImplementation((input: URL | string, init?: RequestInit) =>
      init?.method === "POST"
        ? Promise.resolve(new Response(JSON.stringify({
            error: { message: "Resource has been exhausted (e.g. check quota)." },
          }), { status: 429 }))
        : Promise.resolve(new Response(JSON.stringify({
            models: [{ name: "models/gemini-2.5-flash", supportedGenerationMethods: ["generateContent"] }],
          }), { status: 200 })));
    const provider = new GoogleLangChainModelProvider({
      apiKey: "test-key",
      aiApiBase: "https://google-ai.example",
      fetch: fetchFn,
    });

    await expect(provider.listModels()).resolves.toEqual([
      expect.objectContaining({ id: "gemini-2.5-flash", displayName: "gemini-2.5-flash (Google)" }),
    ]);
  });

  it("takes an explicit Google AI choice at its word without probing", async () => {
    const fetchFn = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      models: [{ name: "models/gemini-2.5-flash", supportedGenerationMethods: ["generateContent"] }],
    }), { status: 200 }));
    const provider = new GoogleLangChainModelProvider({
      apiKey: "test-key",
      aiApiBase: "https://google-ai.example",
      platform: "gai",
      fetch: fetchFn,
    });

    await provider.listModels();
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("names the resolved platform on the auto-detect option once it is known", async () => {
    const fetchFn = vi.fn().mockImplementation((input: URL | string, init?: RequestInit) =>
      init?.method === "POST"
        ? Promise.resolve(new Response("{}", { status: 200 }))
        : Promise.resolve(new Response(JSON.stringify({
            models: [{ name: "models/gemini-2.5-flash", supportedGenerationMethods: ["generateContent"] }],
          }), { status: 200 })));
    const provider = new GoogleLangChainModelProvider({
      apiKey: "test-key",
      aiApiBase: "https://google-ai.example",
      fetch: fetchFn,
    });
    const optionsOf = () => provider.authSchema[0]?.fields
      .find((field) => field.key === "platform")?.options;

    expect(optionsOf()).toContainEqual({ value: "auto", label: "Auto-detect" });
    await provider.listModels();
    expect(optionsOf()).toContainEqual({
      value: "auto",
      label: "Auto-detect (using Google AI Studio)",
    });
  });

  it("exposes explicit platform choices with auto-detection as the default", () => {
    const provider = new GoogleLangChainModelProvider();
    const platform = provider.authSchema[0]?.fields.find(
      (field) => field.key === "platform",
    );

    expect(platform).toMatchObject({
      type: "select",
      default: "auto",
      options: [
        { value: "auto", label: "Auto-detect" },
        { value: "gai", label: "Google AI Studio" },
        { value: "gcp", label: "Vertex AI Express" },
      ],
    });
  });

  it("names the project-qualified Vertex AI endpoint once a project is set", () => {
    const provider = new GoogleLangChainModelProvider();
    provider.configure({
      method: "api-key",
      values: { apiKey: "test-key", platform: "auto", project: "my-project" },
    });
    const platform = provider.authSchema[0]?.fields.find(
      (field) => field.key === "platform",
    );

    expect(platform?.options).toEqual([
      { value: "auto", label: "Auto-detect (using Vertex AI)" },
      { value: "gai", label: "Google AI Studio" },
      { value: "gcp", label: "Vertex AI" },
    ]);
  });

  it("explains when the Vertex AI project and location are needed", () => {
    const fields = new GoogleLangChainModelProvider().authSchema[0]?.fields ?? [];
    const hintOf = (key: string) => fields.find((field) => field.key === key)?.hint;

    expect(hintOf("project")).toMatch(/Gemini 4.*project ID or number/s);
    expect(hintOf("location")).toMatch(/global/);
  });
});

describe("Google Vertex AI routing", () => {
  async function requestedUrl(
    options: { project?: string; location?: string },
    via: "constructor" | "settings" = "constructor",
    platform: "gai" | "gcp" = "gcp",
  ): Promise<string> {
    const fetchFn = vi.fn().mockResolvedValue(Response.json({
      candidates: [{ content: { role: "model", parts: [{ text: "hi" }] }, finishReason: "STOP" }],
    }));
    vi.stubGlobal("fetch", fetchFn);
    try {
      const provider = new GoogleLangChainModelProvider({
        apiKey: "test-key",
        platform,
        ...(via === "constructor" ? options : {}),
        models: [{ id: "gemini-4-neon", provider: "google", displayName: "Gemini 4 Neon" }],
      });
      if (via === "settings") {
        provider.configure({ method: "api-key", values: { apiKey: "test-key", platform, ...options } });
      }
      const model = await provider.buildModel("gemini-4-neon");
      await model.invoke("hello").catch(() => undefined);
      const request = fetchFn.mock.calls[0]?.[0] as Request | string | URL;
      return request instanceof Request ? request.url : String(request);
    } finally {
      vi.unstubAllGlobals();
    }
  }

  it("uses the Vertex AI Express endpoint when no project is set", async () => {
    expect(await requestedUrl({})).toMatch(
      /^https:\/\/aiplatform\.googleapis\.com\/v1\/publishers\/google\/models\/gemini-4-neon:/,
    );
  });

  it("qualifies the endpoint with the project and the global location by default", async () => {
    // Express resolves to us-central1, which does not serve models offered only on global.
    expect(await requestedUrl({ project: "my-project" })).toMatch(
      /^https:\/\/aiplatform\.googleapis\.com\/v1\/projects\/my-project\/locations\/global\/publishers\/google\/models\/gemini-4-neon:/,
    );
  });

  it("routes a multi-region location to its regional endpoint", async () => {
    expect(await requestedUrl({ project: "my-project", location: "us" })).toMatch(
      /^https:\/\/aiplatform\.us\.rep\.googleapis\.com\/v1\/projects\/my-project\/locations\/us\//,
    );
  });

  it("applies the project and location from saved settings", async () => {
    expect(await requestedUrl({ project: "my-project", location: "us-east1" }, "settings")).toMatch(
      /^https:\/\/us-east1-aiplatform\.googleapis\.com\/v1\/projects\/my-project\/locations\/us-east1\//,
    );
  });

  it("ignores the project on Google AI Studio", async () => {
    // An invalid project proves the Vertex-only gate: it is neither validated nor used.
    expect(await requestedUrl({ project: "not/a/project" }, "constructor", "gai")).toMatch(
      /^https:\/\/generativelanguage\.googleapis\.com\//,
    );
  });

  it.each([
    { location: "evil.example#" },
    { location: "x@evil.com/" },
    { project: "my-project/../other" },
  ])("rejects a location or project that would change the endpoint: %o", async (bad) => {
    const provider = new GoogleLangChainModelProvider({
      apiKey: "test-key",
      platform: "gcp",
      project: "my-project",
      ...bad,
      models: [{ id: "gemini-4-neon", provider: "google", displayName: "Gemini 4 Neon" }],
    });
    await expect(provider.buildModel("gemini-4-neon")).rejects.toThrow(/Invalid Vertex AI/);
  });
});

describe("Google Vertex AI Express region hint", () => {
  const notFound = {
    error: {
      code: 404,
      status: "NOT_FOUND",
      message: "Publisher model `projects/1/locations/us-central1/publishers/google/models/gemini-4-neon` was not found or your project does not have access to it.",
    },
  };

  async function failure(
    options: { project?: string },
    mode: "invoke" | "stream",
  ): Promise<Error & { code?: string }> {
    vi.stubGlobal("fetch", vi.fn().mockImplementation(async () => Response.json(notFound, { status: 404 })));
    try {
      const provider = new GoogleLangChainModelProvider({
        apiKey: "test-key",
        platform: "gcp",
        ...options,
        models: [{ id: "gemini-4-neon", provider: "google", displayName: "Gemini 4 Neon" }],
      });
      const model = await provider.buildModel("gemini-4-neon");
      if (mode === "invoke") {
        await model.invoke("hello");
      } else {
        for await (const chunk of await model.stream("hello")) void chunk;
      }
    } catch (error) {
      return error as Error & { code?: string };
    } finally {
      vi.unstubAllGlobals();
    }
    throw new Error("expected the model call to fail");
  }

  it.each(["invoke", "stream"] as const)(
    "points an Express model-not-found failure at the project setting (%s)",
    async (mode) => {
      const error = await failure({}, mode);
      expect(error.message).toMatch(/was not found.*set a Vertex AI project ID/s);
      expect(error.code).toBe("MODEL_UNAVAILABLE");
    },
  );

  it("leaves the failure alone once a project is set", async () => {
    const error = await failure({ project: "my-project" }, "invoke");
    expect(error.message).not.toMatch(/Vertex AI project ID/);
    expect(error.code).toBeUndefined();
  });
});

describe("Google platform selection with a project", () => {
  it("selects Vertex AI under auto-detect without asking Google AI Studio", async () => {
    const fetchFn = vi.fn().mockResolvedValue(Response.json({
      candidates: [{ content: { role: "model", parts: [{ text: "hi" }] }, finishReason: "STOP" }],
    }));
    vi.stubGlobal("fetch", fetchFn);
    try {
      const aiStudio = vi.fn();
      const provider = new GoogleLangChainModelProvider({
        apiKey: "test-key",
        platform: "auto",
        project: "my-project",
        fetch: aiStudio,
        modelsDevFetch: vi.fn().mockResolvedValue(new Response("", { status: 503 })),
      });
      await provider.listModels();
      const model = await provider.buildModel("gemini-4-neon");
      await model.invoke("hello");

      expect(aiStudio).not.toHaveBeenCalled();
      const request = fetchFn.mock.calls[0]?.[0] as Request | string | URL;
      expect(request instanceof Request ? request.url : String(request)).toMatch(
        /\/projects\/my-project\/locations\/global\//,
      );
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("Google Gemini error translation", () => {
  it("does not blame credentials when the API is blocked for the key", () => {
    const blocked = Object.assign(
      new Error("Requests to this API generativelanguage.googleapis.com are blocked."),
      { status: 403 },
    );

    expect(translateGoogleError(blocked)).toBeUndefined();
  });

  it("still reports a plain authorization failure as expired credentials", () => {
    const denied = Object.assign(new Error("Permission denied"), { status: 403 });

    expect(translateGoogleError(denied)).toBe("AUTH_EXPIRED");
  });
});

describe("Google Gemini helpers", () => {
  it("rejects model records that cannot generate content", () => {
    expect(googleModelDescriptor({
      name: "models/embedding-001",
      supportedGenerationMethods: ["embedContent"],
    })).toBeUndefined();
  });

  it("classifies authentication and quota errors", () => {
    expect(
      translateGoogleError(
        new Error("API key not valid. Please pass a valid API key."),
      ),
    ).toBe("AUTH_EXPIRED");
    expect(
      translateGoogleError(new Error("RESOURCE_EXHAUSTED: quota exceeded")),
    ).toBe("RATE_LIMIT");
    expect(translateGoogleError(new Error("socket closed"))).toBeUndefined();
  });
});
