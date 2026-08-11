import { useCallback, useEffect, useState } from "react";

export interface DesktopConnection {
  state: PizzaConnectionState | undefined;
  useRemote(input: {
    remoteUrl: string;
    token?: string | null;
  }): Promise<void>;
  useLocal(): Promise<void>;
}

export function useDesktopConnection(): DesktopConnection | undefined {
  const bridge =
    typeof window !== "undefined" ? window.__PIZZA_CONNECTION__ : undefined;
  const [state, setState] = useState<PizzaConnectionState>();

  useEffect(() => {
    let alive = true;
    if (!bridge) return;
    void bridge.get().then((next) => {
      if (alive) setState(next);
    });
    return () => {
      alive = false;
    };
  }, [bridge]);

  const useRemote = useCallback(
    async (input: { remoteUrl: string; token?: string | null }) => {
      if (!bridge) throw new Error("Backend switching is only available in the desktop app.");
      setState(await bridge.useRemote(input));
    },
    [bridge],
  );
  const useLocal = useCallback(async () => {
    if (!bridge) throw new Error("Backend switching is only available in the desktop app.");
    setState(await bridge.useLocal());
  }, [bridge]);

  return bridge ? { state, useRemote, useLocal } : undefined;
}
