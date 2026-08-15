/** Saved secret fields contain `${ENV_REF}` names, never plaintext values. */
export interface SavedProviderConfig {
  method: string;
  values: Record<string, string>;
}

export interface ProviderModelPreferences {
  mode: "all" | "selected";
  selected: string[];
  overrides?: Record<string, ModelOverrides>;
}

export interface ModelOverrides {
  contextWindow: number;
}

export const MAX_CONTEXT_WINDOW = 10_000_000;
export const MAX_MODEL_OVERRIDES = 5_000;

export function isValidContextWindow(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0 &&
    (value as number) <= MAX_CONTEXT_WINDOW;
}

export function parseModelOverrides(
  value: unknown,
): NonNullable<ProviderModelPreferences["overrides"]> | null {
  if (value === undefined) return {};
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const entries = Object.entries(value);
  if (entries.length > MAX_MODEL_OVERRIDES) return null;

  const overrides: NonNullable<ProviderModelPreferences["overrides"]> = {};
  for (const [modelId, candidate] of entries) {
    if (
      !modelId ||
      modelId.length > 512 ||
      !candidate ||
      typeof candidate !== "object" ||
      Array.isArray(candidate)
    ) {
      return null;
    }
    const contextWindow = (candidate as { contextWindow?: unknown }).contextWindow;
    if (!isValidContextWindow(contextWindow)) return null;
    overrides[modelId] = { contextWindow };
  }
  return overrides;
}

const ENV_REFERENCE = /^\$\{[A-Za-z_][A-Za-z0-9_]*\}$/;

/** A secret field may only be persisted as a `${NAME}` reference, never a raw value. */
export function isEnvReference(value: string): boolean {
  return ENV_REFERENCE.test(value);
}

export function envReferenceName(value: string): string | undefined {
  return isEnvReference(value) ? value.slice(2, -1) : undefined;
}

export interface ProviderConfigPort {
  getConfig(providerId: string): SavedProviderConfig | undefined;
  listConfigs(): Record<string, SavedProviderConfig>;
  setConfig(providerId: string, config: SavedProviderConfig): void;
  removeConfig(providerId: string): void;
  getDefaultModel(): string | undefined;
  setDefaultModel(qualified: string | null): void;
  getModelPreferences(providerId: string): ProviderModelPreferences | undefined;
  setModelPreferences(providerId: string, preferences: ProviderModelPreferences): void;
  removeModelPreferences(providerId: string): void;
}
