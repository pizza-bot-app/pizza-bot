/** Local Ollama provider with a daemon-backed model catalog. */
import { AsyncLocalStorage } from "node:async_hooks";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { AIMessage, AIMessageChunk, type BaseMessage } from "@langchain/core/messages";
import type { CallbackManagerForLLMRun } from "@langchain/core/callbacks/manager";
import type { ChatGenerationChunk, ChatResult } from "@langchain/core/outputs";
import type { ChatModelStreamEvent } from "@langchain/core/language_models/event";
import type { ModelProvider, ModelDescriptor, ResolvedProviderConfig, ProviderAuthMethod } from "@pizza-bot/core";
import {
  buildToolArgNames,
  coerceOllamaMessageContent,
  coerceStringifiedToolArgs,
  coerceStringifiedToolArgsEvent,
  ensureToolCallId,
} from "./ollama-tool-call-fix.js";
import { withContextWindow } from "../model-profile.js";
import {
  catalogConnectionError,
  catalogHttpError,
} from "../catalog-error.js";

const DEFAULT_HOST = "http://localhost:11434";
const DEFAULT_CONTEXT_LENGTH = 32_768;
const FETCH_TIMEOUT_MS = 5_000;

interface OllamaTagsResponse {
  models?: Array<{ name: string }>;
}

interface OllamaShowResponse {
  capabilities?: string[];
  model_info?: Record<string, unknown>;
}

type ThinkingMode = "auto" | "enabled" | "disabled";

const AUTH_SCHEMA: readonly ProviderAuthMethod[] = [
  {
    id: "local",
    label: "Local daemon",
    fields: [
      { key: "host", label: "Host", type: "text", required: false, default: DEFAULT_HOST },
      {
        key: "contextLength",
        label: "Context window",
        type: "text",
        required: false,
        default: String(DEFAULT_CONTEXT_LENGTH),
      },
      {
        key: "thinking",
        label: "Thinking",
        type: "select",
        required: false,
        default: "auto",
        options: [
          { value: "auto", label: "Auto" },
          { value: "enabled", label: "Enabled" },
          { value: "disabled", label: "Disabled" },
        ],
      },
    ],
  },
];

export interface OllamaProviderOptions {
  host?: string;
  contextLength?: number;
  thinking?: ThinkingMode;
  fetch?: typeof fetch;
}

export class OllamaLangChainModelProvider implements ModelProvider {
  readonly id = "ollama";
  readonly authSchema = AUTH_SCHEMA;
  readonly availableWithoutConfig = true;
  private host: string;
  private contextLength: number;
  private thinking: ThinkingMode;
  private readonly fetchFn: typeof fetch;

  constructor(opts: OllamaProviderOptions = {}) {
    this.host = normalizeHost(opts.host ?? process.env.OLLAMA_HOST ?? DEFAULT_HOST);
    this.contextLength = opts.contextLength ?? DEFAULT_CONTEXT_LENGTH;
    this.thinking = opts.thinking ?? "auto";
    this.fetchFn = opts.fetch ?? fetch;
  }

  configure(cfg: ResolvedProviderConfig): void {
    this.host = normalizeHost(
      cfg.values.host?.trim() || process.env.OLLAMA_HOST || DEFAULT_HOST,
    );
    this.contextLength = positiveInteger(cfg.values.contextLength) ?? DEFAULT_CONTEXT_LENGTH;
    this.thinking = thinkingMode(cfg.values.thinking);
  }

  async listModels(): Promise<ModelDescriptor[]> {
    let response: Response;
    try {
      response = await this.fetchFn(`${this.host}/api/tags`, {
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
    } catch (cause) {
      throw catalogConnectionError("Ollama", cause);
    }
    if (!response.ok) throw catalogHttpError("Ollama", response.status);
    let data: OllamaTagsResponse;
    try {
      data = (await response.json()) as OllamaTagsResponse;
    } catch (cause) {
      throw catalogConnectionError("Ollama", cause);
    }
    return Promise.all((data.models ?? []).map(async (m) => {
      const details = await this.inspectModel(m.name);
      return {
        id: m.name,
        provider: "ollama",
        displayName: `${m.name} (Ollama)`,
        contextWindow: this.effectiveContextWindow(details),
        supportsTools: details?.capabilities?.includes("tools") ?? true,
        supportsVision: details?.capabilities?.includes("vision") === true,
      };
    }));
  }

  async buildModel(modelId: string): Promise<BaseChatModel> {
    const { ChatOllama } = await import("@langchain/ollama");
    const runSignal = new AsyncLocalStorage<AbortSignal>();
    const fetchWithRunSignal: typeof fetch = (input, init) => {
      const signal = combineSignals(init?.signal, runSignal.getStore());
      return this.fetchFn(input, signal ? { ...init, signal } : init);
    };
    const details = await this.inspectModel(modelId);
    const numCtx = this.effectiveContextWindow(details);
    const supportsVision = details?.capabilities?.includes("vision") === true;
    const think = this.thinking === "enabled" ||
      (this.thinking === "auto" && details?.capabilities?.includes("thinking") === true);
    const modelProfile = {
      maxInputTokens: numCtx,
      imageInputs: supportsVision,
      imageToolMessage: supportsVision,
      reasoningOutput: think,
      toolCalling: details?.capabilities?.includes("tools") ?? true,
    };

    class ToolArgsSafeChatOllama extends ChatOllama {
      override get profile() {
        return withContextWindow({ ...super.profile, ...modelProfile }, numCtx);
      }

      override async _generate(
        messages: BaseMessage[],
        options: this["ParsedCallOptions"],
        runManager?: CallbackManagerForLLMRun,
      ): Promise<ChatResult> {
        const toolArgNames = buildToolArgNames(options.tools);
        const result = await inRunSignal(
          runSignal,
          options.signal,
          () => super._generate(
            coerceOllamaMessageContent(messages, supportsVision),
            options,
            runManager,
          ),
        );
        for (const generation of result.generations) {
          if (
            generation.message instanceof AIMessage ||
            generation.message instanceof AIMessageChunk
          ) {
            coerceStringifiedToolArgs(generation.message, toolArgNames);
          }
        }
        return result;
      }

      override async *_streamResponseChunks(
        messages: BaseMessage[],
        options: this["ParsedCallOptions"],
        runManager?: CallbackManagerForLLMRun,
      ): AsyncGenerator<ChatGenerationChunk> {
        const toolArgNames = buildToolArgNames(options.tools);
        const source = super._streamResponseChunks(
          coerceOllamaMessageContent(messages, supportsVision),
          options,
          runManager,
        );
        for await (const chunk of iterateInRunSignal(source, runSignal, options.signal)) {
          if (chunk.message instanceof AIMessageChunk) {
            coerceStringifiedToolArgs(chunk.message, toolArgNames);
          }
          yield chunk;
        }
      }

      // `streamEvents(v3)` dispatches here, not through `_streamResponseChunks`,
      // so the coercion above never fires on the path production uses.
      override async *_streamChatModelEvents(
        messages: BaseMessage[],
        options: this["ParsedCallOptions"],
        runManager?: CallbackManagerForLLMRun,
      ): AsyncGenerator<ChatModelStreamEvent> {
        const toolCallIds = new Map<number, string>();
        const toolArgNames = buildToolArgNames(options.tools);
        const source = super._streamChatModelEvents(
          coerceOllamaMessageContent(messages, supportsVision),
          options,
          runManager,
        );
        for await (const event of iterateInRunSignal(source, runSignal, options.signal)) {
          yield ensureToolCallId(
            coerceStringifiedToolArgsEvent(event, toolArgNames),
            toolCallIds,
          );
        }
      }
    }

    return new ToolArgsSafeChatOllama({
      model: modelId,
      baseUrl: this.host,
      fetch: fetchWithRunSignal,
      numCtx,
      think,
    });
  }

  private async inspectModel(modelId: string): Promise<OllamaShowResponse | undefined> {
    try {
      const response = await this.fetchFn(`${this.host}/api/show`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: modelId }),
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      if (!response.ok) return undefined;
      return await response.json() as OllamaShowResponse;
    } catch {
      return undefined;
    }
  }

  private effectiveContextWindow(details: OllamaShowResponse | undefined): number {
    const advertisedContext = modelContextLength(details);
    return advertisedContext
      ? Math.min(this.contextLength, advertisedContext)
      : this.contextLength;
  }
}

function normalizeHost(host: string): string {
  return host.replace(/\/$/, "");
}

function positiveInteger(value: string | undefined): number | undefined {
  if (!value?.trim()) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function thinkingMode(value: string | undefined): ThinkingMode {
  return value === "enabled" || value === "disabled" ? value : "auto";
}

function modelContextLength(details: OllamaShowResponse | undefined): number | undefined {
  for (const [key, value] of Object.entries(details?.model_info ?? {})) {
    if (key.endsWith(".context_length") && typeof value === "number" && value > 0) {
      return value;
    }
  }
  return undefined;
}

function inRunSignal<T>(
  storage: AsyncLocalStorage<AbortSignal>,
  signal: AbortSignal | undefined,
  operation: () => T,
): T {
  return signal ? storage.run(signal, operation) : operation();
}

async function* iterateInRunSignal<T>(
  source: AsyncIterable<T>,
  storage: AsyncLocalStorage<AbortSignal>,
  signal: AbortSignal | undefined,
): AsyncGenerator<T> {
  const iterator = source[Symbol.asyncIterator]();
  try {
    for (;;) {
      const next = await inRunSignal(storage, signal, () => iterator.next());
      if (next.done) return;
      yield next.value;
    }
  } finally {
    if (iterator.return) {
      await inRunSignal(storage, signal, () => iterator.return!());
    }
  }
}

function combineSignals(
  requestSignal: AbortSignal | null | undefined,
  runSignal: AbortSignal | undefined,
): AbortSignal | undefined {
  if (!runSignal) return requestSignal ?? undefined;
  if (!requestSignal || requestSignal === runSignal) return runSignal;
  return AbortSignal.any([requestSignal, runSignal]);
}
