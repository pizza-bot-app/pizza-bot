/** Saved secret fields contain `${ENV_REF}` names, never plaintext values. */
export interface SavedProviderConfig {
  method: string;
  values: Record<string, string>;
}

export interface ProviderModelPreferences {
  mode: "all" | "selected";
  selected: string[];
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
