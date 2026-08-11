import { useCallback, useRef, useState } from "react";

const MAX_ENTRIES = 100;

export interface PromptHistoryCycler {
  isCycling: boolean;
  cycleBack: () => string | null;
  cycleForward: () => string | null;
  stopCycling: () => void;
  addEntry: (text: string) => void;
}

export interface UsePromptHistoryReturn {
  cycler: PromptHistoryCycler;
  addEntry: (text: string) => void;
}

export function usePromptHistory(): UsePromptHistoryReturn {
  const [entries, setEntries] = useState<string[]>([]);
  const indexRef = useRef<number>(-1);
  const [isCycling, setIsCycling] = useState(false);

  const cycleBack = useCallback((): string | null => {
    if (entries.length === 0) return null;
    if (!isCycling) {
      setIsCycling(true);
      indexRef.current = entries.length - 1;
    } else if (indexRef.current > 0) {
      indexRef.current = indexRef.current - 1;
    }
    return entries[indexRef.current] ?? null;
  }, [entries, isCycling]);

  const cycleForward = useCallback((): string | null => {
    if (!isCycling) return null;
    if (indexRef.current < entries.length - 1) {
      indexRef.current = indexRef.current + 1;
      return entries[indexRef.current] ?? null;
    }
    setIsCycling(false);
    indexRef.current = -1;
    return "";
  }, [entries, isCycling]);

  const stopCycling = useCallback(() => {
    if (isCycling) {
      setIsCycling(false);
      indexRef.current = -1;
    }
  }, [isCycling]);

  const addEntry = useCallback((text: string) => {
    const trimmed = text.trim();
    if (trimmed === "") return;
    setEntries((prev) => {
      if (prev.length > 0 && prev[prev.length - 1] === trimmed) return prev;
      const next = [...prev, trimmed];
      return next.length > MAX_ENTRIES ? next.slice(next.length - MAX_ENTRIES) : next;
    });
    indexRef.current = -1;
    setIsCycling(false);
  }, []);

  return { cycler: { isCycling, cycleBack, cycleForward, stopCycling, addEntry }, addEntry };
}
