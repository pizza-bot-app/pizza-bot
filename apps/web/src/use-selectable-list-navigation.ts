import { useCallback, useId, useRef, type RefObject } from "react";
import { nextNavIndex, scrollListItemIntoView } from "./lib/list-nav.js";
import { useHotkey } from "./hotkeys/index.js";

export const SELECTABLE_LIST_ZONE = "selectable-list";

export interface SelectableListNavigationOptions {
  itemIds: readonly string[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  onActivate?: (id: string) => void;
  searchEnabled?: boolean;
  scrollElementRef?: RefObject<HTMLElement | null>;
}

export function useSelectableListNavigation({
  itemIds,
  selectedId,
  onSelect,
  onActivate,
  searchEnabled = true,
  scrollElementRef,
}: SelectableListNavigationOptions) {
  const listRef = useRef<HTMLElement | null>(null);
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const rowRefs = useRef(new Map<string, HTMLElement>());
  const idPrefix = useId().replace(/[^a-zA-Z0-9_-]/g, "");

  const rowId = useCallback(
    (itemId: string) => `${idPrefix}-option-${encodeURIComponent(itemId)}`,
    [idPrefix],
  );

  const setListElement = useCallback((element: HTMLElement | null) => {
    listRef.current = element;
  }, []);

  const setRowElement = useCallback(
    (itemId: string, element: HTMLElement | null) => {
      if (element) rowRefs.current.set(itemId, element);
      else rowRefs.current.delete(itemId);
    },
    [],
  );

  const scrollToItem = useCallback((itemId: string) => {
    scrollListItemIntoView(
      itemId,
      itemIds[0],
      scrollElementRef?.current ?? null,
      rowRefs.current.get(itemId),
    );
  }, [itemIds, scrollElementRef]);

  const selectItem = useCallback(
    (itemId: string) => {
      listRef.current?.focus({ preventScroll: true });
      onSelect(itemId);
      scrollToItem(itemId);
    },
    [onSelect, scrollToItem],
  );

  const moveSelection = useCallback(
    (direction: "up" | "down") => {
      if (itemIds.length === 0) return;
      const currentIndex = selectedId === null ? -1 : itemIds.indexOf(selectedId);
      const nextIndex = nextNavIndex(currentIndex, direction, itemIds.length);
      const nextId = itemIds[nextIndex];
      if (nextId) selectItem(nextId);
    },
    [itemIds, selectedId, selectItem],
  );

  const activateSelection = useCallback(() => {
    if (selectedId === null || !itemIds.includes(selectedId)) return;
    if (onActivate) onActivate(selectedId);
    else onSelect(selectedId);
  }, [itemIds, onActivate, onSelect, selectedId]);

  useHotkey("list.navDown", () => moveSelection("down"), { enabled: itemIds.length > 0 });
  useHotkey("list.navUp", () => moveSelection("up"), { enabled: itemIds.length > 0 });
  useHotkey("list.activate", activateSelection, {
    enabled: selectedId !== null && itemIds.includes(selectedId),
  });
  useHotkey("app.focusSearch", () => searchInputRef.current?.focus(), {
    enabled: searchEnabled,
  });

  const activeDescendant =
    selectedId !== null && itemIds.includes(selectedId) ? rowId(selectedId) : undefined;

  return {
    activeDescendant,
    rowId,
    searchInputRef,
    selectItem,
    setListElement,
    setRowElement,
    scrollToItem,
  };
}
