import { useEffect, useId, useMemo, useRef, useState, type FocusEvent, type KeyboardEvent } from "react";
import { ChevronDown, Cloud, Search, X } from "lucide-react";
import type { ModelsInfo } from "@/api-client";
import { groupModelsByProvider, providerLabel } from "../model-options.js";
import { useLayer } from "../hotkeys/index.js";

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
}: {
  models: ModelOption[];
  value: string;
  onChange: (value: string) => void;
  emptyOption?: { label: string; value?: string };
  unavailableOption?: { value: string; label: string };
  disabled?: boolean;
  className?: string;
  formatModelLabel?: (model: ModelOption) => string;
}) {
  const [open, setOpen] = useState(false);
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
  const groups = groupModelsByProvider(filteredModels);
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
  const rows: Row[] = [...leadingRows, ...filteredModels.map((model) => ({ value: model.id }))];
  const firstEnabled = Math.max(rows.findIndex((row) => !row.disabled), 0);
  const optionId = (index: number) => `${listId}-option-${index}`;

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
  useLayer("model-combobox", { active: open, onEscape: () => close(true) });

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
      if (!disabled) setOpen(true);
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
        onClick={() => setOpen((current) => !current)}
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
            {groups.map((group) => (
              <li className="model-picker-group" role="presentation" key={group.provider}>
                <div className="model-picker-group-label">{providerLabel(group.provider)}</div>
                <ul className="model-picker-group-items" role="group" aria-label={providerLabel(group.provider)}>
                  {group.models.map(({ model, index }) => (
                    <li key={model.id}>
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
                    </li>
                  ))}
                </ul>
              </li>
            ))}
            {filteredModels.length === 0 && !emptyOption && !unavailableOption && (
              <li className="provider-model-empty">No models found.</li>
            )}
          </ul>
        </div>
      )}
    </div>
  );
}
