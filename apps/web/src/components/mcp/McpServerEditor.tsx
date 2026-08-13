import { useState, type ReactNode } from "react";
import type { McpServerDoc, McpServerEntryWire } from "@/api-client";
import { ChevronLeft, Plus, Trash2 } from "lucide-react";
import { L } from "../../lexicon.js";
import { slugify } from "../../lib/utils.js";
import { useAppToast } from "../AppToast.js";

export interface McpServerEditorProps {
  server: McpServerDoc | null;
  onSave: (id: string, entry: McpServerEntryWire) => Promise<void>;
  onDelete?: () => Promise<void>;
  enablement?: ReactNode;
  reconnectControl?: ReactNode;
  dependents?: ReactNode;
  onCancel: () => void;
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

export function McpServerEditor({
  server,
  onSave,
  onDelete,
  enablement,
  reconnectControl,
  dependents,
  onCancel,
}: McpServerEditorProps) {
  const notify = useAppToast();
  const isNew = server === null;
  const entry = server?.entry;
  const initialTransport: Transport = entry && "url" in entry ? "url" : "stdio";

  // Seed once; the stable editor key preserves drafts across status polls.
  const [name, setName] = useState(server?.id ?? "");
  const [transport, setTransport] = useState<Transport>(initialTransport);
  const [command, setCommand] = useState(entry && "command" in entry ? entry.command : "");
  const [args, setArgs] = useState<string[]>(entry && "command" in entry ? entry.args ?? [] : []);
  const [cwd, setCwd] = useState(entry && "command" in entry ? entry.cwd ?? "" : "");
  const [env, setEnv] = useState<KV[]>(entry && "command" in entry ? toRows(entry.env) : []);

  const [urlType, setUrlType] = useState<"http" | "sse">(
    entry && "url" in entry ? entry.type ?? "http" : "http",
  );
  const [url, setUrl] = useState(entry && "url" in entry ? entry.url : "");
  const [headers, setHeaders] = useState<KV[]>(entry && "url" in entry ? toRows(entry.headers) : []);

  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const canSave =
    name.trim() !== "" && (transport === "stdio" ? command.trim() !== "" : url.trim() !== "") && !saving;

  const handleSave = async () => {
    if (!canSave) return;
    setSaving(true);
    setError(null);
    const id = server?.id ?? slugify(name, "server");
    const built: McpServerEntryWire =
      transport === "stdio"
        ? {
            command: command.trim(),
            args: args.map((a) => a.trim()).filter((a) => a !== ""),
            ...(fromRows(env) ? { env: fromRows(env) } : {}),
            ...(cwd.trim() ? { cwd: cwd.trim() } : {}),
          }
        : {
            type: urlType,
            url: url.trim(),
            ...(fromRows(headers) ? { headers: fromRows(headers) } : {}),
          };
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

  return (
    <div className="resource-editor">
      <button className="module-detail-back" onClick={onCancel}>
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
        {!isNew && onDelete && (
          <button
            type="button"
            className="btn-secondary resource-editor-delete"
            onClick={() => void onDelete()}
            disabled={saving}
          >
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
  return (
    <div className="field">
      <span className="field-label">
        {label} <span className="field-optional">(optional)</span>
      </span>
      <ul className="mcp-kv-rows">
        {rows.map((r, i) => (
          <li className="mcp-kv-row" key={i}>
            <input
              className="field-input mcp-mono"
              value={r.key}
              onChange={(e) => setRows((prev) => prev.map((x, j) => (j === i ? { ...x, key: e.target.value } : x)))}
              placeholder={keyPlaceholder}
            />
            <input
              className="field-input mcp-mono"
              value={r.value}
              onChange={(e) => setRows((prev) => prev.map((x, j) => (j === i ? { ...x, value: e.target.value } : x)))}
              placeholder={valuePlaceholder}
            />
            <button
              type="button"
              className="thread-action danger"
              aria-label={`Remove ${label} row`}
              onClick={() => setRows((prev) => prev.filter((_, j) => j !== i))}
            >
              <Trash2 size={14} />
            </button>
          </li>
        ))}
      </ul>
      <button type="button" className="btn-secondary" onClick={() => setRows((prev) => [...prev, { key: "", value: "" }])}>
        <Plus size={14} /> Add {label.toLowerCase()}
      </button>
    </div>
  );
}
