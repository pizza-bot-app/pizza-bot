import type { ReactNode } from "react";
import { ChevronLeft } from "lucide-react";

/** Placeholder for prose whose length is unknown until it loads. */
export function SkeletonLines({ count = 3 }: { count?: number }) {
  return (
    <span className="skeleton-lines">
      {Array.from({ length: count }, (_, index) => (
        <span
          key={index}
          className={`skeleton-block skeleton-line${index === count - 1 ? " short" : ""}`}
        />
      ))}
    </span>
  );
}

/**
 * Editor chrome for a resource whose form values are still loading. The title
 * and enablement come from the list row, so only the fields shimmer — and the
 * title matches the real editor's so nothing rewrites when the values land.
 */
export function ResourceEditorSkeleton({
  sectionLabel,
  title,
  onCancel,
  children,
}: {
  sectionLabel: string;
  title: string;
  onCancel: () => void;
  children?: ReactNode;
}) {
  return (
    <div className="resource-editor">
      <button className="module-detail-back" onClick={onCancel}>
        <ChevronLeft size={18} /> {sectionLabel}
      </button>
      <header className="resource-editor-head">
        <h2 className="resource-editor-title">{title}</h2>
      </header>
      <div className="resource-editor-body" aria-busy="true" aria-label={`Loading ${title}`}>
        {children}
        <SkeletonField />
        <SkeletonField height="medium" />
        <SkeletonField height="tall" />
      </div>
    </div>
  );
}

function SkeletonField({ height }: { height?: "medium" | "tall" }) {
  return (
    <div className="field">
      <span className="skeleton-block skeleton-field-label" />
      <span className={`skeleton-block skeleton-field-input${height ? ` ${height}` : ""}`} />
    </div>
  );
}
