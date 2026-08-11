import { beforeEach, describe, expect, it, vi } from "vitest";

const sdk = vi.hoisted(() => ({
  chatConfig: undefined as Record<string, unknown> | undefined,
  bedrockClientConfig: undefined as Record<string, unknown> | undefined,
  bedrockSend: vi.fn(),
  iniCredentials: Symbol("ini-credentials"),
  nodeCredentials: Symbol("node-credentials"),
  fromIni: vi.fn(),
  fromNodeProviderChain: vi.fn(),
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

    _generate(): undefined {
      return undefined;
    }

    _streamResponseChunks(): undefined {
      return undefined;
    }

    _streamChatModelEvents(): undefined {
      return undefined;
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
    sdk.bedrockSend.mockReset().mockResolvedValue({});
    sdk.fromIni.mockReset().mockReturnValue(sdk.iniCredentials);
    sdk.fromNodeProviderChain.mockReset().mockReturnValue(sdk.nodeCredentials);
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

    expect(sdk.fromIni).toHaveBeenCalledTimes(2);
    expect(sdk.fromIni).toHaveBeenNthCalledWith(1, { profile: "production" });
    expect(sdk.fromIni).toHaveBeenNthCalledWith(2, { profile: "production" });
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
