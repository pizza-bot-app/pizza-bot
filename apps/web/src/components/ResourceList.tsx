import { useMemo, useState, type ReactNode } from "react";
import { Search, X } from "lucide-react";
import {
  SELECTABLE_LIST_ZONE,
  useSelectableListNavigation,
} from "../use-selectable-list-navigation.js";

export interface ResourceListProps<T> {
  items: T[];
  getId: (item: T) => string;
  selectedId: string | null;
  onSelect: (id: string) => void;
  renderRow: (item: T, selected: boolean) => ReactNode;
  matches: (item: T, query: string) => boolean;
  label: string;
  searchPlaceholder: string;
  emptyTitle: string;
  emptySub: ReactNode;
  noMatchSub: (query: string) => ReactNode;
  getRowClassName?: (item: T) => string | undefined;
}

export function ResourceList<T>({
  items,
  getId,
  selectedId,
  onSelect,
  renderRow,
  matches,
  label,
  searchPlaceholder,
  emptyTitle,
  emptySub,
  noMatchSub,
  getRowClassName,
}: ResourceListProps<T>) {
  const [query, setQuery] = useState("");

  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return items;
    return items.filter((item) => matches(item, q));
  }, [items, query, matches]);

  const listNavigation = useSelectableListNavigation({
    itemIds: rows.map(getId),
    selectedId,
    onSelect,
  });

  return (
    <div className="resource-list">
      <div className="resource-list-header">
        <div className="sidebar-search-wrap">
          <Search size={16} className="sidebar-search-icon" />
          <input
            ref={listNavigation.searchInputRef}
            className="sidebar-search"
            placeholder={searchPlaceholder}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          {query && (
            <button className="sidebar-search-clear" aria-label="Clear search" onClick={() => setQuery("")}>
              <X size={15} />
            </button>
          )}
        </div>
      </div>

      <div className="resource-list-scroll">
        {rows.length === 0 ? (
          <div className="sidebar-empty">
            <div className="sidebar-empty-title">{query ? "No matches" : emptyTitle}</div>
            <div className="sidebar-empty-sub">{query ? noMatchSub(query) : emptySub}</div>
          </div>
        ) : (
          <ul
            className="resource-rows"
            role="listbox"
            aria-label={label}
            aria-activedescendant={listNavigation.activeDescendant}
            data-hotkey-zone={SELECTABLE_LIST_ZONE}
            tabIndex={0}
            ref={listNavigation.setListElement}
          >
            {rows.map((item) => {
              const id = getId(item);
              const selected = id === selectedId;
              return (
                <li
                  key={id}
                  id={listNavigation.rowId(id)}
                  ref={(element) => listNavigation.setRowElement(id, element)}
                  role="option"
                  aria-selected={selected}
                  onClick={() => listNavigation.selectItem(id)}
                >
                  <div
                    className={`resource-row${selected ? " active" : ""}${
                      getRowClassName?.(item) ? ` ${getRowClassName(item)}` : ""
                    }`}
                  >
                    {renderRow(item, selected)}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}
