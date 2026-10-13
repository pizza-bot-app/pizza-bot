import { useEffect, useId, useMemo, useRef, useState, type FocusEvent, type KeyboardEvent } from "react";
import { ChevronDown, Cloud, Search, Star, X } from "lucide-react";
import type { ModelsInfo } from "@/api-client";
import { sectionModels, type ModelFavorites } from "../model-options.js";
import { findAction, useHotkey, useHotkeyContext, useLayer } from "../hotkeys/index.js";

type ModelOption = ModelsInfo["models"][number];
type Row = { value: string; disabled?: boolean };

export function ModelCombobox({
  models,
  value,
  onChange,
  emptyOption,
  unavailableOption,
  disabled = false,
  className = "",
  formatModelLabel = (model) => model.displayName,
  favorites,
}: {
  models: ModelOption[];
  value: string;
  onChange: (value: string) => void;
  emptyOption?: { label: string; value?: string };
  unavailableOption?: { value: string; label: string };
  disabled?: boolean;
  className?: string;
  formatModelLabel?: (model: ModelOption) => string;
  favorites?: ModelFavorites;
}) {
  const [open, setOpen] = useState(false);
  // Ordering is fixed for the life of the open menu so starring never moves rows under the pointer.
  const [orderedFavoriteIds, setOrderedFavoriteIds] = useState<readonly string[]>(favorites?.ids ?? []);
  const { formatSpec, platform } = useHotkeyContext();
  const [query, setQuery] = useState("");
  const [cursor, setCursor] = useState(0);
  const wrapRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const listId = useId();
  const normalized = query.trim().toLowerCase();
  const filteredModels = useMemo(
    () =>
      models.filter((model) =>
        !normalized ||
        `${model.displayName} ${model.id} ${model.provider}`.toLowerCase().includes(normalized),
      ),
    [models, normalized],
  );
  const sections = sectionModels(filteredModels, orderedFavoriteIds);
  const selected = models.find((model) => model.id === value);
  const triggerLabel = selected
    ? formatModelLabel(selected)
    : unavailableOption?.label ?? emptyOption?.label ?? (value || "Default model");
  const emptyValue = emptyOption?.value ?? "";

  // One cursor space spans the fixed rows and the filtered models, in render order.
  const leadingRows: Row[] = [];
  if (emptyOption) leadingRows.push({ value: emptyValue });
  if (unavailableOption) leadingRows.push({ value: unavailableOption.value, disabled: true });
  const modelOffset = leadingRows.length;
  const rows: Row[] = [
    ...leadingRows,
    ...sections.flatMap((section) => section.models.map(({ model }) => ({ value: model.id }))),
  ];
  const firstEnabled = Math.max(rows.findIndex((row) => !row.disabled), 0);
  const optionId = (index: number) => `${listId}-option-${index}`;

  const openMenu = () => {
    setOrderedFavoriteIds(favorites?.ids ?? []);
    setOpen(true);
  };

  const refocusOnEnable = useRef(false);
  const close = (restoreFocus: boolean) => {
    setOpen(false);
    if (!restoreFocus) return;
    refocusOnEnable.current = true;
    triggerRef.current?.focus();
  };

  // A parent that disables the picker while it saves a pick drops the trigger's focus to <body>.
  useEffect(() => {
    if (disabled) return;
    const dropped = document.activeElement === document.body || document.activeElement === null;
    if (refocusOnEnable.current && dropped) triggerRef.current?.focus();
    refocusOnEnable.current = false;
  }, [disabled, open]);

  // Popover layers consume Escape before the chat-zone binding returns focus.
  const layerId = useLayer("model-combobox", { active: open, onEscape: () => close(true) });

  const favoriteChord = findAction("modelPicker.toggleFavorite")?.defaultChord;
  const favoriteShortcut = favoriteChord ? formatSpec(favoriteChord) : "";
  useHotkey(
    "modelPicker.toggleFavorite",
    () => {
      const row = rows[cursor];
      if (cursor >= modelOffset && row) favorites?.toggle(row.value);
    },
    { enabled: open && !!favorites, layerId },
  );

  useEffect(() => {
    if (!open) return;
    const onMouseDown = (event: MouseEvent) => {
      if (!wrapRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onMouseDown);
    return () => document.removeEventListener("mousedown", onMouseDown);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    setQuery("");
    const index = rows.findIndex((row) => row.value === value && !row.disabled);
    setCursor(index < 0 ? firstEnabled : index);
    requestAnimationFrame(() => searchRef.current?.focus());
    // Seed only on open or an external value change; typing re-seeds below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, value, models]);

  useEffect(() => {
    if (!normalized) return;
    setCursor(filteredModels.length > 0 ? modelOffset : firstEnabled);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [normalized]);

  useEffect(() => {
    setCursor((current) => Math.min(current, Math.max(rows.length - 1, 0)));
  }, [rows.length]);

  const pick = (nextValue: string) => {
    onChange(nextValue);
    close(true);
  };

  const step = (from: number, delta: number) => {
    const count = rows.length;
    let next = from;
    for (let i = 0; i < count; i += 1) {
      next = (next + delta + count) % count;
      if (!rows[next]?.disabled) return next;
    }
    return from;
  };

  const onTriggerKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (open) return;
    if (["ArrowDown", "ArrowUp", "Enter", " "].includes(event.key)) {
      event.preventDefault();
      if (!disabled) openMenu();
    }
  };

  // Navigation lives on the search input so Enter on the clear button keeps its native click.
  const onSearchKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "ArrowDown" && rows.length > 0) {
      event.preventDefault();
      setCursor((current) => step(current, 1));
    } else if (event.key === "ArrowUp" && rows.length > 0) {
      event.preventDefault();
      setCursor((current) => step(current, -1));
    } else if (event.key === "Enter") {
      event.preventDefault();
      const row = rows[cursor];
      if (row && !row.disabled) pick(row.value);
    }
  };

  // A null relatedTarget is a click on inert menu chrome; the mousedown listener owns outside clicks.
  const onBlur = (event: FocusEvent<HTMLDivElement>) => {
    const next = event.relatedTarget as Node | null;
    if (open && next && !wrapRef.current?.contains(next)) setOpen(false);
  };

  const optionClass = (index: number, active: boolean, extra = "") =>
    `model-picker-item${extra}${active ? " active" : ""}${index === cursor ? " cursor" : ""}`;

  return (
    <div className={`model-picker ${className}`} ref={wrapRef} onBlur={onBlur}>
      <button
        ref={triggerRef}
        type="button"
        className="model-picker-trigger"
        aria-haspopup="listbox"
        aria-expanded={open}
        disabled={disabled || (models.length === 0 && !emptyOption && !unavailableOption)}
        onClick={() => (open ? setOpen(false) : openMenu())}
        onKeyDown={onTriggerKeyDown}
      >
        <Cloud size={15} aria-hidden="true" />
        <span className="model-picker-label"><span className="model-picker-model">{triggerLabel}</span></span>
        <ChevronDown size={14} className="model-picker-chevron" aria-hidden="true" />
      </button>
      {open && (
        <div className="model-picker-menu">
          <div className="model-picker-search">
            <Search size={14} aria-hidden="true" />
            <input
              ref={searchRef}
              value={query}
              placeholder="Search models..."
              aria-label="Search models"
              aria-controls={listId}
              aria-activedescendant={rows[cursor] ? optionId(cursor) : undefined}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={onSearchKeyDown}
              aria-keyshortcuts={favorites ? (platform === "mac" ? "Meta+F" : "Control+F") : undefined}
            />
            {query && (
              <button type="button" aria-label="Clear model search" onClick={() => setQuery("")}>
                <X size={13} />
              </button>
            )}
          </div>
          <ul className="model-picker-results" id={listId} role="listbox" aria-label="Models">
            {emptyOption && (
              <li>
                <button
                  type="button"
                  role="option"
                  id={optionId(0)}
                  tabIndex={-1}
                  aria-selected={value === emptyValue}
                  className={optionClass(0, value === emptyValue)}
                  onClick={() => pick(emptyValue)}
                >
                  {emptyOption.label}
                </button>
              </li>
            )}
            {unavailableOption && (
              <li>
                <button
                  type="button"
                  role="option"
                  id={optionId(modelOffset - 1)}
                  tabIndex={-1}
                  aria-selected={value === unavailableOption.value}
                  className={optionClass(modelOffset - 1, false, " unavailable")}
                  disabled
                >
                  {unavailableOption.label}
                </button>
              </li>
            )}
            {sections.map((section) => (
              <li className="model-picker-group" role="presentation" key={section.key}>
                <div className="model-picker-group-label">{section.label}</div>
                <ul className="model-picker-group-items" role="group" aria-label={section.label}>
                  {section.models.map(({ model, index }) => {
                    const favorite = favorites?.ids.includes(model.id) ?? false;
                    const starLabel = `${favorite ? "Remove" : "Add"} ${model.displayName} ${favorite ? "from" : "to"} favorites`;
                    return (
                      <li key={model.id} className="model-picker-row">
                        <button
                          type="button"
                          role="option"
                          id={optionId(modelOffset + index)}
                          tabIndex={-1}
                          aria-selected={model.id === value}
                          className={optionClass(modelOffset + index, model.id === value)}
                          onClick={() => pick(model.id)}
                        >
                          <Cloud size={14} aria-hidden="true" />
                          {formatModelLabel(model)}
                        </button>
                        {favorites && (
                          <button
                            type="button"
                            tabIndex={-1}
                            className={`model-picker-star${favorite ? " favorite" : ""}`}
                            aria-label={starLabel}
                            aria-pressed={favorite}
                            title={`${favorite ? "Remove from" : "Add to"} favorites (${favoriteShortcut})`}
                            // Keep focus in the search input so arrow keys and Enter keep working.
                            onMouseDown={(event) => event.preventDefault()}
                            onClick={() => favorites.toggle(model.id)}
                          >
                            <Star size={13} aria-hidden="true" fill={favorite ? "currentColor" : "none"} />
                          </button>
                        )}
                      </li>
                    );
                  })}
                </ul>
              </li>
            ))}
            {filteredModels.length === 0 && !emptyOption && !unavailableOption && (
              <li className="provider-model-empty">No models found.</li>
            )}
          </ul>
          {favorites && filteredModels.length > 0 && (
            <div className="model-picker-footer" aria-hidden="true">
              <kbd>{favoriteShortcut}</kbd>
              {cursor >= modelOffset && favorites.ids.includes(rows[cursor]?.value ?? "")
                ? "to remove from favorites"
                : "to add to favorites"}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
