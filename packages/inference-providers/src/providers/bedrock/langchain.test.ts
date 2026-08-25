import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  HumanMessage,
  ToolMessage,
} from "@langchain/core/messages";

const sdk = vi.hoisted(() => ({
  chatConfig: undefined as Record<string, unknown> | undefined,
  bedrockClientConfig: undefined as Record<string, unknown> | undefined,
  outboundMessages: undefined as unknown[] | undefined,
  outboundOptions: undefined as Record<string, unknown> | undefined,
  bedrockSend: vi.fn(),
  iniCredentials: Symbol("ini-credentials"),
  nodeCredentials: Symbol("node-credentials"),
  fromIni: vi.fn(),
  fromNodeProviderChain: vi.fn(),
  mantleFetch: vi.fn(),
}));

vi.mock("@aws-sdk/credential-providers", () => ({
  fromIni: sdk.fromIni,
  fromNodeProviderChain: sdk.fromNodeProviderChain,
}));

vi.mock("@langchain/aws", () => ({
  ChatBedrockConverse: class {
    constructor(config: Record<string, unknown>) {
      sdk.chatConfig = config;
    }

    _generate(messages: unknown[], options: Record<string, unknown>) {
      sdk.outboundMessages = messages;
      sdk.outboundOptions = options;
      return { generations: [] };
    }

    _streamResponseChunks(messages: unknown[], options: Record<string, unknown>) {
      sdk.outboundMessages = messages;
      sdk.outboundOptions = options;
      return (async function* () {})();
    }

    _streamChatModelEvents(messages: unknown[], options: Record<string, unknown>) {
      sdk.outboundMessages = messages;
      sdk.outboundOptions = options;
      return (async function* () {})();
    }

    get profile() {
      return { toolCalling: true };
    }
  },
}));

vi.mock("@aws-sdk/client-bedrock", () => ({
  BedrockClient: class {
    constructor(config: Record<string, unknown>) {
      sdk.bedrockClientConfig = config;
    }

    send(command: unknown) {
      return sdk.bedrockSend(command);
    }
  },
  ListFoundationModelsCommand: class ListFoundationModelsCommand {},
  ListInferenceProfilesCommand: class ListInferenceProfilesCommand {},
}));

import { BedrockLangChainModelProvider } from "./langchain.js";

describe("BedrockLangChainModelProvider authentication", () => {
  beforeEach(() => {
    sdk.chatConfig = undefined;
    sdk.bedrockClientConfig = undefined;
    sdk.outboundMessages = undefined;
    sdk.outboundOptions = undefined;
    sdk.bedrockSend.mockReset().mockResolvedValue({});
    sdk.fromIni.mockReset().mockReturnValue(sdk.iniCredentials);
    sdk.fromNodeProviderChain.mockReset().mockReturnValue(sdk.nodeCredentials);
    sdk.mantleFetch.mockReset().mockResolvedValue(new Response(
      JSON.stringify({ data: [] }),
      { status: 200 },
    ));
    vi.stubGlobal("fetch", sdk.mantleFetch);
  });

  it("exposes discovered profiles and uses the configured profile for credentials", async () => {
    const provider = new BedrockLangChainModelProvider({
      profiles: ["default", "production"],
      region: "us-east-1",
    });
    provider.configure({ method: "aws-profile", values: { profile: "production" } });

    expect(provider.authSchema[0]?.fields[0]).toMatchObject({
      default: "default",
      options: [
        { value: "default", label: "default" },
        { value: "production", label: "production" },
      ],
    });
    expect(provider.authSchema.map((method) => method.id)).toEqual([
      "aws-profile",
      "access-keys",
      "bedrock-api-key",
    ]);
    expect(provider.processEnv()).toMatchObject({
      AWS_PROFILE: "production",
      AWS_REGION: "us-east-1",
    });

    await provider.buildModel("global.anthropic.claude-sonnet-5");

    // Catalog sources and models share one credential source, so they cannot
    // disagree about whether the credentials are still valid.
    expect(sdk.fromIni).toHaveBeenCalledTimes(1);
    expect(sdk.fromIni).toHaveBeenCalledWith({ profile: "production" });
    expect(sdk.fromNodeProviderChain).not.toHaveBeenCalled();
    expect(sdk.chatConfig?.credentials).toBe(sdk.iniCredentials);
  });

  it("retains the ambient credential chain when no profile is configured", async () => {
    const provider = new BedrockLangChainModelProvider();

    await provider.buildModel("global.anthropic.claude-sonnet-5");

    expect(sdk.fromIni).not.toHaveBeenCalled();
    expect(sdk.fromNodeProviderChain).toHaveBeenCalledOnce();
    expect(sdk.chatConfig?.credentials).toBe(sdk.nodeCredentials);
  });

  it("discovers and projects catalog context while retaining native capabilities", async () => {
    const client = {
      send: vi.fn(async (command: unknown) =>
        command?.constructor.name === "ListInferenceProfilesCommand"
          ? {
              inferenceProfileSummaries: [{
                inferenceProfileId: "global.anthropic.claude-sonnet-5",
                inferenceProfileName: "Global Claude Sonnet 5",
                status: "ACTIVE",
              }],
            }
          : { modelSummaries: [] }),
    };
    const provider = new BedrockLangChainModelProvider({
      profiles: ["production"],
      client,
      modelsDevFetch: vi.fn(async () => new Response(JSON.stringify({
        "amazon-bedrock": {
          models: {
            "global.anthropic.claude-sonnet-5": {
              limit: { context: 1_000_000 },
            },
          },
        },
      }), { status: 200 })),
    });
    provider.configure({ method: "aws-profile", values: { profile: "production" } });

    const model = await provider.buildModel("global.anthropic.claude-sonnet-5");

    expect(model.profile).toEqual({
      maxInputTokens: 1_000_000,
      toolCalling: true,
    });
  });

  it("normalizes DeepAgents image tool results before calling Bedrock", async () => {
    const provider = new BedrockLangChainModelProvider();
    const model = await provider.buildModel("global.anthropic.claude-sonnet-5");
    const toolMessage = new ToolMessage({
      tool_call_id: "read-1",
      content: [{
        type: "image",
        mimeType: "image/png",
        data: "aW1hZ2U=",
      }],
    });

    (model as unknown as {
      _streamResponseChunks(messages: ToolMessage[], options: object): unknown;
    })._streamResponseChunks([toolMessage], {});

    expect(sdk.outboundMessages?.[0]).toMatchObject({
      content: [{
        type: "image",
        source_type: "base64",
        mime_type: "image/png",
        data: "aW1hZ2U=",
      }],
    });
    expect(toolMessage.content).toEqual([{
      type: "image",
      mimeType: "image/png",
      data: "aW1hZ2U=",
    }]);
  });

  it("uses explicit access keys, an optional session token, and a region override", async () => {
    const provider = new BedrockLangChainModelProvider({ region: "us-west-2" });
    provider.configure({
      method: "access-keys",
      values: {
        accessKeyId: "access-key",
        secretAccessKey: "secret-key",
        sessionToken: "session-token",
        region: "eu-west-1",
      },
    });

    expect(provider.processEnv()).toEqual({ AWS_REGION: "eu-west-1" });

    await provider.buildModel("global.anthropic.claude-sonnet-5");

    expect(sdk.chatConfig).toMatchObject({
      region: "eu-west-1",
      credentials: {
        accessKeyId: "access-key",
        secretAccessKey: "secret-key",
        sessionToken: "session-token",
      },
    });
    expect(sdk.fromIni).not.toHaveBeenCalled();
    expect(sdk.fromNodeProviderChain).not.toHaveBeenCalled();
  });

  it("uses Bedrock bearer authentication without resolving AWS credentials", async () => {
    const provider = new BedrockLangChainModelProvider();
    provider.configure({
      method: "bedrock-api-key",
      values: { apiKey: "bedrock-key", region: "ap-southeast-2" },
    });

    expect(provider.processEnv()).toEqual({ AWS_REGION: "ap-southeast-2" });

    await provider.buildModel("global.anthropic.claude-sonnet-5");

    expect(sdk.chatConfig).toMatchObject({
      region: "ap-southeast-2",
      bedrockBearerToken: "bedrock-key",
    });
    expect(sdk.chatConfig).not.toHaveProperty("credentials");
    expect(sdk.fromIni).not.toHaveBeenCalled();
    expect(sdk.fromNodeProviderChain).not.toHaveBeenCalled();
  });

  it("uses bearer authentication for model discovery", async () => {
    const provider = new BedrockLangChainModelProvider();
    provider.configure({
      method: "bedrock-api-key",
      values: { apiKey: "bedrock-key", region: "us-east-2" },
    });

    await provider.listModels();

    expect(sdk.bedrockClientConfig).toMatchObject({
      region: "us-east-2",
      authSchemePreference: ["httpBearerAuth"],
    });
    const token = sdk.bedrockClientConfig?.token as
      | (() => Promise<{ token: string }>)
      | undefined;
    await expect(token?.()).resolves.toEqual({ token: "bedrock-key" });
    expect(sdk.bedrockClientConfig).not.toHaveProperty("credentials");
  });

  it("uses explicit access keys for model discovery", async () => {
    const provider = new BedrockLangChainModelProvider();
    provider.configure({
      method: "access-keys",
      values: {
        accessKeyId: "access-key",
        secretAccessKey: "secret-key",
      },
    });

    await provider.listModels();

    expect(sdk.bedrockClientConfig).toMatchObject({
      region: "us-west-2",
      credentials: {
        accessKeyId: "access-key",
        secretAccessKey: "secret-key",
      },
    });
  });

  it("reuses the Mantle signer and credential source until configuration changes", async () => {
    sdk.fromIni.mockReturnValue({
      accessKeyId: "access-key",
      secretAccessKey: "secret-key",
    });
    sdk.mantleFetch.mockImplementation(async () => new Response(JSON.stringify({
      data: [{ id: "openai.gpt-5.6-sol", display_name: "GPT-5.6 Sol" }],
    }), { status: 200 }));
    const provider = new BedrockLangChainModelProvider({
      profiles: ["production"],
    });
    provider.configure({ method: "aws-profile", values: { profile: "production" } });

    await provider.listModels();
    expect(sdk.fromIni).toHaveBeenCalledTimes(1);

    await provider.buildModel("openai.gpt-5.6-sol");

    expect(sdk.fromIni).toHaveBeenCalledTimes(1);

    provider.configure({ method: "aws-profile", values: { profile: "production" } });
    await provider.listModels();

    expect(sdk.fromIni).toHaveBeenCalledTimes(2);
  });

  it("clears credentials from the previously selected method", async () => {
    const provider = new BedrockLangChainModelProvider();
    provider.configure({
      method: "access-keys",
      values: { accessKeyId: "access-key", secretAccessKey: "secret-key" },
    });
    provider.configure({
      method: "bedrock-api-key",
      values: { apiKey: "bedrock-key" },
    });

    await provider.buildModel("global.anthropic.claude-sonnet-5");

    expect(sdk.chatConfig).toMatchObject({ bedrockBearerToken: "bedrock-key" });
    expect(sdk.chatConfig).not.toHaveProperty("credentials");
  });

  it("reports missing explicit credentials without discovery", async () => {
    const client = {
      send: vi.fn(async (command: unknown) =>
        command?.constructor.name === "ListInferenceProfilesCommand"
          ? { inferenceProfileSummaries: [] }
          : {
              modelSummaries: [{
                modelId: "amazon.nova-pro-v1:0",
                modelName: "Nova Pro",
                inputModalities: ["TEXT"],
              }],
            }),
    };
    const provider = new BedrockLangChainModelProvider({ client });

    await expect(provider.listModels()).rejects.toMatchObject({
      name: "ModelCatalogError",
      code: "credentials",
      retryable: false,
    });
    expect(client.send).not.toHaveBeenCalled();
  });

  it("discovers active inference profiles and on-demand text models", async () => {
    const client = {
      send: vi.fn(async (command: unknown) => {
        if (command?.constructor.name === "ListInferenceProfilesCommand") {
          return {
            inferenceProfileSummaries: [
              {
                inferenceProfileId: "global.anthropic.claude-sonnet-5",
                inferenceProfileName: "Global Claude Sonnet 5",
                status: "ACTIVE",
                models: [{ modelArn: "arn:aws:bedrock:us-east-1::foundation-model/anthropic.claude-sonnet-5" }],
              },
              {
                inferenceProfileId: "us.amazon.nova-canvas-v1:0",
                status: "ACTIVE",
                models: [{ modelArn: "arn:aws:bedrock:us-east-1::foundation-model/amazon.nova-canvas-v1:0" }],
              },
            ],
          };
        }
        return {
          modelSummaries: [
            {
              modelId: "meta.llama4-scout-17b-instruct-v1:0",
              modelName: "Llama 4 Scout",
              inputModalities: ["TEXT", "IMAGE"],
            },
          ],
        };
      }),
    };
    const provider = new BedrockLangChainModelProvider({
      profiles: ["production"],
      client,
      modelsDevFetch: vi.fn(async () => new Response(JSON.stringify({
        "amazon-bedrock": {
          models: {
            "global.anthropic.claude-sonnet-5": {
              limit: { context: 1_000_000, output: 128_000 },
              tool_call: true,
              modalities: { input: ["text", "image"] },
            },
          },
        },
      }), { status: 200 })),
    });
    provider.configure({ method: "aws-profile", values: { profile: "production" } });

    await expect(provider.listModels()).resolves.toEqual([
      expect.objectContaining({
        id: "global.anthropic.claude-sonnet-5",
        displayName: "Global Claude Sonnet 5 (Runtime)",
        contextWindow: 1_000_000,
        maxOutputTokens: 128_000,
        supportsVision: true,
      }),
      expect.objectContaining({
        id: "meta.llama4-scout-17b-instruct-v1:0",
        supportsVision: true,
      }),
    ]);
  });
});

describe("Bedrock catalog source failures", () => {
  const profileSummaries = {
    inferenceProfileSummaries: [
      {
        inferenceProfileId: "global.anthropic.claude-sonnet-5",
        inferenceProfileName: "Global Claude Sonnet 5",
        status: "ACTIVE",
        models: [{ modelArn: "arn:aws:bedrock:us-east-1::foundation-model/anthropic.claude-sonnet-5" }],
      },
    ],
  };
  const foundationSummaries = {
    modelSummaries: [{ modelId: "amazon.nova-pro-v1:0", modelName: "Nova Pro", inputModalities: ["TEXT"] }],
  };

  function configuredProvider(
    send: (command: unknown) => Promise<unknown>,
  ): BedrockLangChainModelProvider {
    const provider = new BedrockLangChainModelProvider({
      profiles: ["production"],
      client: { send },
      modelsDevFetch: vi.fn(async () => new Response("{}", { status: 200 })),
    });
    provider.configure({ method: "aws-profile", values: { profile: "production" } });
    return provider;
  }

  beforeEach(() => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    sdk.fromIni.mockReset().mockReturnValue({
      accessKeyId: "access-key",
      secretAccessKey: "secret-key",
    });
    // A Response body reads once, so every catalog pass needs a fresh one.
    sdk.mantleFetch.mockReset().mockImplementation(
      async () => new Response(JSON.stringify({ data: [] }), { status: 200 }),
    );
    vi.stubGlobal("fetch", sdk.mantleFetch);
  });

  it("keeps models from a previously listed source and reports the gap", async () => {
    let failProfiles = false;
    const provider = configuredProvider(async (command) => {
      if (command?.constructor.name === "ListInferenceProfilesCommand") {
        if (failProfiles) throw Object.assign(new Error("ThrottlingException"), { name: "ThrottlingException" });
        return profileSummaries;
      }
      return foundationSummaries;
    });

    const first = await provider.listModels();
    expect(first.map((model) => model.id)).toEqual([
      "global.anthropic.claude-sonnet-5",
      "amazon.nova-pro-v1:0",
    ]);
    expect(provider.catalogDegradation()).toBeUndefined();

    failProfiles = true;
    const second = await provider.listModels();

    expect(second.map((model) => model.id)).toEqual(first.map((model) => model.id));
    expect(provider.catalogDegradation()).toMatchObject({
      code: "unavailable",
      retryable: true,
      stale: true,
    });
    expect(provider.catalogDegradation()?.message).toContain("inference profiles");
  });

  it("reports a partial catalog when a source fails before ever succeeding", async () => {
    const provider = configuredProvider(async (command) => {
      if (command?.constructor.name === "ListInferenceProfilesCommand") {
        throw new Error("ExpiredTokenException: token expired");
      }
      return foundationSummaries;
    });

    await expect(provider.listModels()).resolves.toMatchObject([
      expect.objectContaining({ id: "amazon.nova-pro-v1:0" }),
    ]);
    expect(provider.catalogDegradation()).toMatchObject({
      code: "authentication",
      retryable: false,
      stale: false,
    });
  });

  it("clears the degradation once every source answers again", async () => {
    let failProfiles = true;
    const provider = configuredProvider(async (command) => {
      if (command?.constructor.name === "ListInferenceProfilesCommand") {
        if (failProfiles) throw new Error("ThrottlingException");
        return profileSummaries;
      }
      return foundationSummaries;
    });

    await provider.listModels();
    expect(provider.catalogDegradation()).toBeDefined();

    failProfiles = false;
    await provider.listModels();

    expect(provider.catalogDegradation()).toBeUndefined();
  });

  it("classifies expired credentials when every source fails", async () => {
    sdk.mantleFetch.mockImplementation(async () => new Response("{}", { status: 403 }));
    const provider = configuredProvider(async () => {
      throw new Error("ExpiredTokenException: the security token included in the request is expired");
    });

    await expect(provider.listModels()).rejects.toMatchObject({
      name: "ModelCatalogError",
      code: "authentication",
      retryable: false,
    });
  });
});

describe("Bedrock outbound attachment projection", () => {
  it("sanitizes only the provider-facing name and drops cache points for text documents", async () => {
    const provider = new BedrockLangChainModelProvider({
      models: [{
        id: "global.anthropic.claude-sonnet-5",
        provider: "bedrock",
        displayName: "Claude Sonnet 5",
      }],
    });
    const model = await provider.buildModel("global.anthropic.claude-sonnet-5");
    const message = new HumanMessage({
      content: [{
        type: "file",
        source_type: "base64",
        mime_type: "text/markdown",
        data: "IyBoaQ==",
        metadata: { name: "✍️ Blogs/Blog ideas.md" },
      }] as unknown as string,
    });
    const stream = (model as unknown as {
      _streamResponseChunks(
        messages: unknown[],
        options: Record<string, unknown>,
      ): AsyncIterable<unknown>;
    })._streamResponseChunks([message], {
      cache_control: { type: "ephemeral" },
      signal: "preserved",
    });

    for await (const _chunk of stream) {
      // The mocked provider emits no chunks.
    }

    const outbound = sdk.outboundMessages?.[0] as HumanMessage;
    expect(outbound).not.toBe(message);
    expect(outbound.content).toEqual([{
      type: "file",
      source_type: "base64",
      mime_type: "text/markdown",
      data: "IyBoaQ==",
      metadata: { name: "Blogs Blog ideas md" },
    }]);
    expect(message.content).toEqual([{
      type: "file",
      source_type: "base64",
      mime_type: "text/markdown",
      data: "IyBoaQ==",
      metadata: { name: "✍️ Blogs/Blog ideas.md" },
    }]);
    expect(sdk.outboundOptions).toEqual({ signal: "preserved" });
  });

  it("retains cache points for PDF documents", async () => {
    const provider = new BedrockLangChainModelProvider({
      models: [{
        id: "global.anthropic.claude-sonnet-5",
        provider: "bedrock",
        displayName: "Claude Sonnet 5",
      }],
    });
    const model = await provider.buildModel("global.anthropic.claude-sonnet-5");
    const message = new HumanMessage({
      content: [{
        type: "file",
        source_type: "base64",
        mime_type: "application/pdf",
        data: "JVBERi0=",
        metadata: { name: "report.pdf" },
      }] as unknown as string,
    });
    const cacheControl = { type: "ephemeral" };
    const stream = (model as unknown as {
      _streamResponseChunks(
        messages: unknown[],
        options: Record<string, unknown>,
      ): AsyncIterable<unknown>;
    })._streamResponseChunks([message], { cache_control: cacheControl });

    for await (const _chunk of stream) {
      // The mocked provider emits no chunks.
    }

    expect(sdk.outboundOptions).toEqual({ cache_control: cacheControl });
  });
});
