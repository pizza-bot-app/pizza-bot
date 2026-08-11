import { describe, it, expect } from "vitest";
import { parseChord } from "./keys.js";
import { resolveBinding, type Binding, type ResolveContext } from "./resolve.js";

const P = "mac" as const;

function bind(regId: string, spec: string, scope: Binding["scope"], layerId?: string): Binding {
  return { regId, chord: parseChord(spec, P), scope, ...(layerId ? { layerId } : {}) };
}

function ctx(over: Partial<ResolveContext> & Pick<ResolveContext, "chord">): ResolveContext {
  return {
    layerStack: [],
    activeZone: null,
    typing: false,
    bindings: [],
    ...over,
  };
}

describe("resolveBinding — precedence", () => {
  const globalB = bind("g", "CmdOrCtrl+B", "global");
  const listDown = bind("l", "ArrowDown", "zone:selectable-list");
  const chatEsc = bind("c", "Escape", "zone:chat");
  const modalEsc = bind("m", "Escape", "layer", "delete-modal");

  it("matches a global binding when nothing else claims the chord", () => {
    const r = resolveBinding(ctx({ chord: parseChord("CmdOrCtrl+B", P), bindings: [globalB] }));
    expect(r?.regId).toBe("g");
  });

  it("prefers the active zone over global for the same chord", () => {
    const zoneB = bind("z", "CmdOrCtrl+B", "zone:selectable-list");
    const r = resolveBinding(
      ctx({
        chord: parseChord("CmdOrCtrl+B", P),
        activeZone: "selectable-list",
        bindings: [globalB, zoneB],
      }),
    );
    expect(r?.regId).toBe("z");
  });

  it("only fires a zone binding when that zone has focus", () => {
    const inList = resolveBinding(
      ctx({ chord: parseChord("ArrowDown", P), activeZone: "selectable-list", bindings: [listDown] }),
    );
    expect(inList?.regId).toBe("l");
    const elsewhere = resolveBinding(
      ctx({ chord: parseChord("ArrowDown", P), activeZone: "composer", bindings: [listDown] }),
    );
    expect(elsewhere).toBeNull();
  });

  it("a pushed layer traps: only its bindings match, nothing beneath leaks", () => {
    const r = resolveBinding(
      ctx({
        chord: parseChord("Escape", P),
        layerStack: ["delete-modal"],
        activeZone: "chat",
        bindings: [chatEsc, modalEsc],
      }),
    );
    expect(r?.regId).toBe("m");
  });

  it("matches Escape anywhere in the active chat zone", () => {
    const r = resolveBinding(
      ctx({
        chord: parseChord("Escape", P),
        activeZone: "chat",
        bindings: [chatEsc],
      }),
    );
    expect(r?.regId).toBe("c");
  });

  it("an open layer swallows unmatched keys (returns null, not the global)", () => {
    const r = resolveBinding(
      ctx({
        chord: parseChord("CmdOrCtrl+B", P),
        layerStack: ["delete-modal"],
        bindings: [globalB, modalEsc],
      }),
    );
    expect(r).toBeNull();
  });

  it("the TOP-most layer wins when several are stacked", () => {
    const lower = bind("low", "Escape", "layer", "picker");
    const upper = bind("up", "Escape", "layer", "confirm");
    const r = resolveBinding(
      ctx({
        chord: parseChord("Escape", P),
        layerStack: ["picker", "confirm"],
        bindings: [lower, upper],
      }),
    );
    expect(r?.regId).toBe("up");
  });
});

describe("resolveBinding — typing guard", () => {
  const globalNew = bind("n", "CmdOrCtrl+N", "global");
  const globalSlash = bind("s", "/", "global");

  it("fires an input-safe global (Cmd+N) even while typing", () => {
    const r = resolveBinding(
      ctx({ chord: parseChord("CmdOrCtrl+N", P), typing: true, bindings: [globalNew] }),
    );
    expect(r?.regId).toBe("n");
  });

  it("blocks a bare-key global while typing", () => {
    const r = resolveBinding(ctx({ chord: parseChord("/", P), typing: true, bindings: [globalSlash] }));
    expect(r).toBeNull();
  });

  it("fires the bare-key global when NOT typing", () => {
    const r = resolveBinding(ctx({ chord: parseChord("/", P), typing: false, bindings: [globalSlash] }));
    expect(r?.regId).toBe("s");
  });
});
