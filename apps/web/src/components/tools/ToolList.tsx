import type { ReactNode } from "react";
import { Search } from "lucide-react";
import type { GrantedTool } from "./tool-catalog.js";

export function ToolFilterInput({
  value,
  onChange,
  placeholder = "Filter tools…",
  autoFocus,
  onEscape,
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  autoFocus?: boolean;
  onEscape?: () => void;
}) {
  return (
    <div className="sidebar-search-wrap tool-filter">
      <Search size={16} className="sidebar-search-icon" />
      <input
        className="sidebar-search"
        placeholder={placeholder}
        aria-label={placeholder}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Escape" && onEscape) {
            event.preventDefault();
            onEscape();
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
}: {
  name: string;
  description?: string;
  clampDescription?: boolean;
  onSelect?: () => void;
  selectLabel?: string;
}) {
  const body = (
    <>
      <code className="tool-row-name">{name}</code>
      {description && (
        <p className={`tool-row-desc${clampDescription ? " tool-row-desc-clamp" : ""}`}>{description}</p>
      )}
    </>
  );
  return (
    <li className="tool-row">
      {onSelect ? (
        <button type="button" className="tool-row-btn" onClick={onSelect} aria-label={selectLabel}>
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
