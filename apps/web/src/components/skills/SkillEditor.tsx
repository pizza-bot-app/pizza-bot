import { useMemo, useState } from "react";
import type { SkillBundle, SkillSiblingFile, ToolCatalogInfo } from "@/api-client";
import type { SkillInterruptOn } from "@pizza-bot/core";
import { ChevronLeft, Plus, RotateCcw, Sparkles, Trash2, X } from "lucide-react";
import { L } from "../../lexicon.js";
import { slugify } from "../../lib/utils.js";
import { prepareSkillFiles } from "./skill-editor-files.js";
import { useAppToast } from "../AppToast.js";
import { describeGrantedTool, filterTools, patternSuggestions, toolGroups } from "../tools/tool-catalog.js";
import { ToolChip, ToolFilterInput, ToolRow, ToolSourceTag } from "../tools/ToolList.js";

export interface SkillEditorProps {
  skill: SkillBundle | null;
  tools: ToolCatalogInfo;
  onSave: (bundle: SkillBundle) => Promise<void>;
  onGenerate: (prompt: string) => Promise<{
    name: string;
    description: string;
    body: string;
    declaredTools: string[];
    interruptOn: SkillInterruptOn;
  }>;
  removalAction?: {
    label: string;
    mode: "delete" | "revert";
    run: () => Promise<void>;
  };
  /** Editing a shipped skill saves a user copy that hides it until reverted. */
  customizing?: boolean;
  onCancel: () => void;
}

export function SkillEditor({ skill, tools, onSave, onGenerate, removalAction, customizing = false, onCancel }: SkillEditorProps) {
  const notify = useAppToast();
  const isNew = skill === null;

  // Parent keys the editor by skill id; local drafts intentionally seed only on mount.
  const [name, setName] = useState(skill?.name ?? "");
  const [description, setDescription] = useState(skill?.description ?? "");
  const [body, setBody] = useState(skill?.body ?? "");
  const [files, setFiles] = useState<SkillSiblingFile[]>(skill?.files ?? []);
  const [declaredTools, setDeclaredTools] = useState<string[]>(skill?.declaredTools ?? []);
  const [interruptOn, setInterruptOn] = useState<SkillInterruptOn>(skill?.interruptOn ?? {});

  const [genPrompt, setGenPrompt] = useState("");
  const [generating, setGenerating] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const canSave = name.trim() !== "" && description.trim() !== "" && !saving;

  const handleGenerate = async () => {
    if (!genPrompt.trim() || generating) return;
    setGenerating(true);
    setError(null);
    try {
      const draft = await onGenerate(genPrompt.trim());
      setName(draft.name);
      setDescription(draft.description);
      setBody(draft.body);
      setDeclaredTools(draft.declaredTools);
      setInterruptOn(draft.interruptOn);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Generate failed");
    } finally {
      setGenerating(false);
    }
  };

  const handleSave = async () => {
    if (!canSave) return;
    setSaving(true);
    setError(null);
    const cleanFiles = prepareSkillFiles(files);

    const bundle: SkillBundle = {
      id: skill?.id ?? slugify(name, "skill"),
      name: name.trim(),
      description: description.trim(),
      body,
      files: cleanFiles,
      source: "user",
      declaredTools,
      interruptOn,
    };
    try {
      await onSave(bundle);
      notify({ title: isNew ? "Skill created" : "Skill saved", tone: "success" });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Save failed");
      notify({
        title: "Could not save skill",
        description: e instanceof Error ? e.message : undefined,
        tone: "error",
      });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="resource-editor">
      <button className="module-detail-back" onClick={onCancel}>
        <ChevronLeft size={18} /> {L.skillsSection}
      </button>
      <header className="resource-editor-head">
        <h2 className="resource-editor-title">{isNew ? `New ${L.skill}` : `${customizing ? "Customize" : "Edit"} ${skill?.name}`}</h2>
      </header>

      <div className="resource-editor-body">
        {customizing && (
          <p className="resource-editor-note">
            Saving creates your own copy of this skill. You can revert to the shipped version at any time.
          </p>
        )}
        {isNew && (
          <div className="resource-generate">
            <span className="field-label">
              <Sparkles size={14} /> Generate with AI
            </span>
            <textarea
              className="field-input"
              rows={2}
              value={genPrompt}
              onChange={(e) => setGenPrompt(e.target.value)}
              placeholder="Describe the skill, e.g. “draft and send a weekly status email summarizing my open tickets”"
              disabled={generating}
            />
            <button
              type="button"
              className="btn-secondary resource-generate-btn"
              onClick={() => void handleGenerate()}
              disabled={!genPrompt.trim() || generating}
            >
              <Sparkles size={14} /> {generating ? "Generating…" : "Generate"}
            </button>
            <span className="field-hint">Drafts every field below. You can edit them, or fill the form by hand.</span>
          </div>
        )}

        <label className="field">
          <span className="field-label">Name</span>
          <input
            className="field-input"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Skill name"
          />
          {isNew && name.trim() !== "" && (
            <span className="field-hint">
              Saved as <code>skills/{slugify(name, "skill")}/SKILL.md</code>
            </span>
          )}
        </label>

        <label className="field">
          <span className="field-label">Description</span>
          <textarea
            className="field-input"
            rows={2}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="What this skill does and when to use it (the model reads this to decide)."
          />
        </label>

        <label className="field">
          <span className="field-label">SKILL.md body</span>
          <p className="field-hint">
            The step-by-step instructions loaded when the skill is invoked. Markdown.
          </p>
          <textarea
            className="field-input resource-systemprompt"
            rows={12}
            value={body}
            onChange={(e) => setBody(e.target.value)}
            placeholder={"# My Skill\n\n1. First, …"}
          />
        </label>

        <div className="field">
          <span className="field-label">Tools</span>
          <p className="field-hint">
            Tools the skill is granted when the assistant runs it. Leave empty for a text-only playbook.
          </p>
          <div className="resource-tool-chips">
            {declaredTools.length === 0 && (
              <span className="field-hint">No tools declared.</span>
            )}
            {declaredTools.map((ref) => (
              <ToolChip key={ref} tool={describeGrantedTool(ref, tools)}>
                {ref.startsWith("mcp:") && (
                  <label className="skill-tool-approval" title="Pause for your approval before this tool runs">
                    <input
                      type="checkbox"
                      aria-label={`Ask first before running ${ref}`}
                      checked={interruptOn[ref] !== undefined && interruptOn[ref] !== false}
                      onChange={(event) =>
                        setInterruptOn((previous) => {
                          const next = { ...previous };
                          if (event.target.checked) {
                            next[ref] = { allowedDecisions: ["approve", "edit", "reject"] };
                          } else {
                            delete next[ref];
                          }
                          return next;
                        })
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
            ))}
          </div>
          <ToolPicker
            catalog={tools}
            declared={declaredTools}
            onAdd={(ref) => setDeclaredTools((prev) => (prev.includes(ref) ? prev : [...prev, ref]))}
          />
        </div>

        <div className="field">
          <span className="field-label">
            Bundled files <span className="field-optional">(optional)</span>
          </span>
          <p className="field-hint">
            Extra files (e.g. <code>reference.md</code>) the body can pull in on demand.
          </p>
          <ul className="skill-file-rows">
            {files.map((f, i) => (
              <li className="skill-file-row" key={i}>
                <input
                  className="field-input skill-file-name"
                  value={f.path}
                  onChange={(e) => updateFile(setFiles, i, { path: e.target.value })}
                  placeholder="reference.md"
                />
                <textarea
                  className="field-input"
                  rows={4}
                  value={f.content}
                  onChange={(e) => updateFile(setFiles, i, { content: e.target.value })}
                  placeholder="File contents…"
                />
                <button
                  type="button"
                  className="thread-action danger resource-prompt-del"
                  aria-label="Remove file"
                  onClick={() => setFiles((prev) => prev.filter((_, j) => j !== i))}
                >
                  <Trash2 size={14} />
                </button>
              </li>
            ))}
          </ul>
          <button
            type="button"
            className="btn-secondary resource-tool-add"
            onClick={() => setFiles((prev) => [...prev, { path: "", content: "" }])}
          >
            <Plus size={14} /> Add file
          </button>
        </div>

        {error && <div className="schedule-editor-error">{error}</div>}
      </div>

      <footer className="resource-editor-actions">
        {!isNew && removalAction && (
          <button
            type="button"
            className={`btn-secondary${removalAction.mode === "delete" ? " resource-editor-delete" : ""}`}
            onClick={() => void removalAction.run()}
            disabled={saving}
          >
            {removalAction.mode === "delete" ? <Trash2 size={14} /> : <RotateCcw size={14} />}
            {removalAction.label}
          </button>
        )}
        <span className="resource-editor-actions-spacer" />
        <button type="button" className="btn-secondary" onClick={onCancel} disabled={saving}>
          Cancel
        </button>
        <button type="button" className="btn-primary" onClick={() => void handleSave()} disabled={!canSave}>
          {saving ? "Saving…" : isNew ? "Create" : "Save"}
        </button>
      </footer>
    </div>
  );
}

function updateFile(
  setFiles: React.Dispatch<React.SetStateAction<SkillSiblingFile[]>>,
  index: number,
  patch: Partial<SkillSiblingFile>,
) {
  setFiles((prev) => prev.map((row, i) => (i === index ? { ...row, ...patch } : row)));
}

function ToolPicker({
  catalog,
  declared,
  onAdd,
}: {
  catalog: ToolCatalogInfo;
  declared: string[];
  onAdd: (ref: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const groups = useMemo(() => toolGroups(catalog), [catalog]);

  const close = () => {
    setOpen(false);
    setQuery("");
  };
  const add = (ref: string) => {
    onAdd(ref);
    setQuery("");
  };

  if (!open) {
    return (
      <button type="button" className="btn-secondary resource-tool-add" onClick={() => setOpen(true)}>
        <Plus size={14} /> Add a tool…
      </button>
    );
  }

  const taken = new Set(declared);
  const isPattern = query.includes("*");
  const { suggestions, error } = patternSuggestions(query, catalog);
  const patterns = suggestions.filter((s) => !taken.has(s.ref));
  const q = query.trim().toLowerCase();
  const visibleGroups = isPattern
    ? []
    : groups
        .map((group) => {
          const untaken = group.tools.filter((t) => !taken.has(t.ref));
          return { ...group, tools: group.source.toLowerCase().includes(q) ? untaken : filterTools(untaken, q) };
        })
        .filter((group) => group.tools.length > 0);
  const empty = patterns.length === 0 && visibleGroups.length === 0;

  return (
    <div className="resource-tool-picker">
      <ToolFilterInput
        value={query}
        onChange={setQuery}
        placeholder="Search tools, or end with * to add a pattern like list_*"
        autoFocus
        onEscape={close}
      />
      <div className="tool-picker-list">
        {error && <p className="resource-card-empty">{error}</p>}
        {!error && empty && (
          <p className="resource-card-empty">
            {isPattern ? "No connected tools match that pattern." : "No matching tools."}
          </p>
        )}
        {patterns.length > 0 && (
          <section className="tool-group">
            <header className="tool-group-head">
              <span className="tool-group-title">Patterns</span>
            </header>
            <ul className="tool-rows">
              {patterns.map((p) => (
                <ToolRow
                  key={p.ref}
                  name={p.ref}
                  description={`Grants ${p.matches.length} tool${p.matches.length === 1 ? "" : "s"}: ${p.matches.join(", ")}`}
                  clampDescription
                  onSelect={() => add(p.ref)}
                  selectLabel={`Add ${p.ref}`}
                />
              ))}
            </ul>
          </section>
        )}
        {visibleGroups.map((group) => (
          <section className="tool-group" key={group.source}>
            <header className="tool-group-head">
              <ToolSourceTag source={group.source} />
              <span className="tool-group-count">
                {group.tools.length} tool{group.tools.length === 1 ? "" : "s"}
              </span>
              {group.wildcard && !taken.has(group.wildcard) && (
                <button
                  type="button"
                  className="resource-card-link tool-group-all"
                  onClick={() => add(group.wildcard!)}
                >
                  Add all
                </button>
              )}
            </header>
            <ul className="tool-rows">
              {group.tools.map((tool) => (
                <ToolRow
                  key={tool.ref}
                  name={tool.name}
                  description={tool.description}
                  clampDescription
                  onSelect={() => add(tool.ref)}
                  selectLabel={`Add ${tool.ref}`}
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
