export interface ModuleTab<K extends string> {
  key: K;
  label: string;
}

export interface ModuleTabsProps<K extends string> {
  tabs: readonly ModuleTab<K>[];
  active: K;
  onSelect: (key: K) => void;
  ariaLabel: string;
}

export function ModuleTabs<K extends string>({ tabs, active, onSelect, ariaLabel }: ModuleTabsProps<K>) {
  return (
    <nav className="module-tabs" role="tablist" aria-label={ariaLabel}>
      {tabs.map((tab) => (
        <button
          key={tab.key}
          role="tab"
          className={`module-tab${tab.key === active ? " active" : ""}`}
          aria-selected={tab.key === active}
          onClick={() => onSelect(tab.key)}
        >
          {tab.label}
        </button>
      ))}
    </nav>
  );
}
