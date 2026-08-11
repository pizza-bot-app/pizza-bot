import { eventToChord, parseChord, type Chord, type Platform } from "./keys.js";
import { resolveBinding, type Binding } from "./resolve.js";
import type { HotkeyScope } from "./catalog.js";

interface Registration extends Binding {
  handler: (e: KeyboardEvent) => void;
  preventDefault: boolean;
}

export const ZONE_ATTR = "data-hotkey-zone";

function detectPlatform(): Platform {
  if (typeof navigator === "undefined") return "other";
  const p =
    (navigator as unknown as { userAgentData?: { platform?: string } }).userAgentData?.platform ??
    navigator.platform ??
    "";
  return /mac/i.test(p) ? "mac" : "other";
}

function isEditable(el: Element | null): boolean {
  if (!(el instanceof HTMLElement)) return false;
  const tag = el.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
  return el.isContentEditable;
}

function zoneOf(el: Element | null): string | null {
  const zoneEl = el?.closest?.(`[${ZONE_ATTR}]`);
  return zoneEl?.getAttribute(ZONE_ATTR) ?? null;
}

export class HotkeyEngine {
  readonly platform: Platform = detectPlatform();

  private regs = new Map<string, Registration>();
  private layerStack: string[] = [];
  private nextId = 0;
  private started = false;

  start(): void {
    if (this.started || typeof window === "undefined") return;
    // Bubble phase lets focused widgets consume keys before global bindings.
    window.addEventListener("keydown", this.onKeyDown);
    this.started = true;
  }

  stop(): void {
    if (!this.started) return;
    window.removeEventListener("keydown", this.onKeyDown);
    this.started = false;
  }
  register(
    spec: string,
    scope: HotkeyScope,
    handler: (e: KeyboardEvent) => void,
    opts: { layerId?: string; preventDefault?: boolean } = {},
  ): () => void {
    const regId = `hk-${this.nextId++}`;
    const chord = parseChord(spec, this.platform);
    const reg: Registration = {
      regId,
      chord,
      scope,
      handler,
      preventDefault: opts.preventDefault ?? true,
      ...(opts.layerId ? { layerId: opts.layerId } : {}),
    };
    this.regs.set(regId, reg);
    return () => {
      this.regs.delete(regId);
    };
  }
  pushLayer(layerId: string): () => void {
    // Remove by identity so out-of-order modal teardown cannot corrupt the stack.
    this.layerStack.push(layerId);
    return () => {
      const i = this.layerStack.lastIndexOf(layerId);
      if (i !== -1) this.layerStack.splice(i, 1);
    };
  }

  get topLayer(): string | undefined {
    return this.layerStack[this.layerStack.length - 1];
  }
  private onKeyDown = (e: KeyboardEvent): void => {
    if (e.repeat) return;
    const chord: Chord = eventToChord(e);
    if (chord.key === "" || ["meta", "control", "shift", "alt"].includes(chord.key)) return;

    const target = (e.target as Element | null) ?? null;
    const winner = resolveBinding({
      chord,
      layerStack: this.layerStack,
      activeZone: zoneOf(target),
      typing: isEditable(document.activeElement),
      bindings: [...this.regs.values()],
    });
    if (!winner) return;

    const reg = this.regs.get(winner.regId);
    if (!reg) return;
    if (reg.preventDefault) e.preventDefault();
    reg.handler(e);
  };
}

let singleton: HotkeyEngine | null = null;
export function getHotkeyEngine(): HotkeyEngine {
  if (!singleton) singleton = new HotkeyEngine();
  return singleton;
}
