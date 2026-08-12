/** Amazon Bedrock provider backed by lazy-loaded `ChatBedrockConverse`. */
import type { BaseMessage } from "@langchain/core/messages";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import type {
  ModelProvider,
  ModelDescriptor,
  ProviderAuthMethod,
  ResolvedProviderConfig,
} from "@pizza-bot/core";
import {
  REASONING_REQUEST_FIELDS,
  resolveRegion,
  resolveMaxTokens,
  supportedToolChoiceValues,
  supportsReasoning,
  translateBedrockError,
  type BedrockProviderOptions,
} from "./models.js";
import { stripReasoningForBedrock } from "./outbound-messages.js";
import { repairEmptyToolCallEvent, repairEmptyToolCalls } from "./tool-call-fix.js";
import {
  enrichModelDescriptors,
  resolveModelsDevCatalog,
  type ModelsDevCatalogLoader,
} from "../../models-dev.js";
import { withContextWindow } from "../../model-profile.js";
import {
  catalogConnectionError,
  missingCatalogCredentials,
} from "../../catalog-error.js";

class BedrockBuildError extends Error {
  constructor(
    message: string,
    readonly code: "AUTH_EXPIRED" | "RATE_LIMIT",
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "BedrockBuildError";
  }
}

export class BedrockLangChainModelProvider implements ModelProvider {
  readonly id = "bedrock";
  readonly authSchema: readonly ProviderAuthMethod[];
  private readonly defaultRegion: string;
  private readonly models: ModelDescriptor[] | undefined;
  private readonly maxTokens: number;
  private readonly client: { send(command: unknown): Promise<unknown> } | undefined;
  private readonly modelsDev: ModelsDevCatalogLoader;
  private readonly descriptors = new Map<string, ModelDescriptor>();
  private region: string;
  private authMethod: "aws-profile" | "access-keys" | "bedrock-api-key" | undefined;
  private profile: string | undefined;
  private accessKeyId: string | undefined;
  private secretAccessKey: string | undefined;
  private sessionToken: string | undefined;
  private bedrockApiKey: string | undefined;

  constructor(opts: BedrockProviderOptions = {}) {
    this.defaultRegion = resolveRegion(opts.region);
    this.region = this.defaultRegion;
    this.models = opts.models;
    this.maxTokens = resolveMaxTokens(opts.maxTokens);
    this.client = opts.client;
    this.modelsDev = resolveModelsDevCatalog(opts.modelsDev, opts.modelsDevFetch);
    for (const descriptor of opts.models ?? []) {
      this.descriptors.set(descriptor.id, descriptor);
    }
    this.profile = opts.profile?.trim() || undefined;
    this.authMethod = this.profile ? "aws-profile" : undefined;
    const profiles = [...new Set(opts.profiles ?? [])];
    if (this.profile && !profiles.includes(this.profile)) profiles.push(this.profile);
    const regionField = {
      key: "region",
      label: "Region override",
      type: "text" as const,
      required: false,
      default: "",
    };
    this.authSchema = [
      {
        id: "aws-profile",
        label: "AWS profile",
        fields: [
          {
            key: "profile",
            label: "Profile",
            type: "select",
            required: true,
            options: profiles.map((profile) => ({ value: profile, label: profile })),
            ...(profiles[0] ? { default: profiles[0] } : {}),
          },
          regionField,
        ],
      },
      {
        id: "access-keys",
        label: "AWS access keys",
        fields: [
          {
            key: "accessKeyId",
            label: "Access key ID",
            type: "password",
            required: true,
          },
          {
            key: "secretAccessKey",
            label: "Secret access key",
            type: "password",
            required: true,
          },
          {
            key: "sessionToken",
            label: "Session token",
            type: "password",
            required: false,
          },
          regionField,
        ],
      },
      {
        id: "bedrock-api-key",
        label: "Bedrock API key",
        fields: [
          {
            key: "apiKey",
            label: "Bedrock API key",
            type: "password",
            required: true,
          },
          regionField,
        ],
      },
    ];
  }

  configure(cfg: ResolvedProviderConfig): void {
    if (
      cfg.method !== "aws-profile" &&
      cfg.method !== "access-keys" &&
      cfg.method !== "bedrock-api-key"
    ) {
      return;
    }
    this.authMethod = cfg.method;
    this.region = resolveRegion(cfg.values.region?.trim() || this.defaultRegion);
    this.profile = cfg.method === "aws-profile"
      ? cfg.values.profile?.trim() || undefined
      : undefined;
    this.accessKeyId = cfg.method === "access-keys"
      ? cfg.values.accessKeyId?.trim() || undefined
      : undefined;
    this.secretAccessKey = cfg.method === "access-keys"
      ? cfg.values.secretAccessKey?.trim() || undefined
      : undefined;
    this.sessionToken = cfg.method === "access-keys"
      ? cfg.values.sessionToken?.trim() || undefined
      : undefined;
    this.bedrockApiKey = cfg.method === "bedrock-api-key"
      ? cfg.values.apiKey?.trim() || undefined
      : undefined;
    if (!this.models) this.descriptors.clear();
  }

  async listModels(): Promise<ModelDescriptor[]> {
    if (this.models) return this.models;
    if (!this.hasConfiguredAuth()) throw missingCatalogCredentials("Amazon Bedrock");

    try {
      const {
        BedrockClient,
        ListFoundationModelsCommand,
        ListInferenceProfilesCommand,
      } = await import("@aws-sdk/client-bedrock");
      const client = this.client ?? new BedrockClient(await this.clientConfig());
      const [foundationResult, profileResult] = await Promise.allSettled([
        client.send(new ListFoundationModelsCommand({
          byInferenceType: "ON_DEMAND",
          byOutputModality: "TEXT",
        })),
        client.send(new ListInferenceProfilesCommand({ maxResults: 1000 })),
      ]);
      const foundationModels = foundationResult.status === "fulfilled"
        ? foundationDescriptors(foundationResult.value)
        : [];
      const inferenceProfiles = profileResult.status === "fulfilled"
        ? profileDescriptors(profileResult.value)
        : [];
      if (
        foundationResult.status === "rejected" &&
        profileResult.status === "rejected"
      ) {
        throw foundationResult.reason;
      }
      const descriptors = await enrichModelDescriptors(
        dedupeModels([...inferenceProfiles, ...foundationModels]),
        "amazon-bedrock",
        this.modelsDev,
      );
      this.descriptors.clear();
      for (const descriptor of descriptors) {
        this.descriptors.set(descriptor.id, descriptor);
      }
      return descriptors;
    } catch (cause) {
      throw catalogConnectionError("Amazon Bedrock", cause);
    }
  }

  /** Propagate non-secret AWS context to spawned MCP processes. */
  processEnv(): Record<string, string> {
    const profile = this.authMethod === undefined
      ? process.env.AWS_PROFILE
      : this.profile;
    return {
      AWS_REGION: this.region,
      ...(profile ? { AWS_PROFILE: profile } : {}),
    };
  }

  async buildModel(modelId: string): Promise<BaseChatModel> {
    try {
      return await this.construct(modelId);
    } catch (err) {
      const code = translateBedrockError(err);
      if (code) throw new BedrockBuildError(err instanceof Error ? err.message : String(err), code, { cause: err });
      throw err;
    }
  }

  private async construct(modelId: string): Promise<BaseChatModel> {
    const { ChatBedrockConverse } = await import("@langchain/aws");

    if (!this.descriptors.has(modelId)) {
      await this.listModels().catch(() => []);
    }
    const descriptor = this.descriptors.get(modelId);
    const reasoning = supportsReasoning(modelId);

    // The base signatures use `this["ParsedCallOptions"]`, which cannot be named
    // from this dynamically imported class, so only `messages` remains typed.
    class ReasoningSafeChatBedrockConverse extends ChatBedrockConverse {
      override get profile() {
        return withContextWindow(super.profile, descriptor?.contextWindow);
      }

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      override async _generate(messages: BaseMessage[], ...rest: [options: any, runManager?: any]) {
        const result = await super._generate(stripReasoningForBedrock(messages), ...rest);
        let changed = false;
        const generations = result.generations.map((generation) => {
          const message = repairEmptyToolCalls(generation.message);
          if (message === generation.message) return generation;
          changed = true;
          return { ...generation, message };
        });
        return changed ? { ...result, generations } : result;
      }

      override _streamResponseChunks(
        messages: BaseMessage[],
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        ...rest: [options: any, runManager?: any]
      ) {
        return super._streamResponseChunks(stripReasoningForBedrock(messages), ...rest);
      }

      override async *_streamChatModelEvents(
        messages: BaseMessage[],
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        ...rest: [options: any, runManager?: any]
      ) {
        for await (const event of super._streamChatModelEvents(
          stripReasoningForBedrock(messages),
          ...rest,
        )) {
          yield repairEmptyToolCallEvent(event);
        }
      }
    }

    const auth = this.bedrockApiKey
      ? { bedrockBearerToken: this.bedrockApiKey }
      : { credentials: await this.credentials() };
    return new ReasoningSafeChatBedrockConverse({
      model: modelId,
      region: this.region,
      ...auth,
      ...(reasoning ? { additionalModelRequestFields: REASONING_REQUEST_FIELDS } : {}),
      maxTokens: this.maxTokens,
      ...(() => {
        const v = supportedToolChoiceValues(modelId);
        return v ? { supportsToolChoiceValues: v } : {};
      })(),
    });
  }

  private async credentials() {
    if (this.accessKeyId && this.secretAccessKey) {
      return {
        accessKeyId: this.accessKeyId,
        secretAccessKey: this.secretAccessKey,
        ...(this.sessionToken ? { sessionToken: this.sessionToken } : {}),
      };
    }
    const { fromIni, fromNodeProviderChain } = await import("@aws-sdk/credential-providers");
    return this.profile ? fromIni({ profile: this.profile }) : fromNodeProviderChain();
  }

  private async clientConfig() {
    if (this.bedrockApiKey) {
      const token = this.bedrockApiKey;
      return {
        region: this.region,
        authSchemePreference: ["httpBearerAuth"],
        token: async () => ({ token }),
      };
    }
    return {
      region: this.region,
      credentials: await this.credentials(),
    };
  }

  private hasConfiguredAuth(): boolean {
    if (this.authMethod === "aws-profile") return Boolean(this.profile);
    if (this.authMethod === "access-keys") {
      return Boolean(this.accessKeyId && this.secretAccessKey);
    }
    if (this.authMethod === "bedrock-api-key") return Boolean(this.bedrockApiKey);
    return false;
  }
}

interface FoundationModelsResponse {
  modelSummaries?: Array<{
    modelId?: string;
    modelName?: string;
    inputModalities?: string[];
    outputModalities?: string[];
  }>;
}

interface InferenceProfilesResponse {
  inferenceProfileSummaries?: Array<{
    inferenceProfileId?: string;
    inferenceProfileName?: string;
    status?: string;
    models?: Array<{ modelArn?: string }>;
  }>;
}

function foundationDescriptors(raw: unknown): ModelDescriptor[] {
  const response = raw as FoundationModelsResponse;
  return (response.modelSummaries ?? []).flatMap((model) => {
    if (!model.modelId || !isConversationalModel(model.modelId)) return [];
    return [{
      id: model.modelId,
      provider: "bedrock",
      displayName: `${model.modelName ?? model.modelId} (Bedrock)`,
      supportsTools: true,
      ...(model.inputModalities
        ? { supportsVision: model.inputModalities.includes("IMAGE") }
        : {}),
    }];
  });
}

function profileDescriptors(raw: unknown): ModelDescriptor[] {
  const response = raw as InferenceProfilesResponse;
  return (response.inferenceProfileSummaries ?? []).flatMap((profile) => {
    const modelIds = (profile.models ?? []).flatMap((model) => {
      const id = model.modelArn?.split("/").at(-1);
      return id ? [id] : [];
    });
    if (
      !profile.inferenceProfileId ||
      profile.status !== "ACTIVE" ||
      (modelIds.length > 0 && !modelIds.some(isConversationalModel))
    ) {
      return [];
    }
    return [{
      id: profile.inferenceProfileId,
      provider: "bedrock",
      displayName: `${profile.inferenceProfileName ?? profile.inferenceProfileId} (Bedrock)`,
      supportsTools: true,
    }];
  });
}

function isConversationalModel(modelId: string): boolean {
  const id = modelId.toLowerCase();
  return ![
    "embed",
    "rerank",
    "canvas",
    "video",
    "tts",
  ].some((nonChat) => id.includes(nonChat));
}

function dedupeModels(models: ModelDescriptor[]): ModelDescriptor[] {
  return [...new Map(models.map((model) => [model.id, model])).values()];
}
