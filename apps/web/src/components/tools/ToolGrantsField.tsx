import { useMemo, useRef, useState, type Dispatch, type SetStateAction } from "react";
import type { ToolCatalogInfo } from "@/api-client";
import type { InterruptOnPolicy } from "@pizza-bot/core";
import { Plus, X } from "lucide-react";
import { coveringWildcard, describeGrantedTool, toggleAskFirst, filterTools, patternSuggestions, toolGroups } from "./tool-catalog.js";
import { ToolChip, ToolFilterInput, ToolRow } from "./ToolList.js";

/** Granted tool chips with per-tool "Ask first", plus the grouped picker that adds grants. */
export function ToolGrantsField({
  tools,
  declaredTools,
  setDeclaredTools,
  interruptOn,
  setInterruptOn,
  hint,
}: {
  tools: ToolCatalogInfo;
  declaredTools: string[];
  setDeclaredTools: Dispatch<SetStateAction<string[]>>;
  interruptOn: InterruptOnPolicy;
  setInterruptOn: Dispatch<SetStateAction<InterruptOnPolicy>>;
  hint: string;
}) {
  const asksFirst = (ref: string) => interruptOn[ref] !== undefined && interruptOn[ref] !== false;
  const uncheckedPolicies = useRef(new Map<string, InterruptOnPolicy[string]>());
  return (
    <div className="field">
      <span className="field-label">Tools</span>
      <p className="field-hint">
        {hint}
      </p>
      <div className="resource-tool-chips">
        {declaredTools.length === 0 && (
          <span className="field-hint">No tools declared.</span>
        )}
        {declaredTools.map((ref) => {
          const coveredBy = coveringWildcard(ref, declaredTools.filter(asksFirst));
          return (
            <ToolChip key={ref} tool={describeGrantedTool(ref, tools)}>
              {ref.startsWith("mcp:") && (
                <label
                  className="skill-tool-approval"
                  title={
                    coveredBy
                      ? `Asks first via ${coveredBy}`
                      : "Pause for your approval before this tool runs"
                  }
                >
                  <input
                    type="checkbox"
                    aria-label={
                      coveredBy
                        ? `Ask first before running ${ref}, on because ${coveredBy} asks first`
                        : `Ask first before running ${ref}`
                    }
                    checked={coveredBy !== undefined || asksFirst(ref)}
                    disabled={coveredBy !== undefined}
                    onChange={(event) =>
                      setInterruptOn((previous) =>
                        toggleAskFirst(previous, ref, event.target.checked, uncheckedPolicies.current))
                    }
                  />
                  Ask first
                </label>
              )}
              <button
                type="button"
                className="resource-tool-chip-x"
                aria-label={`Remove ${ref}`}
                onClick={() => {
                  setDeclaredTools((prev) => prev.filter((r) => r !== ref));
                  setInterruptOn((previous) => {
                    const next = { ...previous };
                    delete next[ref];
                    return next;
                  });
                }}
              >
                <X size={12} />
              </button>
            </ToolChip>
          );
        })}
      </div>
      <ToolPicker
        catalog={tools}
        declared={declaredTools}
        asksFirst={asksFirst}
        onAdd={(ref) => setDeclaredTools((prev) => (prev.includes(ref) ? prev : [...prev, ref]))}
      />
    </div>
  );
}

function ToolPicker({
  catalog,
  declared,
  asksFirst,
  onAdd,
}: {
  catalog: ToolCatalogInfo;
  declared: string[];
  asksFirst: (ref: string) => boolean;
  onAdd: (ref: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const groups = useMemo(() => toolGroups(catalog), [catalog]);

  const close = () => {
    setOpen(false);
    setQuery("");
  };
  // The clicked row leaves the list, so focus goes back to the search box instead of <body>.
  const add = (ref: string) => {
    onAdd(ref);
    inputRef.current?.focus();
  };

  if (!open) {
    return (
      <button type="button" className="btn-secondary resource-tool-add" onClick={() => setOpen(true)}>
        <Plus size={14} /> Add a tool…
      </button>
    );
  }

  const taken = new Set(declared);
  // An asking wildcard wins over a non-asking one, since only it blocks the row.
  const includedBy = (ref: string) => {
    const by = coveringWildcard(ref, declared.filter(asksFirst)) ?? coveringWildcard(ref, declared);
    return by ? { by, asksFirst: asksFirst(by) } : undefined;
  };
  const { suggestions, error } = patternSuggestions(query, catalog);
  const patterns = suggestions
    .filter((p) => !taken.has(p.ref))
    .map((p) => ({ ...p, included: includedBy(p.ref) }));
  const q = query.replace(/\*/g, "").trim().toLowerCase();
  const visibleGroups = groups
    .map((group) => {
      const untaken = group.tools.filter((t) => !taken.has(t.ref));
      const shown = group.source.toLowerCase().includes(q) ? untaken : filterTools(untaken, q);
      return {
        ...group,
        total: group.tools.length,
        tools: shown.map((t) => ({ ...t, included: includedBy(t.ref) })),
      };
    })
    .filter((group) => group.tools.length > 0);
  const firstAddable =
    patterns.find((p) => !p.included?.asksFirst)?.ref ??
    visibleGroups.flatMap((g) => g.tools).find((t) => !t.included?.asksFirst)?.ref;
  const empty = patterns.length === 0 && visibleGroups.length === 0;

  return (
    <div className="resource-tool-picker">
      <ToolFilterInput
        value={query}
        onChange={setQuery}
        label="Search tools"
        placeholder="Search tools, or end with * to add a pattern like list_*"
        autoFocus
        onEscape={close}
        onEnter={() => firstAddable && add(firstAddable)}
        inputRef={inputRef}
      />
      <p className="resource-card-empty tool-picker-status" role="status">
        {error ?? (empty ? (query.includes("*") ? "No connected tools match that pattern." : "No matching tools.") : "")}
      </p>
      <div className="tool-picker-list">
        {patterns.length > 0 && (
          <section className="tool-group">
            <h4 className="tool-group-head">
              <span className="tool-group-title">Patterns</span>
            </h4>
            <ul className="tool-rows">
              {patterns.map((p) => (
                <ToolRow
                  key={p.ref}
                  name={p.ref}
                  description={`Grants ${p.matches.length} tool${p.matches.length === 1 ? "" : "s"}: ${p.matches.join(", ")}`}
                  clampDescription
                  onSelect={() => add(p.ref)}
                  selectLabel={`Add ${p.ref}`}
                  included={p.included}
                />
              ))}
            </ul>
          </section>
        )}
        {visibleGroups.map((group) => (
          <section className="tool-group" key={group.source}>
            <h4 className="tool-group-head">
              <span className="tool-group-title tool-group-title-server">{group.source}</span>
              <span className="tool-group-count">
                {group.tools.length === group.total
                  ? `${group.total} tool${group.total === 1 ? "" : "s"}`
                  : `${group.tools.length} of ${group.total} tools`}
              </span>
            </h4>
            <ul className="tool-rows">
              {group.tools.map((tool) => (
                <ToolRow
                  key={tool.ref}
                  name={tool.name}
                  description={tool.description}
                  clampDescription
                  onSelect={() => add(tool.ref)}
                  selectLabel={`Add ${tool.ref}`}
                  included={tool.included}
                />
              ))}
            </ul>
          </section>
        ))}
      </div>
      <button type="button" className="btn-secondary" onClick={close}>
        Done
      </button>
    </div>
  );
}
