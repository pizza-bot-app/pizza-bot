import { useEffect, useState } from "react";
import type { MemoryInfo, MemoryDoc } from "@/api-client";
import { Brain, ChevronLeft, Trash2 } from "lucide-react";
import { ResourceModule } from "../ResourceModule.js";
import { ResourceList } from "../ResourceList.js";
import { L } from "../../lexicon.js";
import { slugify } from "../../lib/utils.js";
import { useAppToast } from "../AppToast.js";

export interface MemoriesModuleProps {
  memories: MemoryInfo[];
  onCreate: (id: string, content: string) => Promise<MemoryDoc>;
  onUpdate: (id: string, content: string) => Promise<MemoryDoc>;
  onDelete: (id: string) => Promise<boolean>;
  onGetContent: (id: string) => Promise<MemoryDoc | undefined>;
}

const matches = (m: MemoryInfo, q: string) =>
  m.id.toLowerCase().includes(q) || m.preview.toLowerCase().includes(q);

export function MemoriesModule({ memories, onCreate, onUpdate, onDelete, onGetContent }: MemoriesModuleProps) {
  return (
    <ResourceModule
      items={memories}
      getId={(m) => m.id}
      icon={<Brain size={18} />}
      emptyIcon={<Brain size={40} strokeWidth={1} />}
      title={L.memoriesSection}
      newLabel={`New ${L.memory}`}
      emptyText={`Select a ${L.memory.toLowerCase()} to view or edit it, or create a new one.`}
      renderList={({ selectedId, onSelect }) => (
        <ResourceList
          items={memories}
          getId={(m) => m.id}
          selectedId={selectedId}
          onSelect={onSelect}
          matches={matches}
          label={L.memories}
          searchPlaceholder={`Search ${L.memories.toLowerCase()}...`}
          emptyTitle={L.noMemories}
          emptySub="Memories the assistant saves will appear here."
          noMatchSub={(q) => `No ${L.memories.toLowerCase()} match “${q}”`}
          renderRow={(m) => (
            <span className="resource-row-main">
              <span className="resource-row-line1">
                <span className="resource-row-name">{m.id}</span>
              </span>
              <span className="resource-row-desc">{m.preview || "(empty)"}</span>
            </span>
          )}
        />
      )}
      renderDetail={({ selection, setSelection, confirmAction }) => {
        const handleCreate = async (id: string, content: string) => {
          const created = await onCreate(id, content);
          setSelection({ mode: "view", id: created.id });
        };
        if (selection?.mode === "new") {
          return (
            <MemoryEditor
              key="new"
              id={null}
              existingIds={memories.map((m) => m.id)}
              onCreate={handleCreate}
              onUpdate={onUpdate}
              onCancel={() => setSelection(null)}
              onGetContent={onGetContent}
            />
          );
        }
        if (selection?.mode === "view") {
          const id = selection.id;
          return (
            <MemoryEditor
              key={id}
              id={id}
              existingIds={memories.map((m) => m.id)}
              onCreate={handleCreate}
              onUpdate={onUpdate}
              onDelete={() =>
                void confirmAction(
                  `Delete this ${L.memory.toLowerCase()}? This can’t be undone.`,
                  () => onDelete(id),
                  {
                    title: `Delete ${L.memory.toLowerCase()}?`,
                    confirmLabel: "Delete",
                    destructive: true,
                  },
                )
              }
              onCancel={() => setSelection(null)}
              onGetContent={onGetContent}
            />
          );
        }
        return null;
      }}
    />
  );
}

function MemoryEditor({
  id,
  existingIds,
  onCreate,
  onUpdate,
  onDelete,
  onCancel,
  onGetContent,
}: {
  id: string | null;
  existingIds: string[];
  onCreate: (id: string, content: string) => Promise<void>;
  onUpdate: (id: string, content: string) => Promise<MemoryDoc>;
  onDelete?: () => void;
  onCancel: () => void;
  onGetContent: (id: string) => Promise<MemoryDoc | undefined>;
}) {
  const notify = useAppToast();
  const isNew = id === null;
  const [name, setName] = useState(id ?? "");
  const [content, setContent] = useState("");
  const [loading, setLoading] = useState(!isNew);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Ignore content that resolves after this keyed editor switches or unmounts.
  useEffect(() => {
    if (isNew) return;
    let alive = true;
    setLoading(true);
    void onGetContent(id).then((doc) => {
      if (!alive) return;
      setContent(doc?.content ?? "");
      setLoading(false);
    });
    return () => {
      alive = false;
    };
  }, [id, isNew, onGetContent]);

  const slug = slugify(name, "memory");
  const idCollision = isNew && slug !== "" && existingIds.includes(slug);
  const canSave = name.trim() !== "" && !idCollision && !saving && !loading;

  const handleSave = async () => {
    if (!canSave) return;
    setSaving(true);
    setError(null);
    try {
      if (isNew) await onCreate(slug, content);
      else await onUpdate(id, content);
      notify({ title: isNew ? "Memory created" : "Memory saved", tone: "success" });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Save failed");
      notify({
        title: "Could not save memory",
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
        <ChevronLeft size={18} /> {L.memoriesSection}
      </button>
      <header className="resource-editor-head">
        <h2 className="resource-editor-title">{isNew ? `New ${L.memory}` : id}</h2>
      </header>

      <div className="resource-editor-body">
        <label className="field">
          <span className="field-label">Name</span>
          <input
            className="field-input"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. user-preferences"
            disabled={!isNew}
          />
          {isNew && name.trim() !== "" && (
            <span className="field-hint">
              Saved as <code>memories/{slug}.md</code>
            </span>
          )}
          {idCollision && <span className="field-hint error">A memory named “{slug}” already exists.</span>}
        </label>

        <label className="field">
          <span className="field-label">Content</span>
          <p className="field-hint">Markdown. The assistant reads this across every conversation.</p>
          <textarea
            className="field-input resource-systemprompt"
            rows={18}
            value={content}
            onChange={(e) => setContent(e.target.value)}
            placeholder={loading ? "Loading…" : "# Notes\n\n- …"}
            disabled={loading}
          />
        </label>

        {error && <div className="schedule-editor-error">{error}</div>}
      </div>

      <footer className="resource-editor-actions">
        {!isNew && onDelete && (
          <button type="button" className="btn-secondary resource-editor-delete" onClick={onDelete} disabled={saving}>
            <Trash2 size={14} /> Delete
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
