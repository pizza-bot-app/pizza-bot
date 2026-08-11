/** Resolves top-layer, active-zone, then typing-safe global bindings. */
import type { Chord } from "./keys.js";
import { chordEquals, isInputSafe } from "./keys.js";
import type { HotkeyScope } from "./catalog.js";

export interface Binding {
  regId: string;
  chord: Chord;
  scope: HotkeyScope;
  layerId?: string;
}

export interface ResolveContext {
  chord: Chord;
  /** Layer IDs ordered bottom to top. */
  layerStack: string[];
  activeZone: string | null;
  typing: boolean;
  bindings: Binding[];
}

/**
 * An open layer returns null for unmatched chords instead of falling through to
 * the application beneath it.
 */
export function resolveBinding(ctx: ResolveContext): Binding | null {
  const matches = ctx.bindings.filter((b) => chordEquals(b.chord, ctx.chord));
  if (matches.length === 0) return null;

  const topLayer = ctx.layerStack[ctx.layerStack.length - 1];
  if (topLayer !== undefined) {
    return matches.find((b) => b.scope === "layer" && b.layerId === topLayer) ?? null;
  }

  if (ctx.activeZone !== null) {
    const zoneScope: HotkeyScope = `zone:${ctx.activeZone}`;
    const zoneMatch = matches.find((b) => b.scope === zoneScope);
    if (zoneMatch) return zoneMatch;
  }

  const globalMatch = matches.find((b) => b.scope === "global");
  if (globalMatch && (!ctx.typing || isInputSafe(ctx.chord))) return globalMatch;

  return null;
}
