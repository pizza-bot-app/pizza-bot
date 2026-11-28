import { useState } from "react";
import { errorMessage } from "@/api-client";
import type {
  AgentDefinition,
  AgentDraft,
  ModelsInfo,
  SkillCatalogInfo,
  ToolCatalogInfo,
} from "@/api-client";
import type { InterruptOnPolicy } from "@pizza-bot/core";
import { ChevronLeft, RotateCcw, Sparkles, Trash2, X } from "lucide-react";
import { L } from "../../lexicon.js";
import { slugify } from "../../lib/utils.js";
import { useAppToast } from "../AppToast.js";
import { ModelCombobox } from "../ModelCombobox.js";
import { ToolGrantsField } from "../tools/ToolGrantsField.js";

export interface AgentEditorProps {
  agent: AgentDefinition | null;
  tools: ToolCatalogInfo;
  models: Pick<ModelsInfo, "models" | "providerLabels">;
  skills: SkillCatalogInfo;
  onSave: (definition: AgentDefinition) => Promise<void>;
  onGenerate: (prompt: string) => Promise<AgentDraft>;
  removalAction?: {
    label: string;
    mode: "delete" | "revert";
    run: () => Promise<void>;
  };
  /** Editing a shipped agent saves a user copy that hides it until reverted. */
  customizing?: boolean;
  onCancel: () => void;
}

export function AgentEditor({
  agent,
  tools,
  models,
  skills,
  onSave,
  onGenerate,
  removalAction,
  customizing = false,
  onCancel,
}: AgentEditorProps) {
  const notify = useAppToast();
  const isNew = agent === null;

  // Parent keys the editor by agent id; local drafts intentionally seed only on mount.
  const [name, setName] = useState(agent?.name ?? "");
  const [description, setDescription] = useState(agent?.description ?? "");
  const [systemPrompt, setSystemPrompt] = useState(agent?.systemPrompt ?? "");
  const [model, setModel] = useState(agent?.model ?? "");
  const [declaredTools, setDeclaredTools] = useState<string[]>(agent?.declaredTools ?? []);
  const [interruptOn, setInterruptOn] = useState<InterruptOnPolicy>(agent?.interruptOn ?? {});
  const [mountedSkills, setMountedSkills] = useState<string[]>(agent?.skills ?? []);

  const [genPrompt, setGenPrompt] = useState("");
  const [generating, setGenerating] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const canSave = name.trim() !== "" && description.trim() !== "" && !saving;
  const modelKnown = model === "" || models.models.some((option) => option.id === model);
  const skillName = (id: string) => skills.skills.find((skill) => skill.id === id)?.name ?? id;
  const addableSkills = skills.skills.filter((skill) => !mountedSkills.includes(skill.id));

  const handleGenerate = async () => {
    if (!genPrompt.trim() || generating) return;
    setGenerating(true);
    setError(null);
    try {
      const draft = await onGenerate(genPrompt.trim());
      setName(draft.name);
      setDescription(draft.description);
      setSystemPrompt(draft.body);
      setDeclaredTools(draft.declaredTools);
      setInterruptOn(draft.interruptOn);
    } catch (e) {
      setError(errorMessage(e) ?? "Generate failed");
    } finally {
      setGenerating(false);
    }
  };

  const handleSave = async () => {
    if (!canSave) return;
    setSaving(true);
    setError(null);
    const definition: AgentDefinition = {
      id: agent?.id ?? slugify(name, "agent"),
      name: name.trim(),
      description: description.trim(),
      systemPrompt,
      ...(model ? { model } : {}),
      declaredTools,
      skills: mountedSkills,
      interruptOn,
      source: "user",
    };
    try {
      await onSave(definition);
      notify({ title: isNew ? "Agent created" : "Agent saved", tone: "success" });
    } catch (e) {
      setError(errorMessage(e) ?? "Save failed");
      notify({
        title: "Could not save agent",
        description: errorMessage(e),
        tone: "error",
      });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="resource-editor">
      <button className="module-detail-back" onClick={onCancel}>
        <ChevronLeft size={18} /> {L.agentsSection}
      </button>
      <header className="resource-editor-head">
        <h2 className="resource-editor-title">
          {isNew ? `New ${L.agent}` : `${customizing ? "Customize" : "Edit"} ${agent?.name}`}
        </h2>
      </header>

      <div className="resource-editor-body">
        {customizing && (
          <p className="resource-editor-note">
            Saving creates your own copy of this agent. You can revert to the shipped version at any time.
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
              placeholder="Describe the specialist, e.g. “triages my open tickets and drafts a weekly status email”"
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
            placeholder="Agent name"
          />
          {isNew && name.trim() !== "" && (
            <span className="field-hint">
              Saved as <code>agents/{slugify(name, "agent")}.md</code>
            </span>
          )}
        </label>

        <label className="field">
          <span className="field-label">Description</span>
          <p className="field-hint">
            Pizza Bot reads only this before delegating. Say when to pick this agent, what it decides
            for itself, and what it returns.
          </p>
          <textarea
            className="field-input"
            rows={3}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Handles … Decides on its own … Returns …"
          />
        </label>

        <label className="field">
          <span className="field-label">Instructions</span>
          <p className="field-hint">The agent's system prompt. Markdown.</p>
          <textarea
            className="field-input resource-systemprompt"
            rows={12}
            value={systemPrompt}
            onChange={(e) => setSystemPrompt(e.target.value)}
            placeholder={"You are …\n\n1. First, …"}
          />
        </label>

        <div className="field">
          <span className="field-label">Model</span>
          <p className="field-hint">
            Pin a model for this agent, or let it run on the conversation's model.
          </p>
          <ModelCombobox
            models={models.models}
            providerLabels={models.providerLabels}
            value={model}
            emptyOption={{ label: "Inherit conversation model" }}
            unavailableOption={
              modelKnown ? undefined : { value: model, label: `${model} (currently unavailable)` }
            }
            disabled={saving}
            onChange={setModel}
          />
        </div>

        <ToolGrantsField
          tools={tools}
          declaredTools={declaredTools}
          setDeclaredTools={setDeclaredTools}
          interruptOn={interruptOn}
          setInterruptOn={setInterruptOn}
          hint="The agent's complete tool surface beyond the filesystem. Leave empty for an agent that only reads and writes files."
        />

        <div className="field">
          <span className="field-label">Skills</span>
          <p className="field-hint">
            Playbooks this agent reads on demand. A mounted skill belongs to this agent instead of Pizza Bot.
          </p>
          <div className="resource-tool-chips">
            {mountedSkills.length === 0 && <span className="field-hint">No skills mounted.</span>}
            {mountedSkills.map((id) => (
              <span key={id} className="resource-tool-chip">
                {skillName(id)}
                <button
                  type="button"
                  className="resource-tool-chip-x"
                  aria-label={`Remove skill ${id}`}
                  onClick={() => setMountedSkills((prev) => prev.filter((skill) => skill !== id))}
                >
                  <X size={12} />
                </button>
              </span>
            ))}
          </div>
          {addableSkills.length > 0 && (
            <select
              className="field-input agent-skill-select"
              aria-label="Add a skill"
              value=""
              onChange={(e) => {
                const id = e.target.value;
                if (id) setMountedSkills((prev) => (prev.includes(id) ? prev : [...prev, id]));
              }}
            >
              <option value="">Add a skill…</option>
              {addableSkills.map((skill) => (
                <option key={skill.id} value={skill.id}>
                  {skill.name}
                </option>
              ))}
            </select>
          )}
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
