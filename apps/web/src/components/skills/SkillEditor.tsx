import { useState } from "react";
import type { SkillBundle, SkillDraft, SkillSiblingFile } from "@/api-client";
import { ChevronLeft, Plus, RotateCcw, Sparkles, Trash2 } from "lucide-react";
import { L } from "../../lexicon.js";
import { slugify } from "../../lib/utils.js";
import { prepareSkillFiles } from "./skill-editor-files.js";
import { useAppToast } from "../AppToast.js";

export interface SkillEditorProps {
  skill: SkillBundle | null;
  onSave: (bundle: SkillBundle) => Promise<void>;
  onGenerate: (prompt: string) => Promise<SkillDraft>;
  removalAction?: {
    label: string;
    mode: "delete" | "revert";
    run: () => Promise<void>;
  };
  /** Editing a shipped skill saves a user copy that hides it until reverted. */
  customizing?: boolean;
  onCancel: () => void;
}

export function SkillEditor({ skill, onSave, onGenerate, removalAction, customizing = false, onCancel }: SkillEditorProps) {
  const notify = useAppToast();
  const isNew = skill === null;

  // Parent keys the editor by skill id; local drafts intentionally seed only on mount.
  const [name, setName] = useState(skill?.name ?? "");
  const [description, setDescription] = useState(skill?.description ?? "");
  const [body, setBody] = useState(skill?.body ?? "");
  const [files, setFiles] = useState<SkillSiblingFile[]>(skill?.files ?? []);

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
              placeholder="Describe the skill, e.g. “how to write a weekly status update from a list of tickets”"
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
            placeholder="What this skill covers and when to open it (agents read this to decide)."
          />
        </label>

        <label className="field">
          <span className="field-label">SKILL.md body</span>
          <p className="field-hint">
            The step-by-step playbook an agent reads when it opens the skill. Markdown.
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
