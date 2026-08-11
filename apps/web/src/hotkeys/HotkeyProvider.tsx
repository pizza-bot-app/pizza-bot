import { createContext, useContext, useEffect, useMemo, type ReactNode } from "react";
import { formatChord, parseChord, type Platform } from "./keys.js";
import { getHotkeyEngine, type HotkeyEngine } from "./engine.js";

interface HotkeyContextValue {
  engine: HotkeyEngine;
  platform: Platform;
  formatSpec: (spec: string) => string;
}

const HotkeyCtx = createContext<HotkeyContextValue | null>(null);

export function HotkeyProvider({ children }: { children: ReactNode }) {
  const engine = useMemo(() => getHotkeyEngine(), []);

  useEffect(() => {
    // The singleton intentionally survives provider remounts; cleanup must not stop it.
    engine.start();
  }, [engine]);

  const value = useMemo<HotkeyContextValue>(
    () => ({
      engine,
      platform: engine.platform,
      formatSpec: (spec: string) => formatChord(parseChord(spec, engine.platform), engine.platform),
    }),
    [engine],
  );

  return <HotkeyCtx.Provider value={value}>{children}</HotkeyCtx.Provider>;
}

export function useHotkeyContext(): HotkeyContextValue {
  const ctx = useContext(HotkeyCtx);
  if (!ctx) throw new Error("useHotkeyContext must be used within a HotkeyProvider");
  return ctx;
}
