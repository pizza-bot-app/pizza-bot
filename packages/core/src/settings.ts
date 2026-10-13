export type ThemePreference = "light" | "dark" | "system";

export interface AppSettings {
  theme: ThemePreference;
  /**
   * Free-text persona appended to the assistant's base system prompt. Additive
   * only — the base prompt is never editable or replaceable.
   */
  customPromptAddendum: string;
  /** Gates the durable /memories/ pool and its rail button. */
  enableMemories: boolean;
  /** Gates the triggers/automations feature and its rail button. */
  enableAutomations: boolean;
  /** Per-run orchestrator tool-call limit; -1 disables the limit. */
  maxToolCalls: number;
  /** Per-run subagent tool-call limit; -1 disables the limit. */
  maxSubagentToolCalls: number;
  /** Qualified model ids (`provider:rawId`) pinned to the top of model pickers. */
  favoriteModels: string[];
}

export type AppSettingsPatch = Partial<AppSettings>;

export const DEFAULT_SETTINGS: AppSettings = {
  theme: "dark",
  customPromptAddendum: "",
  enableMemories: false,
  enableAutomations: false,
  maxToolCalls: 100,
  maxSubagentToolCalls: 150,
  favoriteModels: [],
};

/** Bounds the persona addendum so it cannot bloat every prompt unboundedly. */
export const MAX_PROMPT_ADDENDUM_LENGTH = 8000;

export const MAX_FAVORITE_MODELS = 200;

export function isThemePreference(value: unknown): value is ThemePreference {
  return value === "light" || value === "dark" || value === "system";
}

export function isPromptAddendum(value: unknown): value is string {
  return typeof value === "string" && value.length <= MAX_PROMPT_ADDENDUM_LENGTH;
}

export function isMaxToolCalls(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && (value === -1 || value > 0);
}

export function isFavoriteModels(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.length <= MAX_FAVORITE_MODELS &&
    value.every((id) => typeof id === "string" && id.length > 0) &&
    new Set(value).size === value.length
  );
}
