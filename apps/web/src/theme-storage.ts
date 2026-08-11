import type { ThemePreference } from "@pizza-bot/core";

export type { ThemePreference } from "@pizza-bot/core";
export type ResolvedTheme = "light" | "dark";

// Must match the pre-paint bootstrap in index.html.
export const THEME_STORAGE_KEY = "pizza-theme";
export const THEME_PENDING_STORAGE_KEY = "pizza-theme-pending";

const isBrowser = typeof window !== "undefined";
export type ThemeStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

function isPreference(value: string | null): value is ThemePreference {
  return value === "light" || value === "dark" || value === "system";
}

export function systemTheme(): ResolvedTheme {
  return isBrowser && window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
}

export function resolveTheme(preference: ThemePreference): ResolvedTheme {
  return preference === "system" ? systemTheme() : preference;
}

export function readCachedTheme(): ThemePreference {
  if (!isBrowser) return "dark";
  const stored = window.localStorage.getItem(THEME_STORAGE_KEY);
  return isPreference(stored) ? stored : "dark";
}

export function readPendingTheme(storage: ThemeStorage): ThemePreference | undefined {
  const stored = storage.getItem(THEME_PENDING_STORAGE_KEY);
  return isPreference(stored) ? stored : undefined;
}

// Records an in-flight selection so an interrupted save is retried on reload.
export function stageThemePreference(storage: ThemeStorage, next: ThemePreference): void {
  storage.setItem(THEME_STORAGE_KEY, next);
  storage.setItem(THEME_PENDING_STORAGE_KEY, next);
}

// Clears the pending marker unless a newer selection was staged meanwhile.
export function commitTheme(storage: ThemeStorage, attempted: ThemePreference, saved: ThemePreference): void {
  if (readPendingTheme(storage) !== attempted) return;
  storage.removeItem(THEME_PENDING_STORAGE_KEY);
  storage.setItem(THEME_STORAGE_KEY, saved);
}

export function applyTheme(resolved: ResolvedTheme): void {
  if (!isBrowser) return;
  const el = document.documentElement;
  el.classList.toggle("dark", resolved === "dark");
  el.classList.toggle("light", resolved === "light");
}
