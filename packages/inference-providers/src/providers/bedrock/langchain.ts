/** Amazon Bedrock provider with native Converse and Mantle protocol routing. */
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
import {
  endsWithCacheIncompatibleDocument,
  sanitizeDocumentNamesForBedrock,
  stripReasoningForBedrock,
} from "./outbound-messages.js";
import { repairEmptyToolCallEvent, repairEmptyToolCalls } from "./tool-call-fix.js";
import { normalizeMultimodalToolResultsForBedrock } from "./multimodal-fix.js";
import {
  enrichModelDescriptors,
  resolveModelsDevCatalog,
  type ModelsDevCatalogLoader,
} from "../../models-dev.js";
import { withContextWindow } from "../../model-profile.js";
import {
  catalogConnectionError,
  catalogHttpError,
  missingCatalogCredentials,
} from "../../catalog-error.js";
import { createAnthropicChatModel } from "../anthropic.js";
import { createOpenAiChatModel } from "../openai.js";
import { createSigV4Fetch, mantleEndpoint } from "./mantle.js";

type BedrockProtocol = "converse" | "responses" | "chat-completions" | "messages";

interface RoutedModel {
  descriptor: ModelDescriptor;
  protocol: BedrockProtocol;
}

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
  private readonly fetchFn: typeof fetch;
  private readonly modelsDev: ModelsDevCatalogLoader;
  private readonly descriptors = new Map<string, ModelDescriptor>();
  private readonly protocols = new Map<string, BedrockProtocol>();
  private readonly learnedMaxTokens = new Map<string, number>();
  private mantleFetchPromise: Promise<typeof fetch> | undefined;
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
    this.fetchFn = opts.fetch ?? fetch;
    this.modelsDev = resolveModelsDevCatalog(opts.modelsDev, opts.modelsDevFetch);
    for (const descriptor of opts.models ?? []) {
      this.descriptors.set(descriptor.id, descriptor);
      this.protocols.set(descriptor.id, defaultProtocol(descriptor.id));
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
    this.mantleFetchPromise = undefined;
    if (!this.models) this.descriptors.clear();
    if (!this.models) this.protocols.clear();
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
      const [foundationResult, profileResult, mantleResult] = await Promise.allSettled([
        client.send(new ListFoundationModelsCommand({
          byInferenceType: "ON_DEMAND",
          byOutputModality: "TEXT",
        })),
        client.send(new ListInferenceProfilesCommand({ maxResults: 1000 })),
        this.listMantleModels(),
      ]);
      const foundationModels = foundationResult.status === "fulfilled"
        ? foundationDescriptors(foundationResult.value).map(withDefaultProtocol)
        : [];
      const inferenceProfiles = profileResult.status === "fulfilled"
        ? profileDescriptors(profileResult.value).map(withConverseProtocol)
        : [];
      const mantleModels = mantleResult.status === "fulfilled"
        ? mantleResult.value
        : [];
      if (
        foundationResult.status === "rejected" &&
        profileResult.status === "rejected" &&
        mantleResult.status === "rejected"
      ) {
        throw foundationResult.reason;
      }
      const routed = mergeRoutedModels([
        ...inferenceProfiles,
        ...foundationModels,
        ...mantleModels,
      ]);
      const descriptors = await enrichModelDescriptors(
        routed.map(({ descriptor, protocol }) => ({
          ...descriptor,
          displayName: protocolDisplayName(descriptor.displayName, protocol),
        })),
        "amazon-bedrock",
        this.modelsDev,
      );
      this.descriptors.clear();
      this.protocols.clear();
      for (const [index, descriptor] of descriptors.entries()) {
        this.descriptors.set(descriptor.id, descriptor);
        const protocol = routed[index]?.protocol;
        if (protocol) this.protocols.set(descriptor.id, protocol);
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
    if (!this.descriptors.has(modelId)) {
      await this.listModels().catch(() => []);
    }
    const descriptor = this.descriptors.get(modelId);
    const protocol = this.protocols.get(modelId) ?? defaultProtocol(modelId);
    if (protocol === "responses" || protocol === "chat-completions") {
      const configuredMax = Math.min(
        this.maxTokens,
        descriptor?.maxOutputTokens ?? Number.POSITIVE_INFINITY,
      );
      return createOpenAiChatModel({
        modelId,
        apiKey: this.bedrockApiKey ?? "bedrock-sigv4",
        maxTokens: Math.min(
          configuredMax,
          this.learnedMaxTokens.get(modelId) ?? Number.POSITIVE_INFINITY,
        ),
        apiMode: protocol,
        baseUrl: protocol === "responses"
          ? `${mantleEndpoint(this.region)}/openai/v1`
          : `${mantleEndpoint(this.region)}/v1`,
        fetch: await this.mantleFetch(),
        learnedMaxTokens: this.learnedMaxTokens,
        ...(descriptor ? { descriptor } : {}),
      });
    }
    if (protocol === "messages") {
      return createAnthropicChatModel({
        modelId,
        apiKey: this.bedrockApiKey ?? "bedrock-sigv4",
        maxTokens: Math.min(
          this.maxTokens,
          descriptor?.maxOutputTokens ?? Number.POSITIVE_INFINITY,
        ),
        baseUrl: `${mantleEndpoint(this.region)}/anthropic`,
        authMode: "api-key",
        fetch: await this.mantleFetch(),
        ...(descriptor ? { descriptor } : {}),
      });
    }

    return this.constructConverse(modelId, descriptor);
  }

  private async constructConverse(
    modelId: string,
    descriptor: ModelDescriptor | undefined,
  ): Promise<BaseChatModel> {
    const { ChatBedrockConverse } = await import("@langchain/aws");
    const reasoning = supportsReasoning(modelId);

    // The base signatures use `this["ParsedCallOptions"]`, which cannot be named
    // from this dynamically imported class, so only `messages` remains typed.
    class ReasoningSafeChatBedrockConverse extends ChatBedrockConverse {
      override get profile() {
        return withContextWindow(super.profile, descriptor?.contextWindow);
      }

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      private outbound(messages: BaseMessage[], options: any): [BaseMessage[], any] {
        const rewritten = normalizeMultimodalToolResultsForBedrock(
          sanitizeDocumentNamesForBedrock(stripReasoningForBedrock(messages)),
        );
        if (options?.cache_control && endsWithCacheIncompatibleDocument(rewritten)) {
          const { cache_control: _dropped, ...rest } = options;
          return [rewritten, rest];
        }
        return [rewritten, options];
      }

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      override async _generate(messages: BaseMessage[], ...rest: [options: any, runManager?: any]) {
        const [outMessages, outOptions] = this.outbound(messages, rest[0]);
        const result = await super._generate(outMessages, outOptions, rest[1]);
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
        const [outMessages, outOptions] = this.outbound(messages, rest[0]);
        return super._streamResponseChunks(outMessages, outOptions, rest[1]);
      }

      override async *_streamChatModelEvents(
        messages: BaseMessage[],
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        ...rest: [options: any, runManager?: any]
      ) {
        const [outMessages, outOptions] = this.outbound(messages, rest[0]);
        for await (const event of super._streamChatModelEvents(outMessages, outOptions, rest[1])) {
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

  private async listMantleModels(): Promise<RoutedModel[]> {
    const response = await (await this.mantleFetch())(
      `${mantleEndpoint(this.region)}/v1/models`,
      {
        ...(this.bedrockApiKey
          ? { headers: { authorization: `Bearer ${this.bedrockApiKey}` } }
          : {}),
        signal: AbortSignal.timeout(5_000),
      },
    );
    if (!response.ok) throw catalogHttpError("Amazon Bedrock Mantle", response.status);
    const body = (await response.json()) as MantleModelsResponse;
    return (body.data ?? []).flatMap((model) => {
      if (!model.id || !isConversationalModel(model.id)) return [];
      return [{
        descriptor: {
          id: model.id,
          provider: "bedrock",
          displayName: `${model.display_name ?? model.id} (Bedrock)`,
          supportsTools: true,
        },
        protocol: mantleProtocol(model.id),
      }];
    });
  }

  private async mantleFetch(): Promise<typeof fetch> {
    if (this.bedrockApiKey) return this.fetchFn;
    this.mantleFetchPromise ??= (async () =>
      createSigV4Fetch(this.region, await this.credentials(), this.fetchFn))();
    return this.mantleFetchPromise;
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

interface MantleModelsResponse {
  data?: Array<{
    id?: string;
    display_name?: string;
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

function withConverseProtocol(descriptor: ModelDescriptor): RoutedModel {
  return { descriptor, protocol: "converse" };
}

function withDefaultProtocol(descriptor: ModelDescriptor): RoutedModel {
  return { descriptor, protocol: defaultProtocol(descriptor.id) };
}

function defaultProtocol(modelId: string): BedrockProtocol {
  const id = modelId.toLowerCase();
  if (id.startsWith("openai.")) return "responses";
  if (id.startsWith("anthropic.")) return "messages";
  return "converse";
}

function mantleProtocol(modelId: string): BedrockProtocol {
  const id = modelId.toLowerCase();
  if (id.startsWith("xai.") || id.startsWith("google.gemma-4-")) {
    return "responses";
  }
  const protocol = defaultProtocol(modelId);
  return protocol === "converse" ? "chat-completions" : protocol;
}

function protocolDisplayName(
  displayName: string,
  protocol: BedrockProtocol,
): string {
  const name = displayName.replace(/ \(Bedrock\)$/, "");
  return `${name} (${protocol === "converse" ? "Runtime" : "Mantle"})`;
}

function mergeRoutedModels(models: RoutedModel[]): RoutedModel[] {
  const merged = new Map<string, RoutedModel>();
  for (const model of models) {
    const existing = merged.get(model.descriptor.id);
    merged.set(model.descriptor.id, existing
      ? {
          descriptor: { ...existing.descriptor, ...model.descriptor },
          protocol: model.protocol,
        }
      : model);
  }
  return [...merged.values()];
}
