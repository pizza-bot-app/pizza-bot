import type { ReactNode } from "react";
import { ChevronLeft, Pencil, Puzzle, SquarePen } from "lucide-react";

/**
 * Read-only detail screen shared by every resource. The header action slot holds
 * the single way to change the item; destructive actions live in its edit form.
 */
export function ResourceView({
  glyph,
  name,
  badge,
  status,
  provenance,
  headerAction,
  backLabel,
  onBack,
  children,
  footer,
}: {
  glyph: ReactNode;
  name: string;
  badge?: ReactNode;
  status?: ReactNode;
  provenance?: ReactNode;
  headerAction?: ReactNode;
  backLabel: string;
  onBack?: () => void;
  children?: ReactNode;
  footer?: ReactNode;
}) {
  return (
    <div className="resource-card">
      {onBack && (
        <button className="module-detail-back" onClick={onBack}>
          <ChevronLeft size={18} /> {backLabel}
        </button>
      )}
      <header className="resource-card-head">
        <div className="skill-card-glyph">{glyph}</div>
        <div className="resource-card-titles">
          <div className="resource-card-name-row">
            <h2 className="resource-card-name">{name}</h2>
            {badge}
          </div>
          {status && <div className="resource-card-desc">{status}</div>}
          {provenance && <div className="skill-card-provenance">{provenance}</div>}
        </div>
        {headerAction && <div className="resource-card-header-action">{headerAction}</div>}
      </header>
      {children}
      {footer && <footer className="resource-editor-actions">{footer}</footer>}
    </div>
  );
}

export function ResourceSection({
  title,
  icon,
  aside,
  children,
}: {
  title: string;
  icon?: ReactNode;
  aside?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="resource-card-section">
      <div className="resource-card-section-head">
        <h3 className="resource-card-section-title">
          {icon}
          {title}
        </h3>
        {aside}
      </div>
      {children}
    </section>
  );
}

export function EditAction({ onEdit, label = "Edit" }: { onEdit: () => void; label?: string }) {
  return (
    <button type="button" className="btn-secondary" onClick={onEdit}>
      {label === "Edit" ? <Pencil size={14} /> : <SquarePen size={14} />} {label}
    </button>
  );
}

/** Names the owning plugin as a link to it; used wherever a resource came from a plugin. */
export function PluginLink({
  pluginName,
  onOpenPlugin,
  prefix = "from plugin",
}: {
  pluginName: string;
  onOpenPlugin?: (pluginName: string) => void;
  prefix?: string;
}) {
  return (
    <button
      type="button"
      className="resource-card-link resource-plugin-link"
      onClick={() => onOpenPlugin?.(pluginName)}
      disabled={!onOpenPlugin}
      title={`Open the ${pluginName} plugin`}
    >
      <Puzzle size={13} /> {prefix} <code>{pluginName}</code> ↗
    </button>
  );
}
