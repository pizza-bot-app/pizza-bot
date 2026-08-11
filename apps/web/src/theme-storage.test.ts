import { describe, expect, it } from "vitest";
import {
  commitTheme,
  readPendingTheme,
  stageThemePreference,
  THEME_PENDING_STORAGE_KEY,
  THEME_STORAGE_KEY,
} from "./theme-storage.js";

class MemoryStorage {
  private readonly values = new Map<string, string>();

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }

  removeItem(key: string): void {
    this.values.delete(key);
  }
}

describe("theme storage", () => {
  it("stages a selection as both the cached and pending preference", () => {
    const storage = new MemoryStorage();
    stageThemePreference(storage, "light");
    expect(storage.getItem(THEME_STORAGE_KEY)).toBe("light");
    expect(readPendingTheme(storage)).toBe("light");
  });

  it("commits the saved value and clears the pending marker", () => {
    const storage = new MemoryStorage();
    stageThemePreference(storage, "light");
    commitTheme(storage, "light", "light");
    expect(storage.getItem(THEME_STORAGE_KEY)).toBe("light");
    expect(storage.getItem(THEME_PENDING_STORAGE_KEY)).toBeNull();
  });

  it("leaves a newer pending selection intact when an older save commits", () => {
    const storage = new MemoryStorage();
    stageThemePreference(storage, "light");
    stageThemePreference(storage, "dark");
    commitTheme(storage, "light", "light");
    expect(readPendingTheme(storage)).toBe("dark");
  });
});
