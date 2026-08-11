# Hotkeys

A small, maintainable keyboard system that works in the browser (desktop +
mobile) and, unchanged, inside the Electron shell. It's a ground-up replacement
for the kind of hotkey stack that rots — one dispatcher, one source of truth for
scope, declarative registration.

## The model: Global · Zones · Layers

Every binding lives in exactly one **scope**, and a keydown resolves to a winner
by a fixed precedence (see `resolve.ts`):

1. **Layer** (top of stack) — a pushed modal/popover. Layers **trap**: while one
   is open only its bindings can match and unmatched keys are *swallowed*, so a
   modal's Escape never leaks and a global chord never fires "through" it.
2. **Zone** — a focus region (`chat`, `selectable-list`, …). A zone binding fires
   only when DOM focus is inside that zone. Zone identity is **declared** via a
   `data-hotkey-zone="<id>"` attribute and resolved with `.closest()` — never by
   sniffing class names.
3. **Global** — always active, but gated by the input-safety guard: a bare key
   (letter/arrow) never fires while you're typing; Cmd/Ctrl combos, Escape, and
   function keys still do.

This is why Escape "just works": in the chat, an open picker pushes
a layer whose Escape closes the menu; a second Escape (no layer now) hits the
chat *zone* binding and returns focus to the list.

## Why bubble phase (not capture)

The engine's single `window` keydown listener runs on the **bubble** path. So
component-local handlers and vendored Radix primitives, which handle their own
keys and call `stopPropagation`, naturally win — the engine never even sees those
events. It's the *cooperative fallback* for everything the focused widget didn't
claim. The reference system listened in capture phase and consequently had to
`disable the whole manager` whenever a widget needed a key; we never do.

## Layers

- **Pure core** (`keys.ts`/`catalog.ts`/`resolve.ts` here, framework-free,
  unit-tested like `lib/list-nav.ts`): `keys.ts` (parse/format/match chords, the ONE display
  formatter, input-safety), `catalog.ts` (actions as pure data — the single
  source of truth the help overlay + resolver read), `resolve.ts` (the
  precedence decision).
- **React engine** (this dir): `engine.ts` (the module-singleton dispatcher, like
  `protocol-stream-store.ts`), `HotkeyProvider`, and the hooks.

## Using it

```tsx
// A global action (chord + scope come from the catalog):
useHotkey("app.toggleRail", () => setShowRail(v => !v));

// A focus zone — wrap or stamp the container, then bind zone-scoped actions:
<div data-hotkey-zone="selectable-list">…</div>
useHotkey("list.navDown", () => moveSelection("down"));   // fires only in-zone

// A trapping layer for a modal/popover (auto-pops on unmount / when !active):
useLayer("delete-modal", { active: open, onEscape: onCancel });

// Wrap a VENDORED component without editing it:
<HotkeyZone id="feed"><Conversation/></HotkeyZone>
```

Add a new shortcut by adding a row to `catalog.ts` and a `useHotkey(id, …)` at
the handler site — the help overlay picks it up automatically (no hardcoded
counts, no second formatter).

## Cross-environment

- **Browser (desktop + mobile/touch):** the engine is the whole system. The
  visible ⌨︎ button in the status bar opens the cheat sheet without a keyboard.
- **Electron:** the renderer engine runs unchanged. Native menu accelerators and
  system-wide `globalShortcut` are not wired into this catalog. The preload
  bridge currently exposes connection, secret, log, and notification APIs, but
  no hotkey IPC channel; any future native shortcut should dispatch back into
  this engine so `catalog.ts` remains the single source of truth.
