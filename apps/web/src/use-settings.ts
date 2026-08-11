import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ApiClient } from "@/api-client";
import type { AppSettings, ThemePreference } from "@pizza-bot/core";
import { DEFAULT_SETTINGS } from "@pizza-bot/core";
import { useAppToast } from "./components/AppToast.js";
import {
  applyTheme,
  commitTheme,
  readCachedTheme,
  readPendingTheme,
  resolveTheme,
  stageThemePreference,
  systemTheme,
  THEME_STORAGE_KEY,
  type ResolvedTheme,
  type ThemeStorage,
} from "./theme-storage.js";

export type { ResolvedTheme } from "./theme-storage.js";
export type PersonaSaveStatus = "idle" | "saving" | "saved" | "error";

export interface UseSettingsResult {
  theme: {
    preference: ThemePreference;
    resolved: ResolvedTheme;
    setPreference: (next: ThemePreference) => void;
  };
  persona: {
    value: string;
    status: PersonaSaveStatus;
    setValue: (next: string) => void;
    save: () => void;
  };
  features: {
    enableMemories: boolean;
    enableAutomations: boolean;
    setFlag: (key: "enableMemories" | "enableAutomations", value: boolean) => void;
  };
}

const isBrowser = typeof window !== "undefined";

function errorMessage(err: unknown): string | undefined {
  return err instanceof Error ? err.message : undefined;
}

// One settings resource behind the whole settings surface: a single GET on mount,
// one AppSettings state, and coordinated writes (optimistic + rollback for theme and
// feature flags; explicit save-with-status for the persona textarea).
export function useSettings(client: ApiClient): UseSettingsResult {
  const toast = useAppToast();
  const storage: ThemeStorage | undefined = isBrowser ? window.localStorage : undefined;

  const [settings, setSettings] = useState<AppSettings>(() => ({
    ...DEFAULT_SETTINGS,
    theme: readCachedTheme(),
  }));
  const [resolved, setResolved] = useState<ResolvedTheme>(() => resolveTheme(settings.theme));
  const [personaDraft, setPersonaDraft] = useState("");
  const [personaStatus, setPersonaStatus] = useState<PersonaSaveStatus>("idle");

  useEffect(() => {
    let alive = true;
    void (async () => {
      // Retry an interrupted theme selection before trusting server state.
      const pending = storage && readPendingTheme(storage);
      if (pending) {
        try {
          const saved = await client.updateSettings({ theme: pending });
          if (storage) commitTheme(storage, pending, saved.theme);
          if (alive) {
            setSettings(saved);
            setPersonaDraft(saved.customPromptAddendum);
          }
          return;
        } catch (err) {
          console.error("retry theme failed", err);
        }
      }
      try {
        const saved = await client.getSettings();
        if (!alive || !saved || (storage && readPendingTheme(storage))) return;
        if (storage) storage.setItem(THEME_STORAGE_KEY, saved.theme);
        setSettings(saved);
        setPersonaDraft(saved.customPromptAddendum);
      } catch (err) {
        console.error("load settings failed", err);
      }
    })();
    return () => {
      alive = false;
    };
  }, [client, storage]);

  useEffect(() => {
    if (settings.theme !== "system") {
      applyTheme(settings.theme);
      setResolved(settings.theme);
      return;
    }
    if (!isBrowser) return;
    const mql = window.matchMedia("(prefers-color-scheme: light)");
    const sync = () => {
      const next = systemTheme();
      applyTheme(next);
      setResolved(next);
    };
    sync();
    mql.addEventListener("change", sync);
    return () => mql.removeEventListener("change", sync);
  }, [settings.theme]);

  const setPreference = useCallback(
    (next: ThemePreference) => {
      const previous = settings.theme;
      if (storage) stageThemePreference(storage, next);
      setSettings((s) => ({ ...s, theme: next }));
      void client
        .updateSettings({ theme: next })
        .then((saved) => {
          if (storage) commitTheme(storage, next, saved.theme);
          setSettings(saved);
        })
        .catch((err) => {
          if (storage) stageThemePreference(storage, previous);
          setSettings((s) => ({ ...s, theme: previous }));
          toast({ title: "Couldn't save theme", description: errorMessage(err), tone: "error" });
        });
    },
    [client, settings.theme, storage, toast],
  );

  const setFlag = useCallback(
    (key: "enableMemories" | "enableAutomations", value: boolean) => {
      const previous = settings[key];
      setSettings((s) => ({ ...s, [key]: value }));
      void client
        .updateSettings({ [key]: value })
        .then((saved) => setSettings(saved))
        .catch((err) => {
          setSettings((s) => ({ ...s, [key]: previous }));
          toast({ title: "Couldn't save that setting", description: errorMessage(err), tone: "error" });
        });
    },
    [client, settings, toast],
  );

  const setPersonaValue = useCallback((next: string) => {
    setPersonaDraft(next);
    setPersonaStatus("idle");
  }, []);

  const savedPersonaRef = useRef(settings.customPromptAddendum);
  savedPersonaRef.current = settings.customPromptAddendum;
  const savePersona = useCallback(() => {
    const draft = personaDraft;
    if (draft === savedPersonaRef.current) return;
    setPersonaStatus("saving");
    void client
      .updateSettings({ customPromptAddendum: draft })
      .then((saved) => {
        setSettings(saved);
        setPersonaDraft(saved.customPromptAddendum);
        setPersonaStatus("saved");
      })
      .catch((err) => {
        setPersonaStatus("error");
        toast({ title: "Couldn't save custom instructions", description: errorMessage(err), tone: "error" });
      });
  }, [client, personaDraft, toast]);

  return useMemo(
    () => ({
      theme: { preference: settings.theme, resolved, setPreference },
      persona: { value: personaDraft, status: personaStatus, setValue: setPersonaValue, save: savePersona },
      features: {
        enableMemories: settings.enableMemories,
        enableAutomations: settings.enableAutomations,
        setFlag,
      },
    }),
    [
      settings.theme,
      settings.enableMemories,
      settings.enableAutomations,
      resolved,
      setPreference,
      personaDraft,
      personaStatus,
      setPersonaValue,
      savePersona,
      setFlag,
    ],
  );
}
