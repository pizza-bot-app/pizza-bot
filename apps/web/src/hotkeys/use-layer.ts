import { useEffect, useId, useRef } from "react";
import { useHotkeyContext } from "./HotkeyProvider.js";

export interface LayerOptions {
  active?: boolean;
  onEscape?: (e: KeyboardEvent) => void;
}

export function useLayer(name: string, opts: LayerOptions = {}): string {
  const { engine } = useHotkeyContext();
  const { active = true, onEscape } = opts;
  const instanceId = useId();
  const layerId = `${name}:${instanceId}`;

  const escRef = useRef(onEscape);
  escRef.current = onEscape;

  useEffect(() => {
    if (!active) return;
    const popLayer = engine.pushLayer(layerId);
    const unbindEsc = onEscape
      ? engine.register("Escape", "layer", (e) => escRef.current?.(e), { layerId })
      : undefined;
    return () => {
      unbindEsc?.();
      popLayer();
    };
    // Handler identity is read through escRef; only its presence changes binding.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [engine, layerId, active, !!onEscape]);

  return layerId;
}
