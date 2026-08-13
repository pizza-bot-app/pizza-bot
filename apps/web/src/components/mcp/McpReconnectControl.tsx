import { useState } from "react";
import { RefreshCw } from "lucide-react";
import type { McpServerRow } from "@/api-client";
import { useAppToast } from "../AppToast.js";

export function McpReconnectControl({
  server,
  onReconnect,
}: {
  server: McpServerRow;
  onReconnect: (id: string) => Promise<McpServerRow>;
}) {
  const notify = useAppToast();
  const [busy, setBusy] = useState(false);
  if (
    !server.enabled ||
    (server.status !== "error" && server.status !== "crashed")
  ) {
    return null;
  }

  const retry = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const next = await onReconnect(server.id);
      if (next.status === "connected") {
        notify({ title: `${server.id} connected`, tone: "success" });
      } else {
        notify({
          title: `Could not connect ${server.id}`,
          description: next.detail,
          tone: "error",
        });
      }
    } catch (error) {
      notify({
        title: `Could not connect ${server.id}`,
        description: error instanceof Error ? error.message : undefined,
        tone: "error",
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="mcp-reconnect" aria-live="polite">
      <div className="mcp-reconnect-copy">
        <div className="mcp-reconnect-title">
          {server.status === "crashed" ? "Connection lost" : "Connection failed"}
        </div>
        <div className="mcp-reconnect-detail">
          {server.detail ?? "The server did not complete MCP initialization."}
        </div>
      </div>
      <button
        type="button"
        className="btn-secondary mcp-reconnect-button"
        disabled={busy}
        onClick={() => void retry()}
      >
        <RefreshCw
          size={14}
          className={busy ? "mcp-reconnect-spinner" : undefined}
        />
        {busy ? "Retrying..." : "Retry connection"}
      </button>
    </section>
  );
}
