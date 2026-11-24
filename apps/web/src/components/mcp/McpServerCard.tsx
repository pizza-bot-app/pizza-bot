import type { McpServerRow, McpToolInfo } from "@/api-client";
import { Cable, Globe, TerminalSquare } from "lucide-react";
import { ResourceSection, ResourceView } from "../ResourceView.js";
import { ProvenanceBadge } from "../ProvenanceBadge.js";
import { L } from "../../lexicon.js";
import { useState, type ReactNode } from "react";
import { CapabilityStatusDot, type CapabilityVisualState } from "../CapabilityControls.js";
import { McpToolsDialog } from "./McpToolsDialog.js";

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
  onGetTools?: (id: string) => Promise<McpToolInfo[]>;
  headerAction?: ReactNode;
  enablement?: ReactNode;
  reconnectControl?: ReactNode;
  dependents?: ReactNode;
  loadError?: ReactNode;
}

export function McpServerCard({
  server,
  headerAction,
  enablement,
  reconnectControl,
  dependents,
  loadError,
  onBack,
  onGetTools,
}: McpServerCardProps) {
  const [toolsOpen, setToolsOpen] = useState(false);
  const isStdio = "command" in server.entry;
  const statusLabel = mcpStatusLabel(server);
  const toolsLabel = `${server.toolCount} tool${server.toolCount === 1 ? "" : "s"}`;
  const canListTools = server.status === "connected" && onGetTools !== undefined;

  return (
    <ResourceView
      glyph={<Cable size={28} strokeWidth={1.5} />}
      name={server.id}
      badge={<ProvenanceBadge provenance={server.source} />}
      status={
        <>
          <CapabilityStatusDot state={mcpVisualState(server)} label={statusLabel} />{" "}
          {canListTools ? (
            <>
              Connected ·{" "}
              <button
                type="button"
                className="resource-card-link mcp-tools-link"
                onClick={() => setToolsOpen(true)}
                aria-haspopup="dialog"
                title="Show the tools this server provides"
              >
                {toolsLabel}
              </button>
            </>
          ) : (
            statusLabel
          )}
        </>
      }
      headerAction={headerAction}
      backLabel={L.mcpSection}
      onBack={onBack}
    >
      {loadError}
      {enablement}
      {reconnectControl}
      <ResourceSection
        title={isStdio ? "Stdio transport" : `${("type" in server.entry && server.entry.type) || "http"} transport`}
        icon={isStdio ? <TerminalSquare size={14} /> : <Globe size={14} />}
      >
        {"command" in server.entry ? (
          <pre className="skill-card-body">
            {`${server.entry.command} ${(server.entry.args ?? []).join(" ")}`.trim()}
          </pre>
        ) : (
          <pre className="skill-card-body">{server.entry.url}</pre>
        )}
      </ResourceSection>
      {dependents}
      {toolsOpen && onGetTools && (
        <McpToolsDialog
          serverId={server.id}
          toolCount={server.toolCount}
          onGetTools={onGetTools}
          onClose={() => setToolsOpen(false)}
        />
      )}
    </ResourceView>
  );
}
