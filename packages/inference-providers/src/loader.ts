/** Registers built-in inference providers. */
import type { ModelProvider, ModelRegistry, ProviderConfigPort } from "@pizza-bot/core";
import { expandMcpEnvVars } from "@pizza-bot/plugin-sdk";
import { BedrockLangChainModelProvider, discoverAwsProfiles } from "./providers/bedrock/index.js";
import { AnthropicLangChainModelProvider } from "./providers/anthropic.js";
import { GoogleLangChainModelProvider } from "./providers/google.js";
import { OpenAiLangChainModelProvider } from "./providers/openai.js";
import { OpenRouterLangChainModelProvider } from "./providers/openrouter.js";
import { RequestyLangChainModelProvider } from "./providers/requesty.js";
import { OpperLangChainModelProvider } from "./providers/opper.js";
import { UberLlmLangChainModelProvider } from "./providers/uberllm.js";
import { CheaperInferenceLangChainModelProvider } from "./providers/cheaperinference.js";
import { OllamaLangChainModelProvider } from "./providers/ollama.js";

/** Resolve saved secret references before a provider can build its first model. */
export async function registerBuiltinProviders(registry: ModelRegistry, configs?: ProviderConfigPort): Promise<void> {
  const bedrockConfig = configs?.getConfig("bedrock");
  const configuredProfile = bedrockConfig?.method === "aws-profile"
    ? bedrockConfig.values.profile?.trim() || undefined
    : undefined;
  const providers: ModelProvider[] = [
    new BedrockLangChainModelProvider({
      profiles: await discoverAwsProfiles(),
      ...(configuredProfile ? { profile: configuredProfile } : {}),
    }),
    new AnthropicLangChainModelProvider(),
    new GoogleLangChainModelProvider(),
    new OpenAiLangChainModelProvider(),
    new OpenRouterLangChainModelProvider(),
    new RequestyLangChainModelProvider(),
    new OpperLangChainModelProvider(),
    new UberLlmLangChainModelProvider(),
    new CheaperInferenceLangChainModelProvider(),
    new OllamaLangChainModelProvider(),
  ];
  for (const provider of providers) {
    const saved = configs?.getConfig(provider.id);
    if (saved && provider.configure) {
      // Expand secret references in memory; persisted config remains indirect.
      // A saved config can stop validating once its env references change, and one
      // provider must not keep the backend from starting; it stays unconfigured.
      try {
        provider.configure(expandMcpEnvVars({ method: saved.method, values: saved.values }));
      } catch (err) {
        console.warn(
          `[providers] ignoring saved ${provider.id} settings: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    registry.register(provider);
    const preferences = configs?.getModelPreferences(provider.id);
    if (preferences?.mode === "selected") {
      registry.setEnabledModels(provider.id, preferences.selected);
    }
  }
}
