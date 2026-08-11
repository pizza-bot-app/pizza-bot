import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useAppToast } from "./components/AppToast.js";

export interface DesktopNotificationPreferences {
  notifyOnRunCompletion: boolean;
  notifyOnActionRequired: boolean;
}

export interface DesktopNotifications
  extends DesktopNotificationPreferences {
  setPreference(
    key: keyof DesktopNotificationPreferences,
    value: boolean,
  ): void;
}

const DEFAULT_PREFERENCES: DesktopNotificationPreferences = {
  notifyOnRunCompletion: true,
  notifyOnActionRequired: true,
};

export function useDesktopNotifications(
  onOpenThread: (threadId: string) => void,
  activeThreadId: string | null,
): DesktopNotifications | undefined {
  const toast = useAppToast();
  const bridge =
    typeof window === "undefined" ? undefined : window.__PIZZA_NOTIFICATIONS__;
  const [preferences, setPreferences] =
    useState<DesktopNotificationPreferences>();
  const preferencesRef = useRef(DEFAULT_PREFERENCES);
  const requestVersionsRef = useRef<
    Record<keyof DesktopNotificationPreferences, number>
  >({
    notifyOnRunCompletion: 0,
    notifyOnActionRequired: 0,
  });

  useEffect(() => {
    if (!bridge) return;
    let alive = true;
    void bridge
      .getSettings()
      .then((settings) => {
        if (alive) {
          preferencesRef.current = settings;
          setPreferences(settings);
        }
      })
      .catch((error) => {
        console.error("load desktop notification settings failed", error);
        if (alive) {
          preferencesRef.current = DEFAULT_PREFERENCES;
          setPreferences(DEFAULT_PREFERENCES);
        }
      });
    return () => {
      alive = false;
    };
  }, [bridge]);

  useEffect(() => {
    if (!bridge) return;
    return bridge.onOpenThread(onOpenThread);
  }, [bridge, onOpenThread]);

  useEffect(() => {
    if (!bridge) return;
    const publishActiveThread = () => {
      bridge.setActiveThread(activeThreadId);
    };
    publishActiveThread();
    window.addEventListener("focus", publishActiveThread);
    return () => {
      window.removeEventListener("focus", publishActiveThread);
    };
  }, [activeThreadId, bridge]);

  const setPreference = useCallback(
    (key: keyof DesktopNotificationPreferences, value: boolean) => {
      if (!bridge) return;
      const previous = preferencesRef.current[key];
      const requestVersion = ++requestVersionsRef.current[key];
      const optimistic = {
        ...preferencesRef.current,
        [key]: value,
      };
      preferencesRef.current = optimistic;
      setPreferences(optimistic);
      void bridge
        .updateSettings({ [key]: value })
        .then((settings) => {
          if (requestVersionsRef.current[key] !== requestVersion) return;
          const confirmed = {
            ...preferencesRef.current,
            [key]: settings[key],
          };
          preferencesRef.current = confirmed;
          setPreferences(confirmed);
        })
        .catch((error) => {
          if (requestVersionsRef.current[key] !== requestVersion) return;
          const rolledBack = {
            ...preferencesRef.current,
            [key]: previous,
          };
          preferencesRef.current = rolledBack;
          setPreferences(rolledBack);
          toast({
            title: "Couldn't save notification settings",
            description: error instanceof Error ? error.message : undefined,
            tone: "error",
          });
        });
    },
    [bridge, toast],
  );

  return useMemo(
    () =>
      bridge && preferences
        ? {
            ...preferences,
            setPreference,
          }
        : undefined,
    [bridge, preferences, setPreference],
  );
}
