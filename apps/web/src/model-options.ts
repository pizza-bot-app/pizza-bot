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

export interface ModelFavorites {
  ids: readonly string[];
  toggle: (modelId: string) => void;
}

export interface ModelSection {
  key: string;
  label: string;
  models: Array<{ model: ModelOption; index: number }>;
}

/** Favorites first, then provider groups; `index` is the row's position in render order. */
export function sectionModels(models: ModelOption[], favoriteIds: readonly string[]): ModelSection[] {
  const favorites = new Set(favoriteIds);
  const favoriteSection = {
    key: "favorites",
    label: "Favorites",
    models: models.filter((model) => favorites.has(model.id)),
  };
  const providerSections = groupModelsByProvider(models.filter((model) => !favorites.has(model.id)))
    .map((group) => ({
      key: `provider:${group.provider}`,
      label: providerLabel(group.provider),
      models: group.models.map(({ model }) => model),
    }));
  return [favoriteSection, ...providerSections]
    .filter((section) => section.models.length > 0)
    .reduce<ModelSection[]>((sections, section) => {
      const start = sections.reduce((count, s) => count + s.models.length, 0);
      return [...sections, { ...section, models: section.models.map((model, i) => ({ model, index: start + i })) }];
    }, []);
}

export function toggleFavorite(favoriteIds: readonly string[], modelId: string): string[] {
  return favoriteIds.includes(modelId)
    ? favoriteIds.filter((id) => id !== modelId)
    : [...favoriteIds, modelId];
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

  return { ...models, models: available, default: defaultModel };
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

  return { ...models, models: available, default: defaultModel };
}

export function reconcileSelectedModel(selected: string, models: ModelsInfo): string {
  if (models.models.some((model) => model.id === selected)) return selected;
  if (models.models.some((model) => model.id === models.default)) return models.default;
  return models.models[0]?.id ?? "";
}
