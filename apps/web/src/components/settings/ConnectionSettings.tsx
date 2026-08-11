import { useEffect, useState } from "react";
import { Check, LoaderCircle } from "lucide-react";
import type { DesktopConnection } from "../../use-desktop-connection.js";

export function ConnectionSettings({
  connection,
  runningCount,
}: {
  connection: DesktopConnection;
  runningCount: number;
}) {
  const current = connection.state;
  const [mode, setMode] = useState<"local" | "remote">(current?.mode ?? "local");
  const [remoteUrl, setRemoteUrl] = useState(current?.remoteUrl ?? "");
  const [token, setToken] = useState("");
  const [clearToken, setClearToken] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  useEffect(() => {
    if (!current) return;
    setMode(current.mode);
    setRemoteUrl(current.remoteUrl ?? "");
  }, [current]);

  const switchBackend = async () => {
    if (
      runningCount > 0 &&
      !window.confirm(
        `${runningCount} conversation${runningCount === 1 ? " is" : "s are"} still running. Switching backends will disconnect ${runningCount === 1 ? "it" : "them"}. Continue?`,
      )
    ) {
      return;
    }
    setBusy(true);
    setError(undefined);
    try {
      if (mode === "local") {
        await connection.useLocal();
      } else {
        await connection.useRemote({
          remoteUrl,
          token: token.trim()
            ? token.trim()
            : clearToken
              ? null
              : reusesSavedToken
                ? undefined
                : null,
        });
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  };

  const managed = current?.managedByEnvironment ?? false;
  const reusesSavedToken =
    current?.hasToken === true &&
    remoteUrl.trim().replace(/\/$/, "") === current.remoteUrl;
  const connected =
    current?.mode === mode &&
    (mode === "local" ||
      remoteUrl.trim().replace(/\/$/, "") === current.remoteUrl);

  return (
    <section className="settings-group settings-connection">
      <h2 className="settings-group-title">Backend connection</h2>
      <div className="settings-row settings-row-stacked">
        <div className="settings-row-text">
          <div className="settings-row-label">Backend</div>
          <div className="settings-row-hint">
            Conversations, providers, MCP servers, automations, and logs belong to the selected backend.
          </div>
        </div>
        <div className="segmented settings-connection-mode" role="group" aria-label="Backend">
          <button
            type="button"
            className={`segmented-btn${mode === "local" ? " active" : ""}`}
            aria-pressed={mode === "local"}
            disabled={managed || busy}
            onClick={() => setMode("local")}
          >
            Embedded
          </button>
          <button
            type="button"
            className={`segmented-btn${mode === "remote" ? " active" : ""}`}
            aria-pressed={mode === "remote"}
            disabled={managed || busy}
            onClick={() => setMode("remote")}
          >
            Remote
          </button>
        </div>

        {mode === "remote" && (
          <div className="settings-connection-fields">
            <label className="field">
              <span className="field-label">Backend URL</span>
              <input
                className="field-input"
                type="url"
                inputMode="url"
                placeholder="https://pizza.example"
                value={remoteUrl}
                disabled={managed || busy}
                onChange={(event) => setRemoteUrl(event.target.value)}
              />
            </label>
            <label className="field">
              <span className="field-label">Bearer token</span>
              <input
                className="field-input"
                type="password"
                autoComplete="off"
                placeholder={
                  reusesSavedToken && !clearToken
                    ? "Stored in OS keychain"
                    : "Optional"
                }
                value={token}
                disabled={managed || busy}
                onChange={(event) => {
                  setToken(event.target.value);
                  setClearToken(false);
                }}
              />
              <span className="field-hint">
                Stored encrypted in your OS keychain and sent as a Bearer token.
              </span>
            </label>
            {reusesSavedToken && !managed && (
              <label className="settings-connection-clear">
                <input
                  type="checkbox"
                  checked={clearToken}
                  disabled={busy || token.length > 0}
                  onChange={(event) => setClearToken(event.target.checked)}
                />
                <span>Remove saved token</span>
              </label>
            )}
          </div>
        )}

        {managed && (
          <div className="settings-connection-notice">
            Backend selection is managed by <code>PIZZA_API_BASE</code>.
          </div>
        )}
        {runningCount > 0 && !managed && (
          <div className="settings-connection-notice warn">
            {runningCount} active conversation{runningCount === 1 ? "" : "s"} will be disconnected when switching.
          </div>
        )}
        {error && <div className="schedule-editor-error">{error}</div>}

        <div className="settings-provider-actions">
          {connected && !busy && (
            <span className="settings-connection-current">
              <Check size={14} /> Current backend
            </span>
          )}
          <button
            type="button"
            className="btn-primary"
            disabled={
              managed ||
              busy ||
              current === undefined ||
              (mode === "local" && current.mode === "local") ||
              (mode === "remote" && remoteUrl.trim().length === 0)
            }
            onClick={() => void switchBackend()}
          >
            {busy && <LoaderCircle size={14} className="spin" />}
            {busy
              ? mode === "remote"
                ? "Testing connection..."
                : "Starting embedded backend..."
              : mode === "remote"
                ? "Test and connect"
                : "Use embedded backend"}
          </button>
        </div>
      </div>
    </section>
  );
}
