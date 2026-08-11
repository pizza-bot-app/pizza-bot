import { HOTKEY_CATALOG, HOTKEY_CATEGORIES, type HotkeyActionDef } from "./catalog.js";
import { useHotkeyContext } from "./HotkeyProvider.js";
import { useLayer } from "./use-layer.js";

function groupedActions(): { category: string; label: string; actions: HotkeyActionDef[] }[] {
  return HOTKEY_CATEGORIES.map((cat) => ({
    category: cat.id,
    label: cat.label,
    actions: HOTKEY_CATALOG.filter((a) => a.category === cat.id && a.defaultChord),
  })).filter((g) => g.actions.length > 0);
}

export function HotkeyHelp({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { formatSpec } = useHotkeyContext();
  useLayer("hotkey-help", { active: open, onEscape: onClose });

  if (!open) return null;
  const groups = groupedActions();

  return (
    <div
      className="hotkey-help-backdrop"
      role="dialog"
      aria-modal="true"
      aria-label="Keyboard shortcuts"
      onClick={onClose}
    >
      <div className="hotkey-help" onClick={(e) => e.stopPropagation()}>
        <div className="hotkey-help-header">
          <h2 className="hotkey-help-title">Keyboard shortcuts</h2>
          <button className="hotkey-help-close" aria-label="Close" onClick={onClose}>
            ✕
          </button>
        </div>
        <div className="hotkey-help-body">
          {groups.map((g) => (
            <section className="hotkey-help-group" key={g.category}>
              <h3 className="hotkey-help-group-title">{g.label}</h3>
              <ul className="hotkey-help-list">
                {g.actions.map((a) => (
                  <li className="hotkey-help-row" key={a.id}>
                    <span className="hotkey-help-label">{a.label}</span>
                    <kbd className="hotkey-help-chord">{chordLabel(a, formatSpec)}</kbd>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      </div>
    </div>
  );
}

function chordLabel(a: HotkeyActionDef, formatSpec: (spec: string) => string): string {
  if (a.id === "app.selectThreadByIndex" && a.defaultChord) {
    return formatSpec(a.defaultChord).replace(/1$/, "1–9");
  }
  return a.defaultChord ? formatSpec(a.defaultChord) : "";
}
