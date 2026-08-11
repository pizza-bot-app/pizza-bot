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
}

export type AppSettingsPatch = Partial<AppSettings>;

export const DEFAULT_SETTINGS: AppSettings = {
  theme: "dark",
  customPromptAddendum: "",
  enableMemories: false,
  enableAutomations: false,
};

/** Bounds the persona addendum so it cannot bloat every prompt unboundedly. */
export const MAX_PROMPT_ADDENDUM_LENGTH = 8000;

export function isThemePreference(value: unknown): value is ThemePreference {
  return value === "light" || value === "dark" || value === "system";
}

export function isPromptAddendum(value: unknown): value is string {
  return typeof value === "string" && value.length <= MAX_PROMPT_ADDENDUM_LENGTH;
}
