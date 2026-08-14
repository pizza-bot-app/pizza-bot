import type { SkillCatalogInfo, SkillBundle, SkillDraft, ToolCatalogInfo } from "@/api-client";
import { useRef, useState, type ChangeEvent } from "react";
import { BookOpen, LoaderCircle, Upload } from "lucide-react";
import { ProvenanceBadge } from "../ProvenanceBadge.js";
import { SkillEditor } from "./SkillEditor.js";
import { ResourceModule } from "../ResourceModule.js";
import { ResourceList } from "../ResourceList.js";
import { ResourceEditorSkeleton } from "../ResourceDetailSkeleton.js";
import { useKeyedDoc } from "../../use-keyed-doc.js";
import { L } from "../../lexicon.js";
import { skillRemovalPresentation } from "./skill-actions.js";
import { useAppToast } from "../AppToast.js";
import {
  CapabilityEnablement,
  CapabilityStatusDot,
  type CapabilityVisualState,
} from "../CapabilityControls.js";

export interface SkillsModuleProps {
  skills: SkillCatalogInfo;
  tools: ToolCatalogInfo;
  onCreate: (bundle: SkillBundle) => Promise<SkillBundle>;
  onImport: (file: File) => Promise<SkillBundle>;
  onUpdate: (id: string, bundle: SkillBundle) => Promise<SkillBundle>;
  onSetEnabled: (id: string, enabled: boolean) => Promise<SkillEntry>;
  onDelete: (id: string) => Promise<boolean>;
  onGetBundle: (id: string) => Promise<SkillBundle | undefined>;
  onGenerate: (prompt: string) => Promise<SkillDraft>;
}

type SkillEntry = SkillCatalogInfo["skills"][number];

const matches = (s: SkillEntry, q: string) =>
  s.name.toLowerCase().includes(q) ||
  s.id.toLowerCase().includes(q) ||
  s.description.toLowerCase().includes(q);

function skillVisualState(skill: SkillEntry): CapabilityVisualState {
  if (!skill.enabled || skill.status === "disabled") return "disabled";
  if (skill.status === "loading") return "loading";
  if (skill.status === "unavailable") return "unavailable";
  return "active";
}

function skillStatusLabel(skill: SkillEntry): string {
  if (!skill.enabled || skill.status === "disabled") return "Disabled";
  if (skill.status === "loading") return skill.statusDetail ?? "Loading";
  if (skill.status === "unavailable") return skill.statusDetail ?? "Unavailable";
  return "Ready";
}

export function SkillsModule({
  skills,
  tools,
  onCreate,
  onImport,
  onUpdate,
  onSetEnabled,
  onDelete,
  onGetBundle,
  onGenerate,
}: SkillsModuleProps) {
  const catalog = skills.skills;
  return (
    <ResourceModule
      items={catalog}
      getId={(s) => s.id}
      icon={<BookOpen size={18} />}
      emptyIcon={<BookOpen size={40} strokeWidth={1} />}
      title={L.skillsSection}
      newLabel={`New ${L.skill}`}
      emptyText={`Select a ${L.skill.toLowerCase()} to see its details, or create a new one.`}
      renderHeaderActions={({ setSelection }) => (
        <SkillImportControl
          onImport={onImport}
          onImported={(id) => setSelection({ mode: "view", id })}
        />
      )}
      renderList={({ selectedId, onSelect }) => (
        <ResourceList
          items={catalog}
          getId={(s) => s.id}
          selectedId={selectedId}
          onSelect={onSelect}
          matches={matches}
          label={L.skills}
          searchPlaceholder={`Search ${L.skills.toLowerCase()}...`}
          emptyTitle={L.noSkills}
          emptySub="No skills are loaded."
          noMatchSub={(q) => `No ${L.skills.toLowerCase()} match “${q}”`}
          getRowClassName={(skill) => (!skill.enabled ? "disabled" : undefined)}
          renderRow={(s) => (
            <span className="resource-row-main">
              <span className="resource-row-line1">
                <span className="resource-row-name">{s.name}</span>
                <span className="resource-row-badges">
                  {s.status === "loading" || s.status === "unavailable" ? (
                    <span
                      className={`skill-status ${s.status}`}
                      title={s.statusDetail}
                    >
                      {s.status === "loading" ? "Loading" : "Unavailable"}
                    </span>
                  ) : null}
                  <ProvenanceBadge provenance={s.source} overrides={s.overrides} />
                  <CapabilityStatusDot
                    state={skillVisualState(s)}
                    label={skillStatusLabel(s)}
                  />
                </span>
              </span>
              <span className="resource-row-desc">{s.description}</span>
            </span>
          )}
        />
      )}
      renderDetail={({ selection, selected, setSelection, confirmAction }) => (
        <SkillDetail
          selection={selection}
          selected={selected}
          setSelection={setSelection}
          confirmAction={confirmAction}
          tools={tools}
          onCreate={onCreate}
          onUpdate={onUpdate}
          onSetEnabled={onSetEnabled}
          onDelete={onDelete}
          onGetBundle={onGetBundle}
          onGenerate={onGenerate}
        />
      )}
    />
  );
}

function SkillImportControl({
  onImport,
  onImported,
}: {
  onImport: (file: File) => Promise<SkillBundle>;
  onImported: (id: string) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [importing, setImporting] = useState(false);
  const notify = useAppToast();

  const handleFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file || importing) return;

    setImporting(true);
    try {
      const imported = await onImport(file);
      onImported(imported.id);
      notify({ title: "Skill imported", description: imported.name, tone: "success" });
    } catch (cause) {
      notify({
        title: "Skill import failed",
        description: cause instanceof Error ? cause.message : undefined,
        tone: "error",
      });
    } finally {
      setImporting(false);
    }
  };

  return (
    <div className="skill-import-control">
      <input
        ref={inputRef}
        hidden
        type="file"
        accept=".zip,application/zip"
        aria-label="Choose a skill ZIP file"
        onChange={(event) => void handleFile(event)}
      />
      <button
        type="button"
        className="btn-secondary"
        disabled={importing}
        aria-busy={importing}
        onClick={() => inputRef.current?.click()}
      >
        {importing ? <LoaderCircle className="spin" size={15} /> : <Upload size={15} />}
        <span className="skill-import-label">Import</span>
      </button>
    </div>
  );
}

function SkillDetail({
  selection,
  selected,
  setSelection,
  confirmAction,
  tools,
  onCreate,
  onUpdate,
  onSetEnabled,
  onDelete,
  onGetBundle,
  onGenerate,
}: {
  selection: import("../ResourceModule.js").ResourceSelection;
  selected: SkillEntry | null;
  setSelection: (next: import("../ResourceModule.js").ResourceSelection) => void;
  confirmAction: (
    message: string,
    action: () => Promise<unknown>,
    options: {
      title: string;
      confirmLabel: string;
      destructive?: boolean;
      preserveSelection?: boolean;
    },
  ) => Promise<void>;
} & Pick<SkillsModuleProps, "tools" | "onCreate" | "onUpdate" | "onSetEnabled" | "onDelete" | "onGetBundle" | "onGenerate">) {
  const bundle = useKeyedDoc(
    selection?.mode === "view" && selected ? selected.id : null,
    onGetBundle,
    selected ? `${selected.source}:${selected.overrides ?? ""}` : "",
  );

  const handleSave = async (b: SkillBundle) => {
    if (selection?.mode === "new") {
      const created = await onCreate(b);
      setSelection({ mode: "view", id: created.id });
    } else if (selection?.mode === "view") {
      await onUpdate(b.id, b);
    }
  };
  const missingDependencies =
    selected?.mcpDependencies.filter((dependency) => dependency.status === "missing") ?? [];
  const disabledDependencies =
    selected?.mcpDependencies.filter((dependency) => dependency.status === "disabled") ?? [];
  const dependencyActions = [
    ...(missingDependencies.length > 0
      ? [`Configure ${missingDependencies.map((dependency) => dependency.id).join(", ")} first.`]
      : []),
    ...(disabledDependencies.length > 0
      ? [`Enable ${disabledDependencies.map((dependency) => dependency.id).join(", ")} first.`]
      : []),
  ];
  const blockedReason =
    selected && !selected.enabled && dependencyActions.length > 0
      ? dependencyActions.join(" ")
      : undefined;
  const stateDescription =
    selected?.enabled && selected.status !== "ready"
      ? selected.statusDetail ?? "Enabled, but currently unavailable"
      : undefined;
  const enablement = selected ? (
    <CapabilityEnablement
      enabled={selected.enabled}
      noun="Skill"
      blockedReason={blockedReason}
      stateDescription={stateDescription}
      onChange={(enabled) => onSetEnabled(selected.id, enabled)}
    />
  ) : undefined;

  if (selection?.mode === "new") {
    return (
      <SkillEditor
        key="new"
        skill={null}
        tools={tools}
        onSave={handleSave}
        onGenerate={onGenerate}
        onCancel={() => setSelection(null)}
      />
    );
  }
  if (selected) {
    if (!bundle) {
      return (
        <ResourceEditorSkeleton
          sectionLabel={L.skillsSection}
          title={`Edit ${selected.name}`}
          onCancel={() => setSelection(null)}
        >
          {enablement}
        </ResourceEditorSkeleton>
      );
    }
    const removal =
      selected.source === "user" ? skillRemovalPresentation(selected) : undefined;
    return (
      <SkillEditor
        key={bundle.id}
        skill={bundle}
        tools={tools}
        onSave={handleSave}
        onGenerate={onGenerate}
        enablement={enablement}
        {...(removal
          ? {
              removalAction: {
                label: removal.label,
                mode: removal.mode,
                run: () =>
                  confirmAction(
                    removal.confirmation,
                    () => onDelete(bundle.id),
                    {
                      title: removal.title,
                      confirmLabel: removal.confirmLabel,
                      destructive: removal.mode === "delete",
                      preserveSelection: removal.mode === "revert",
                    },
                  ),
              },
            }
          : {})}
        onCancel={() => setSelection(null)}
      />
    );
  }
  return null;
}
