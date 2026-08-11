import type { ModelsInfo, ProviderView, StatusInfo } from "@/api-client";

export type ModelOption = ModelsInfo["models"][number];

export interface ModelGroup {
  provider: string;
  models: Array<{ model: ModelOption; index: number }>;
}

export function groupModelsByProvider(models: ModelOption[]): ModelGroup[] {
  const groups = new Map<string, Array<{ model: ModelOption; index: number }>>();
  models.forEach((model, index) => {
    const group = groups.get(model.provider) ?? [];
    group.push({ model, index });
    groups.set(model.provider, group);
  });
  return Array.from(groups, ([provider, group]) => ({ provider, models: group }));
}

export function providerLabel(provider: string): string {
  if (provider.toLowerCase() === "openai") return "Open AI";
  if (provider.toLowerCase() === "openrouter") return "OpenRouter";
  if (provider.toLowerCase() === "bedrock") return "Amazon Bedrock";
  return provider
    .split(/[-_]/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

export function configuredModels(models: ModelsInfo, providers: ProviderView[]): ModelsInfo {
  const configuredProviderIds = new Set(
    providers
      .filter((provider) => provider.availableWithoutConfig || provider.config !== undefined)
      .map((provider) => provider.id),
  );
  const preferences = new Map(providers.map((provider) => [provider.id, provider.modelPreferences]));
  const available = models.models.filter((model) => {
    if (!configuredProviderIds.has(model.provider)) return false;
    const selection = preferences.get(model.provider);
    if (!selection || selection.mode === "all") return true;
    const rawId = model.id.startsWith(`${model.provider}:`)
      ? model.id.slice(model.provider.length + 1)
      : model.id;
    return selection.selected.includes(rawId);
  });
  const defaultModel = available.some((model) => model.id === models.default)
    ? models.default
    : available[0]?.id ?? "";

  return { models: available, default: defaultModel };
}

export function availableModels(
  models: ModelsInfo,
  providers: StatusInfo["inference"]["providers"] | undefined,
): ModelsInfo {
  if (providers === undefined) return models;

  const connectedProviderIds = new Set(
    providers
      .filter((provider) => provider.status === "connected")
      .map((provider) => provider.name),
  );
  const available = models.models.filter((model) => connectedProviderIds.has(model.provider));
  const defaultModel = available.some((model) => model.id === models.default)
    ? models.default
    : available[0]?.id ?? "";

  return { models: available, default: defaultModel };
}

export function reconcileSelectedModel(selected: string, models: ModelsInfo): string {
  if (models.models.some((model) => model.id === selected)) return selected;
  if (models.models.some((model) => model.id === models.default)) return models.default;
  return models.models[0]?.id ?? "";
}
