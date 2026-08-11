import { useEffect, useRef } from "react";
import { findAction, type HotkeyScope } from "./catalog.js";
import { useHotkeyContext } from "./HotkeyProvider.js";

export interface HotkeyOptions {
  enabled?: boolean;
  allowDefault?: boolean;
  layerId?: string;
}

export function useHotkey(
  actionId: string,
  handler: (e: KeyboardEvent) => void,
  opts: HotkeyOptions = {},
): void {
  const action = findAction(actionId);
  const spec = action?.defaultChord;
  const scope = action?.scope;
  useHotkeyChord(spec, scope, handler, opts);
}

export function useThreadIndexHotkeys(onSelect: (index: number) => void): void {
  const { engine } = useHotkeyContext();
  const onSelectRef = useRef(onSelect);
  onSelectRef.current = onSelect;

  useEffect(() => {
    const unbinds = Array.from({ length: 9 }, (_, i) =>
      engine.register(`CmdOrCtrl+${i + 1}`, "global", () => onSelectRef.current(i)),
    );
    return () => unbinds.forEach((u) => u());
  }, [engine]);
}

export function useHotkeyChord(
  spec: string | undefined,
  scope: HotkeyScope | undefined,
  handler: (e: KeyboardEvent) => void,
  opts: HotkeyOptions = {},
): void {
  const { engine } = useHotkeyContext();
  const handlerRef = useRef(handler);
  // Read the latest handler without unregistering and reordering the binding.
  handlerRef.current = handler;

  const enabled = opts.enabled ?? true;
  const { allowDefault, layerId } = opts;

  useEffect(() => {
    if (!enabled || !spec || !scope) return;
    return engine.register(
      spec,
      scope,
      (e) => handlerRef.current(e),
      {
        preventDefault: !allowDefault,
        ...(layerId ? { layerId } : {}),
      },
    );
  }, [engine, spec, scope, enabled, allowDefault, layerId]);
}
