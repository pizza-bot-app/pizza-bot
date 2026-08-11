/** Pure, platform-explicit keyboard chord primitives. */

export type Platform = "mac" | "other";

export interface Chord {
  key: string;
  meta: boolean;
  ctrl: boolean;
  shift: boolean;
  alt: boolean;
}

export interface KeyEventLike {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
}

const KEY_ALIASES: Record<string, string> = {
  esc: "escape",
  up: "arrowup",
  down: "arrowdown",
  left: "arrowleft",
  right: "arrowright",
  " ": "space",
  spacebar: "space",
  return: "enter",
  del: "delete",
  plus: "+",
};

function normalizeKey(raw: string): string {
  const lower = raw.toLowerCase();
  return KEY_ALIASES[lower] ?? lower;
}

/**
 * Modifier tokens are case-insensitive. `Mod` and `CmdOrCtrl` resolve to Command
 * on macOS and Control elsewhere.
 */
export function parseChord(spec: string, platform: Platform): Chord {
  const chord: Chord = { key: "", meta: false, ctrl: false, shift: false, alt: false };
  // Preserve a trailing literal plus key before splitting on plus delimiters.
  const trailingPlus = spec.endsWith("+") && spec.length > 1;
  const body = trailingPlus ? spec.slice(0, -1) : spec;
  const tokens = body
    .split("+")
    .map((t) => t.trim())
    .filter((t) => t.length > 0);
  if (trailingPlus) tokens.push("+");
  tokens.forEach((token, i) => {
    const t = token.toLowerCase();
    const isLast = i === tokens.length - 1;
    switch (t) {
      case "cmd":
      case "command":
      case "meta":
      case "super":
      case "win":
        chord.meta = true;
        return;
      case "ctrl":
      case "control":
        chord.ctrl = true;
        return;
      case "shift":
        chord.shift = true;
        return;
      case "alt":
      case "opt":
      case "option":
        chord.alt = true;
        return;
      case "mod":
      case "cmdorctrl":
        if (platform === "mac") chord.meta = true;
        else chord.ctrl = true;
        return;
      default:
        if (isLast || chord.key === "") chord.key = normalizeKey(token);
    }
  });
  return chord;
}

export function eventToChord(e: KeyEventLike): Chord {
  return {
    key: normalizeKey(e.key),
    meta: e.metaKey,
    ctrl: e.ctrlKey,
    shift: e.shiftKey,
    alt: e.altKey,
  };
}

export function chordKey(chord: Chord): string {
  return `${chord.meta ? 1 : 0}${chord.ctrl ? 1 : 0}${chord.shift ? 1 : 0}${chord.alt ? 1 : 0}:${chord.key}`;
}

export function chordEquals(a: Chord, b: Chord): boolean {
  return (
    a.key === b.key &&
    a.meta === b.meta &&
    a.ctrl === b.ctrl &&
    a.shift === b.shift &&
    a.alt === b.alt
  );
}

/**
 * Global shortcuts may fire while typing only for Command/Control chords,
 * Escape, and function keys. Focus-scoped bindings apply their own policy.
 */
export function isInputSafe(chord: Chord): boolean {
  if (chord.meta || chord.ctrl) return true;
  if (chord.key === "escape") return true;
  return /^f([1-9]|1[0-2])$/.test(chord.key);
}

const KEY_LABELS: Record<string, string> = {
  escape: "Esc",
  enter: "↵",
  arrowup: "↑",
  arrowdown: "↓",
  arrowleft: "←",
  arrowright: "→",
  space: "Space",
  backspace: "⌫",
  delete: "Del",
  tab: "⇥",
};

function keyLabel(key: string): string {
  if (KEY_LABELS[key]) return KEY_LABELS[key];
  if (key.length === 1) return key.toUpperCase();
  return key.charAt(0).toUpperCase() + key.slice(1);
}

/** macOS uses canonical modifier glyph order; other platforms use joined labels. */
export function formatChord(chord: Chord, platform: Platform): string {
  if (platform === "mac") {
    let out = "";
    if (chord.ctrl) out += "⌃";
    if (chord.alt) out += "⌥";
    if (chord.shift) out += "⇧";
    if (chord.meta) out += "⌘";
    return out + keyLabel(chord.key);
  }
  const parts: string[] = [];
  if (chord.ctrl) parts.push("Ctrl");
  if (chord.meta) parts.push("Meta");
  if (chord.alt) parts.push("Alt");
  if (chord.shift) parts.push("Shift");
  parts.push(keyLabel(chord.key));
  return parts.join("+");
}

export function formatChordSpec(spec: string, platform: Platform): string {
  return formatChord(parseChord(spec, platform), platform);
}
