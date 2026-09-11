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
  /** Per-run Pizza Bot tool-call limit; -1 disables the limit. */
  maxToolCalls: number;
  /** Per-run skill-agent tool-call limit; -1 disables the limit. */
  maxSkillToolCalls: number;
}

export type AppSettingsPatch = Partial<AppSettings>;

export const DEFAULT_SETTINGS: AppSettings = {
  theme: "dark",
  customPromptAddendum: "",
  enableMemories: false,
  enableAutomations: false,
  maxToolCalls: 40,
  maxSkillToolCalls: 80,
};

/** Bounds the persona addendum so it cannot bloat every prompt unboundedly. */
export const MAX_PROMPT_ADDENDUM_LENGTH = 8000;

export function isThemePreference(value: unknown): value is ThemePreference {
  return value === "light" || value === "dark" || value === "system";
}

export function isPromptAddendum(value: unknown): value is string {
  return typeof value === "string" && value.length <= MAX_PROMPT_ADDENDUM_LENGTH;
}

export function isMaxToolCalls(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && (value === -1 || value > 0);
}
