import type { ReactNode, Ref } from "react";
import { Search } from "lucide-react";
import type { GrantedTool } from "./tool-catalog.js";

export function ToolFilterInput({
  value,
  onChange,
  label = "Filter tools",
  placeholder = "Filter tools…",
  autoFocus,
  onEscape,
  onEnter,
  inputRef,
}: {
  value: string;
  onChange: (value: string) => void;
  label?: string;
  placeholder?: string;
  autoFocus?: boolean;
  onEscape?: () => void;
  onEnter?: () => void;
  inputRef?: Ref<HTMLInputElement>;
}) {
  return (
    <div className="sidebar-search-wrap tool-filter">
      <Search size={16} className="sidebar-search-icon" />
      <input
        ref={inputRef}
        className="sidebar-search"
        placeholder={placeholder}
        aria-label={label}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Escape" && onEscape) {
            event.preventDefault();
            onEscape();
          } else if (event.key === "Enter" && onEnter) {
            event.preventDefault();
            onEnter();
          }
        }}
        autoFocus={autoFocus}
      />
    </div>
  );
}

export function ToolRow({
  name,
  description,
  clampDescription = false,
  onSelect,
  selectLabel,
  included,
}: {
  name: string;
  description?: string;
  clampDescription?: boolean;
  onSelect?: () => void;
  selectLabel?: string;
  /**
   * A granted wildcard that already covers this row. Adding the row only matters to
   * ask first for it alone, so it's blocked when the wildcard already asks first.
   */
  included?: { by: string; asksFirst: boolean };
}) {
  const note = included
    ? included.asksFirst
      ? `Included in ${included.by}, which asks first`
      : `Included in ${included.by}; add it to ask first for just this tool`
    : undefined;
  const body = (
    <>
      <code className="tool-row-name">{name}</code>
      {note && <span className="tool-row-included">{note}</span>}
      {description && (
        <p className={`tool-row-desc${clampDescription ? " tool-row-desc-clamp" : ""}`}>{description}</p>
      )}
    </>
  );
  return (
    <li className="tool-row" title={clampDescription ? description : undefined}>
      {onSelect ? (
        <button
          type="button"
          className="tool-row-btn"
          onClick={onSelect}
          aria-label={note ? `${selectLabel}. ${note}` : selectLabel}
          disabled={included?.asksFirst === true}
        >
          {body}
        </button>
      ) : (
        <div className="tool-row-body">{body}</div>
      )}
    </li>
  );
}

export function ToolSourceTag({ source }: { source: string }) {
  return <span className="tool-source">{source}</span>;
}

export function ToolChip({ tool, children }: { tool: GrantedTool; children?: ReactNode }) {
  const count = tool.matches?.length;
  return (
    <span className="resource-tool-chip" title={tool.matches?.join("\n") ?? tool.ref}>
      <code>{tool.name}</code>
      {tool.source && <ToolSourceTag source={tool.source} />}
      {count !== undefined && (
        <span className="tool-chip-count">
          {count} tool{count === 1 ? "" : "s"}
        </span>
      )}
      {children}
    </span>
  );
}
