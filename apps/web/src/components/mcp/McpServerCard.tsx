import type { McpServerRow } from "@/api-client";
import { ChevronLeft, Cable, Puzzle, Globe, TerminalSquare } from "lucide-react";
import { ProvenanceBadge } from "../ProvenanceBadge.js";
import { L } from "../../lexicon.js";
import type { ReactNode } from "react";
import { CapabilityStatusDot, type CapabilityVisualState } from "../CapabilityControls.js";

export function mcpVisualState(server: McpServerRow): CapabilityVisualState {
  if (!server.enabled || server.status === "disabled") return "disabled";
  if (server.status === "loading" || server.status === "retrying") return "loading";
  if (server.status === "connected") return "active";
  if (server.status === "crashed") return "crashed";
  return "unavailable";
}

export function mcpStatusLabel(server: McpServerRow): string {
  if (!server.enabled || server.status === "disabled") return "Disabled";
  switch (server.status) {
    case "connected":
      return `Connected · ${server.toolCount} tool${server.toolCount === 1 ? "" : "s"}`;
    case "loading":
    case "retrying":
      return "Connecting…";
    case "crashed":
      return "Crashed";
    default:
      return "Failed to connect";
  }
}

export interface McpServerCardProps {
  server: McpServerRow;
  onBack?: () => void;
  actions?: ReactNode;
  enablement?: ReactNode;
  reconnectControl?: ReactNode;
  dependents?: ReactNode;
  loadError?: ReactNode;
}

export function McpServerCard({
  server,
  actions,
  enablement,
  reconnectControl,
  dependents,
  loadError,
  onBack,
}: McpServerCardProps) {
  const isStdio = "command" in server.entry;
  const statusLabel = mcpStatusLabel(server);

  return (
    <div className="resource-card">
      {onBack && (
        <button className="module-detail-back" onClick={onBack}>
          <ChevronLeft size={18} /> {L.mcpSection}
        </button>
      )}
      <header className="resource-card-head">
        <div className="skill-card-glyph">
          <Cable size={28} strokeWidth={1.5} />
        </div>
        <div className="resource-card-titles">
          <div className="resource-card-name-row">
            <h2 className="resource-card-name">{server.id}</h2>
            <ProvenanceBadge provenance={server.source} />
          </div>
          <p className="resource-card-desc">
            <CapabilityStatusDot state={mcpVisualState(server)} label={statusLabel} /> {statusLabel}
          </p>
          {server.pluginName && (
            <p className="skill-card-provenance">
              <Puzzle size={13} /> from plugin <code>{server.pluginName}</code>
            </p>
          )}
        </div>
        {actions && <div className="resource-card-actions">{actions}</div>}
      </header>

      {loadError}
      {enablement}
      {reconnectControl}

      <section className="resource-card-section">
        <h3 className="resource-card-section-title">
          {isStdio ? (
            <>
              <TerminalSquare size={14} /> Stdio transport
            </>
          ) : (
            <>
              <Globe size={14} /> {("type" in server.entry && server.entry.type) || "http"} transport
            </>
          )}
        </h3>
        {"command" in server.entry ? (
          <pre className="skill-card-body">
            {`${server.entry.command} ${(server.entry.args ?? []).join(" ")}`.trim()}
          </pre>
        ) : (
          <pre className="skill-card-body">{server.entry.url}</pre>
        )}
      </section>
      {dependents}
    </div>
  );
}
