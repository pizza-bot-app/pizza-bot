import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  ApiClient,
  LogLevel,
  LogQueryParams,
  LogRecord,
} from "@/api-client";
import {
  ChevronRight,
  Download,
  LoaderCircle,
  Pause,
  Play,
  RefreshCw,
  Search,
  ScrollText,
  Trash2,
} from "lucide-react";
import { ModuleHeader } from "../ModuleHeader.js";
import { useAppToast } from "../AppToast.js";
import { ConfirmationDialog } from "../ConfirmationDialog.js";
import { formatLogContextSummary } from "./log-summary.js";

const LEVELS: LogLevel[] = ["debug", "info", "warn", "error"];

export function LogsModule({ client }: { client: ApiClient }) {
  const notify = useAppToast();
  const [records, setRecords] = useState<LogRecord[]>([]);
  const [levels, setLevels] = useState<Set<LogLevel>>(() => new Set(LEVELS));
  const [processName, setProcessName] = useState("");
  const [component, setComponent] = useState("");
  const [search, setSearch] = useState("");
  const [follow, setFollow] = useState(true);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [expanded, setExpanded] = useState<string>();
  const [clearOpen, setClearOpen] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [clearError, setClearError] = useState<string>();
  const listRef = useRef<HTMLDivElement>(null);

  const query = useMemo<LogQueryParams>(
    () => ({
      levels: [...levels],
      ...(processName ? { processes: [processName] } : {}),
      ...(component ? { components: [component] } : {}),
      ...(search.trim() ? { search: search.trim() } : {}),
      limit: 1_000,
    }),
    [component, levels, processName, search],
  );

  const refresh = useCallback(async () => {
    try {
      const result = window.__PIZZA_LOGS__?.local
        ? await window.__PIZZA_LOGS__.query(query) as Awaited<ReturnType<typeof client.listLogs>>
        : await client.listLogs(query);
      setRecords(result.records);
      setError(undefined);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not load logs");
    } finally {
      setLoading(false);
    }
  }, [client, query]);

  useEffect(() => {
    setLoading(true);
    void refresh();
    if (!follow) return;
    const timer = setInterval(() => void refresh(), 1_500);
    return () => clearInterval(timer);
  }, [follow, refresh]);

  useEffect(() => {
    if (!follow) return;
    const list = listRef.current;
    if (list) list.scrollTop = list.scrollHeight;
  }, [follow, records]);

  const processes = useMemo(
    () => [...new Set(records.map((record) => record.process))].sort(),
    [records],
  );
  const components = useMemo(
    () => [...new Set(records.map((record) => record.component))].sort(),
    [records],
  );

  const toggleLevel = (level: LogLevel) => {
    setLevels((current) => {
      const next = new Set(current);
      if (next.has(level) && next.size > 1) next.delete(level);
      else next.add(level);
      return next;
    });
  };

  const download = async () => {
    try {
      const blob = window.__PIZZA_LOGS__?.local
        ? new Blob(
            [
              (
                await window.__PIZZA_LOGS__.query({ ...query, limit: 5_000 }) as Awaited<
                  ReturnType<typeof client.listLogs>
                >
              ).records.map((record) => JSON.stringify(record)).join("\n") + "\n",
            ],
            { type: "application/x-ndjson" },
          )
        : await client.downloadLogs(query);
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `pizza-bot-logs-${new Date().toISOString().slice(0, 10)}.ndjson`;
      anchor.click();
      URL.revokeObjectURL(url);
      notify({ title: "Logs downloaded", tone: "success" });
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : "Could not download logs";
      setError(message);
      notify({ title: "Could not download logs", description: message, tone: "error" });
    }
  };

  const clear = async () => {
    setClearing(true);
    setClearError(undefined);
    try {
      if (window.__PIZZA_LOGS__?.local) await window.__PIZZA_LOGS__.clear();
      else await client.clearLogs();
      setRecords([]);
      setExpanded(undefined);
      setError(undefined);
      setClearOpen(false);
      notify({ title: "Logs cleared", tone: "success" });
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : "Could not clear logs";
      setClearError(message);
      notify({ title: "Could not clear logs", description: message, tone: "error" });
    } finally {
      setClearing(false);
    }
  };

  return (
    <section className="module logs-module">
      <ModuleHeader icon={<ScrollText size={18} />} title="Logs" count={records.length}>
        <span className="module-header-spacer" />
        <button
          className={`btn-secondary logs-command${follow ? " active" : ""}`}
          type="button"
          onClick={() => setFollow((value) => !value)}
          title={follow ? "Pause live updates" : "Resume live updates"}
        >
          {follow ? <Pause size={15} /> : <Play size={15} />}
          {follow ? "Pause" : "Follow"}
        </button>
        <button
          className="btn-secondary logs-icon-command"
          type="button"
          onClick={() => void refresh()}
          title="Refresh logs"
          aria-label="Refresh logs"
        >
          <RefreshCw size={15} className={loading ? "spin" : ""} />
        </button>
        <button
          className="btn-secondary logs-icon-command"
          type="button"
          onClick={() => void download()}
          title="Download filtered logs"
          aria-label="Download filtered logs"
        >
          <Download size={15} />
        </button>
        <button
          className="btn-secondary logs-icon-command"
          type="button"
          onClick={() => {
            setClearError(undefined);
            setClearOpen(true);
          }}
          title="Clear all logs from disk"
          aria-label="Clear all logs from disk"
        >
          <Trash2 size={15} />
        </button>
      </ModuleHeader>

      <div className="logs-toolbar">
        <label className="logs-search">
          <Search size={15} />
          <input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search messages and context"
            aria-label="Search logs"
          />
        </label>
        <select
          className="logs-select"
          value={processName}
          onChange={(event) => setProcessName(event.target.value)}
          aria-label="Filter by process"
        >
          <option value="">All processes</option>
          {processes.map((value) => <option key={value}>{value}</option>)}
        </select>
        <select
          className="logs-select"
          value={component}
          onChange={(event) => setComponent(event.target.value)}
          aria-label="Filter by component"
        >
          <option value="">All components</option>
          {components.map((value) => <option key={value}>{value}</option>)}
        </select>
        <div className="logs-levels" aria-label="Filter by level">
          {LEVELS.map((level) => (
            <button
              key={level}
              className={`logs-level logs-level-${level}${levels.has(level) ? " active" : ""}`}
              type="button"
              aria-pressed={levels.has(level)}
              onClick={() => toggleLevel(level)}
            >
              {level}
            </button>
          ))}
        </div>
      </div>

      {error && <div className="logs-error" role="alert">{error}</div>}

      <div className="logs-table-head" aria-hidden="true">
        <span>Time</span>
        <span>Level</span>
        <span>Source</span>
        <span>Message</span>
      </div>
      <div className="logs-list" ref={listRef} role="log" aria-live="polite">
        {loading && records.length === 0 && (
          <div className="logs-loading" aria-busy="true">
            <LoaderCircle className="spin" size={18} />
            Loading logs
          </div>
        )}
        {!loading && records.length === 0 && (
          <div className="logs-empty">No records match the current filters.</div>
        )}
        {records.map((record) => {
          const contextSummary = formatLogContextSummary(record);
          return (
            <div
              className={`log-entry${expanded === record.id ? " expanded" : ""}`}
              key={record.id}
            >
              <button
                type="button"
                className="log-row"
                aria-expanded={expanded === record.id}
                onClick={() => setExpanded((id) => id === record.id ? undefined : record.id)}
              >
                <time dateTime={record.timestamp}>{formatTime(record.timestamp)}</time>
                <span className={`log-level log-level-${record.level}`}>{record.level}</span>
                <span className="log-source">
                  <strong>{record.process}</strong>
                  <span>{record.component}</span>
                </span>
                <span className="log-message">
                  <ChevronRight size={14} aria-hidden="true" />
                  <span className="log-message-copy">
                    <span>{record.message}</span>
                    {contextSummary && (
                      <span className="log-context-summary">· {contextSummary}</span>
                    )}
                  </span>
                </span>
              </button>
              {expanded === record.id && (
                <pre className="log-detail">{JSON.stringify(record, null, 2)}</pre>
              )}
            </div>
          );
        })}
      </div>
      {clearOpen && (
        <ConfirmationDialog
          title="Clear all logs?"
          message="All diagnostic log files for this backend will be permanently deleted. Active processes may start new log files immediately."
          confirmLabel="Clear logs"
          destructive
          busy={clearing}
          error={clearError}
          onCancel={() => {
            setClearOpen(false);
            setClearError(undefined);
          }}
          onConfirm={() => void clear()}
        />
      )}
    </section>
  );
}

function formatTime(timestamp: string): string {
  const date = new Date(timestamp);
  return Number.isNaN(date.getTime())
    ? timestamp
    : date.toLocaleTimeString([], {
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hour12: false,
        fractionalSecondDigits: 3,
      });
}
