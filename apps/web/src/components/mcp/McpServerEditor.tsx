import { useState, type ReactNode } from "react";
import type { McpServerDoc, McpServerEntryWire } from "@/api-client";
import { ChevronLeft, Eye, EyeOff, Plus, Trash2 } from "lucide-react";
import { L } from "../../lexicon.js";
import { slugify } from "../../lib/utils.js";
import { useAppToast } from "../AppToast.js";

export interface McpServerEditorProps {
  server: McpServerDoc | null;
  onSave: (id: string, entry: McpServerEntryWire) => Promise<void>;
  enablement?: ReactNode;
  reconnectControl?: ReactNode;
  dependents?: ReactNode;
  /** Receives whether the draft differs from what was loaded, so the caller can guard discards. */
  onCancel: (dirty: boolean) => void;
}

interface KV {
  key: string;
  value: string;
}

type Transport = "stdio" | "url";

function toRows(rec: Record<string, string> | undefined): KV[] {
  return Object.entries(rec ?? {}).map(([key, value]) => ({ key, value }));
}

function fromRows(rows: KV[]): Record<string, string> | undefined {
  const out: Record<string, string> = {};
  for (const r of rows) {
    const k = r.key.trim();
    if (k) out[k] = r.value;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

interface Draft {
  transport: Transport;
  command: string;
  args: string[];
  env: KV[];
  cwd: string;
  urlType: "http" | "sse";
  url: string;
  headers: KV[];
}

function seedDraft(entry: McpServerEntryWire | undefined): Draft {
  const stdio = entry && "command" in entry ? entry : undefined;
  const remote = entry && "url" in entry ? entry : undefined;
  return {
    transport: remote ? "url" : "stdio",
    command: stdio?.command ?? "",
    args: stdio?.args ?? [],
    env: toRows(stdio?.env),
    cwd: stdio?.cwd ?? "",
    urlType: remote?.type ?? "http",
    url: remote?.url ?? "",
    headers: toRows(remote?.headers),
  };
}

function buildEntry(draft: Draft): McpServerEntryWire {
  if (draft.transport === "stdio") {
    const env = fromRows(draft.env);
    return {
      command: draft.command.trim(),
      args: draft.args.map((a) => a.trim()).filter((a) => a !== ""),
      ...(env ? { env } : {}),
      ...(draft.cwd.trim() ? { cwd: draft.cwd.trim() } : {}),
    };
  }
  const headers = fromRows(draft.headers);
  return {
    type: draft.urlType,
    url: draft.url.trim(),
    ...(headers ? { headers } : {}),
  };
}

export function McpServerEditor({
  server,
  onSave,
  enablement,
  reconnectControl,
  dependents,
  onCancel,
}: McpServerEditorProps) {
  const notify = useAppToast();
  const isNew = server === null;
  const seed = seedDraft(server?.entry);

  // Seed once; the stable editor key preserves drafts across status polls.
  const [name, setName] = useState(server?.id ?? "");
  const [transport, setTransport] = useState<Transport>(seed.transport);
  const [command, setCommand] = useState(seed.command);
  const [args, setArgs] = useState<string[]>(seed.args);
  const [cwd, setCwd] = useState(seed.cwd);
  const [env, setEnv] = useState<KV[]>(seed.env);

  const [urlType, setUrlType] = useState<"http" | "sse">(seed.urlType);
  const [url, setUrl] = useState(seed.url);
  const [headers, setHeaders] = useState<KV[]>(seed.headers);

  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const draft: Draft = { transport, command, args, env, cwd, urlType, url, headers };
  const built = buildEntry(draft);
  const dirty =
    (isNew && name.trim() !== "") ||
    JSON.stringify(built) !== JSON.stringify(buildEntry(seed));
  const complete =
    name.trim() !== "" && (transport === "stdio" ? command.trim() !== "" : url.trim() !== "");
  const canSave = complete && dirty && !saving;

  const handleSave = async () => {
    if (!canSave) return;
    setSaving(true);
    setError(null);
    const id = server?.id ?? slugify(name, "server");
    try {
      await onSave(id, built);
      notify({ title: isNew ? "MCP server created" : "MCP server saved", tone: "success" });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Save failed");
      notify({
        title: "Could not save MCP server",
        description: e instanceof Error ? e.message : undefined,
        tone: "error",
      });
    } finally {
      setSaving(false);
    }
  };

  const cancel = () => onCancel(dirty);

  return (
    <div className="resource-editor">
      <button className="module-detail-back" onClick={cancel}>
        <ChevronLeft size={18} /> {L.mcpSection}
      </button>
      <header className="resource-editor-head">
        <h2 className="resource-editor-title">
          {isNew ? `New ${L.mcpServer}` : `Edit ${server?.id}`}
        </h2>
      </header>

      <div className="resource-editor-body">
        {enablement}
        {reconnectControl}

        <label className="field">
          <span className="field-label">Name</span>
          <input
            className="field-input"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="my-server"
            disabled={!isNew}
          />
          {isNew && name.trim() !== "" && (
            <span className="field-hint">
              Saved as <code>{slugify(name, "server")}</code> in <code>.mcp.json</code>
            </span>
          )}
          {!isNew && (
            <span className="field-hint">
              The ID is fixed once created — delete and re-create the server to rename it.
            </span>
          )}
        </label>

        <div className="field">
          <span className="field-label">Transport</span>
          <div className="mcp-transport-toggle">
            <button
              type="button"
              className={`btn-secondary${transport === "stdio" ? " active" : ""}`}
              aria-pressed={transport === "stdio"}
              onClick={() => setTransport("stdio")}
            >
              Stdio (local)
            </button>
            <button
              type="button"
              className={`btn-secondary${transport === "url" ? " active" : ""}`}
              aria-pressed={transport === "url"}
              onClick={() => setTransport("url")}
            >
              URL (remote)
            </button>
          </div>
        </div>

        {transport === "stdio" ? (
          <>
            <label className="field">
              <span className="field-label">Command</span>
              <p className="field-hint">
                The executable to spawn, e.g. <code>node</code> or <code>npx</code> (an absolute path
                works too).
              </p>
              <input
                className="field-input"
                value={command}
                onChange={(e) => setCommand(e.target.value)}
                placeholder="npx"
              />
            </label>

            <div className="field">
              <span className="field-label">
                Arguments <span className="field-optional">(optional)</span>
              </span>
              <ul className="mcp-arg-rows">
                {args.map((a, i) => (
                  <li className="mcp-arg-row" key={i}>
                    <input
                      className="field-input mcp-mono"
                      value={a}
                      onChange={(e) => setArgs((prev) => prev.map((x, j) => (j === i ? e.target.value : x)))}
                      placeholder="-y"
                    />
                    <button
                      type="button"
                      className="thread-action danger resource-prompt-del"
                      aria-label="Remove argument"
                      onClick={() => setArgs((prev) => prev.filter((_, j) => j !== i))}
                    >
                      <Trash2 size={14} />
                    </button>
                  </li>
                ))}
              </ul>
              <button type="button" className="btn-secondary" onClick={() => setArgs((prev) => [...prev, ""])}>
                <Plus size={14} /> Add argument
              </button>
            </div>

            <KvEditor label="Environment variables" rows={env} setRows={setEnv} keyPlaceholder="API_KEY" valuePlaceholder="secret-value" />

            <label className="field">
              <span className="field-label">
                Working directory <span className="field-optional">(optional)</span>
              </span>
              <input
                className="field-input mcp-mono"
                value={cwd}
                onChange={(e) => setCwd(e.target.value)}
                placeholder="/path/to/cwd"
              />
            </label>
          </>
        ) : (
          <>
            <label className="field">
              <span className="field-label">Type</span>
              <select
                className="field-input"
                value={urlType}
                onChange={(e) => setUrlType(e.target.value as "http" | "sse")}
              >
                <option value="http">http (streamable)</option>
                <option value="sse">sse</option>
              </select>
            </label>

            <label className="field">
              <span className="field-label">URL</span>
              <input
                className="field-input mcp-mono"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                placeholder="https://mcp.example.com/mcp"
              />
            </label>

            <KvEditor label="Headers" rows={headers} setRows={setHeaders} keyPlaceholder="Authorization" valuePlaceholder="Bearer …" />
          </>
        )}

        {error && <div className="schedule-editor-error">{error}</div>}
        {dependents}
      </div>

      <footer className="resource-editor-actions">
        <span className="resource-editor-actions-spacer" />
        <button type="button" className="btn-secondary" onClick={cancel} disabled={saving}>
          Cancel
        </button>
        <button
          type="button"
          className="btn-primary"
          onClick={() => void handleSave()}
          disabled={!canSave}
          aria-busy={saving}
        >
          {saving ? "Saving…" : isNew ? "Create" : "Save"}
        </button>
      </footer>
    </div>
  );
}

function KvEditor({
  label,
  rows,
  setRows,
  keyPlaceholder,
  valuePlaceholder,
}: {
  label: string;
  rows: KV[];
  setRows: React.Dispatch<React.SetStateAction<KV[]>>;
  keyPlaceholder: string;
  valuePlaceholder: string;
}) {
  const [revealed, setRevealed] = useState<ReadonlySet<number>>(new Set());
  const toggleRevealed = (i: number) =>
    setRevealed((prev) => {
      const next = new Set(prev);
      if (next.has(i)) next.delete(i);
      else next.add(i);
      return next;
    });
  const removeRow = (i: number) => {
    setRows((prev) => prev.filter((_, j) => j !== i));
    setRevealed((prev) => new Set([...prev].filter((j) => j !== i).map((j) => (j > i ? j - 1 : j))));
  };

  return (
    <div className="field">
      <span className="field-label">
        {label} <span className="field-optional">(optional)</span>
      </span>
      <ul className="mcp-kv-rows">
        {rows.map((r, i) => {
          const shown = revealed.has(i);
          return (
            <li className="mcp-kv-row" key={i}>
              <input
                className="field-input mcp-mono"
                value={r.key}
                onChange={(e) => setRows((prev) => prev.map((x, j) => (j === i ? { ...x, key: e.target.value } : x)))}
                placeholder={keyPlaceholder}
              />
              <span className="mcp-secret-field">
                <input
                  className="field-input mcp-mono"
                  type={shown ? "text" : "password"}
                  autoComplete="off"
                  value={r.value}
                  onChange={(e) => setRows((prev) => prev.map((x, j) => (j === i ? { ...x, value: e.target.value } : x)))}
                  placeholder={valuePlaceholder}
                />
                <button
                  type="button"
                  className="thread-action mcp-secret-toggle"
                  aria-label={shown ? `Hide ${r.key || label} value` : `Show ${r.key || label} value`}
                  aria-pressed={shown}
                  onClick={() => toggleRevealed(i)}
                >
                  {shown ? <EyeOff size={14} /> : <Eye size={14} />}
                </button>
              </span>
              <button
                type="button"
                className="thread-action danger"
                aria-label={`Remove ${label} row`}
                onClick={() => removeRow(i)}
              >
                <Trash2 size={14} />
              </button>
            </li>
          );
        })}
      </ul>
      <button type="button" className="btn-secondary" onClick={() => setRows((prev) => [...prev, { key: "", value: "" }])}>
        <Plus size={14} /> Add {label.toLowerCase()}
      </button>
    </div>
  );
}
