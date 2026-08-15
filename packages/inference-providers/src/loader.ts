/** Registers built-in inference providers. */
import type { ModelProvider, ModelRegistry, ProviderConfigPort } from "@pizza-bot/core";
import { expandMcpEnvVars } from "@pizza-bot/plugin-sdk";
import { BedrockLangChainModelProvider, discoverAwsProfiles } from "./providers/bedrock/index.js";
import { AnthropicLangChainModelProvider } from "./providers/anthropic.js";
import { GoogleLangChainModelProvider } from "./providers/google.js";
import { OpenAiLangChainModelProvider } from "./providers/openai.js";
import { OpenRouterLangChainModelProvider } from "./providers/openrouter.js";
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
    new OllamaLangChainModelProvider(),
  ];
  for (const provider of providers) {
    const saved = configs?.getConfig(provider.id);
    if (saved && provider.configure) {
      // Expand secret references in memory; persisted config remains indirect.
      provider.configure(expandMcpEnvVars({ method: saved.method, values: saved.values }));
    }
    registry.register(provider);
    const preferences = configs?.getModelPreferences(provider.id);
    if (preferences?.mode === "selected") {
      registry.setEnabledModels(provider.id, preferences.selected);
    }
    registry.setModelOverrides(provider.id, preferences?.overrides);
  }
}
