import { describe, it, expect } from "vitest";
import {
  parseChord,
  eventToChord,
  chordEquals,
  chordKey,
  isInputSafe,
  formatChordSpec,
  type Chord,
} from "./keys.js";

describe("parseChord", () => {
  it("maps CmdOrCtrl to meta on mac, ctrl elsewhere", () => {
    expect(parseChord("CmdOrCtrl+B", "mac")).toMatchObject({ key: "b", meta: true, ctrl: false });
    expect(parseChord("CmdOrCtrl+B", "other")).toMatchObject({ key: "b", meta: false, ctrl: true });
  });

  it("maps the Mod alias the same way", () => {
    expect(parseChord("Mod+K", "mac").meta).toBe(true);
    expect(parseChord("Mod+K", "other").ctrl).toBe(true);
  });

  it("parses multiple explicit modifiers", () => {
    expect(parseChord("Ctrl+Shift+Alt+P", "mac")).toEqual({
      key: "p",
      meta: false,
      ctrl: true,
      shift: true,
      alt: true,
    });
  });

  it("normalizes key aliases", () => {
    expect(parseChord("Esc", "mac").key).toBe("escape");
    expect(parseChord("Up", "mac").key).toBe("arrowup");
    expect(parseChord("Shift+Enter", "mac")).toMatchObject({ key: "enter", shift: true });
  });

  it("treats a trailing literal + as the key", () => {
    expect(parseChord("CmdOrCtrl++", "mac")).toMatchObject({ key: "+", meta: true });
  });

  it("is case-insensitive on modifier + key tokens", () => {
    expect(parseChord("cmdorctrl+f", "mac")).toEqual(parseChord("CmdOrCtrl+F", "mac"));
  });
});

describe("eventToChord", () => {
  it("reads modifier flags and lowercases the key", () => {
    expect(
      eventToChord({ key: "B", metaKey: true, ctrlKey: false, shiftKey: false, altKey: false }),
    ).toMatchObject({ key: "b", meta: true });
  });

  it("normalizes the space key", () => {
    expect(
      eventToChord({ key: " ", metaKey: false, ctrlKey: false, shiftKey: false, altKey: false }).key,
    ).toBe("space");
  });
});

describe("chordEquals / chordKey", () => {
  const a = parseChord("CmdOrCtrl+B", "mac");
  it("equals a matching event chord", () => {
    const ev = eventToChord({ key: "b", metaKey: true, ctrlKey: false, shiftKey: false, altKey: false });
    expect(chordEquals(a, ev)).toBe(true);
    expect(chordKey(a)).toBe(chordKey(ev));
  });
  it("differs when a modifier differs", () => {
    const withShift = parseChord("CmdOrCtrl+Shift+B", "mac");
    expect(chordEquals(a, withShift)).toBe(false);
    expect(chordKey(a)).not.toBe(chordKey(withShift));
  });
});

describe("isInputSafe", () => {
  const mk = (over: Partial<Chord>): Chord => ({
    key: "a",
    meta: false,
    ctrl: false,
    shift: false,
    alt: false,
    ...over,
  });
  it("allows Cmd/Ctrl combos while typing", () => {
    expect(isInputSafe(mk({ meta: true }))).toBe(true);
    expect(isInputSafe(mk({ ctrl: true }))).toBe(true);
  });
  it("allows Escape and function keys", () => {
    expect(isInputSafe(mk({ key: "escape" }))).toBe(true);
    expect(isInputSafe(mk({ key: "f2" }))).toBe(true);
  });
  it("blocks a bare letter or arrow while typing", () => {
    expect(isInputSafe(mk({ key: "b" }))).toBe(false);
    expect(isInputSafe(mk({ key: "arrowdown" }))).toBe(false);
  });
});

describe("formatChord", () => {
  it("renders glyph-only in canonical order on mac", () => {
    expect(formatChordSpec("CmdOrCtrl+B", "mac")).toBe("⌘B");
    expect(formatChordSpec("Ctrl+Alt+Shift+Cmd+K", "mac")).toBe("⌃⌥⇧⌘K");
    expect(formatChordSpec("Escape", "mac")).toBe("Esc");
  });
  it("renders +-joined names on other platforms", () => {
    expect(formatChordSpec("CmdOrCtrl+B", "other")).toBe("Ctrl+B");
    expect(formatChordSpec("Shift+Enter", "other")).toBe("Shift+↵");
  });
});
