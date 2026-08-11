import type { McpServerRow } from "@/api-client";
import { ChevronLeft, Cable, Puzzle, Globe, TerminalSquare } from "lucide-react";
import { Badge } from "../ui/badge.js";
import { L } from "../../lexicon.js";
import type { ReactNode } from "react";
import { CapabilityStatusDot, type CapabilityVisualState } from "../CapabilityControls.js";

export interface McpServerCardProps {
  server: McpServerRow;
  onBack?: () => void;
  enablement?: ReactNode;
  dependents?: ReactNode;
}

export function McpServerCard({ server, enablement, dependents, onBack }: McpServerCardProps) {
  const isStdio = "command" in server.entry;
  const statusLabel =
    server.status === "connected"
      ? `Connected · ${server.toolCount} tool(s)`
      : server.status === "disabled"
        ? "Disabled"
        : "Not connected";
  const visualState: CapabilityVisualState =
    !server.enabled || server.status === "disabled"
      ? "disabled"
      : server.status === "connected"
        ? "active"
        : server.status === "crashed"
          ? "crashed"
        : server.status === "loading" || server.status === "retrying"
          ? "loading"
          : "unavailable";

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
            <Badge variant="secondary">{L.pluginBadge}</Badge>
          </div>
          <p className="resource-card-desc">
            <CapabilityStatusDot state={visualState} label={statusLabel} /> {statusLabel}
          </p>
          {server.pluginName && (
            <p className="skill-card-provenance">
              <Puzzle size={13} /> from plugin <code>{server.pluginName}</code>
            </p>
          )}
        </div>
      </header>

      {enablement}

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
