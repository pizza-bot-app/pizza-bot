import {
  Check,
  Cpu,
  Bot,
  Keyboard,
  LoaderCircle,
  Minus,
  Server,
  WifiOff,
  X,
} from "lucide-react";
import type { StatusInfo } from "@/api-client";
import { providerLabel } from "@/model-options";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";
import { contextUsageDisplay } from "./context-usage.js";

type Health = "ok" | "bad" | "warn" | "info";

const HEALTH_CLASS: Record<Health, string> = {
  ok: "text-ok",
  bad: "text-bad",
  warn: "text-warn",
  info: "text-info",
};

function formatTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 10_000) return `${(n / 1000).toFixed(1)}k`;
  return `${Math.round(n / 1000)}k`;
}

type McpServerStatus = StatusInfo["mcp"]["servers"][number]["status"];

function McpStatusIcon({ status }: { status: McpServerStatus }) {
  if (status === "loaded") return <Check size={12} className="text-ok" aria-hidden="true" />;
  if (status === "loading" || status === "retrying") {
    return (
      <LoaderCircle
        size={12}
        className="statusbar-status-spinner text-info"
        aria-hidden="true"
      />
    );
  }
  if (status === "disabled") return <Minus size={12} aria-hidden="true" />;
  return <X size={12} className="text-bad" aria-hidden="true" />;
}

function mcpServerDetail(server: StatusInfo["mcp"]["servers"][number]): string {
  if (server.status === "loaded") {
    return `${server.toolCount} tool${server.toolCount === 1 ? "" : "s"}`;
  }
  if (server.status === "retrying") return "retrying";
  if (server.status === "crashed") return "crashed";
  return server.status;
}

function TokenGauge({ used, windowSize }: { used: number; windowSize?: number }) {
  const frac = windowSize === undefined ? undefined : Math.min(1, used / windowSize);
  const pct = frac === undefined ? undefined : Math.round(frac * 100);
  const health: Health =
    frac === undefined ? "info" : frac >= 0.9 ? "bad" : frac >= 0.75 ? "warn" : "ok";
  const r = 6;
  const circ = 2 * Math.PI * r;
  const dash = frac === undefined ? 0 : circ * frac;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button className={`statusbar-gauge ${HEALTH_CLASS[health]}`} type="button">
          <svg width={16} height={16} viewBox="0 0 16 16" className="statusbar-gauge-ring">
            <circle cx={8} cy={8} r={r} className="statusbar-gauge-track" fill="none" strokeWidth={2.5} />
            {frac !== undefined && (
              <circle
                cx={8}
                cy={8}
                r={r}
                className="statusbar-gauge-fill"
                fill="none"
                strokeWidth={2.5}
                strokeDasharray={`${dash} ${circ}`}
                strokeLinecap="round"
                transform="rotate(-90 8 8)"
              />
            )}
          </svg>
          <span className="statusbar-gauge-label">{formatTokens(used)}</span>
        </button>
      </TooltipTrigger>
      <TooltipContent>
        <p className="statusbar-tip-title">Context window</p>
        <p className="statusbar-tip-detail">
          {windowSize === undefined
            ? `${formatTokens(used)} tokens used (maximum unavailable)`
            : `${formatTokens(used)} / ${formatTokens(windowSize)} tokens (${pct}%)`}
        </p>
      </TooltipContent>
    </Tooltip>
  );
}

function StatusIcon({
  health,
  icon,
  title,
  detail,
  servers,
  providers,
  onClick,
}: {
  health: Health;
  icon: React.ReactNode;
  title: string;
  detail: string;
  servers?: StatusInfo["mcp"]["servers"];
  providers?: StatusInfo["inference"]["providers"];
  onClick?: () => void;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          className={`statusbar-icon ${HEALTH_CLASS[health]}${onClick ? " statusbar-action" : ""}`}
          type="button"
          aria-label={`${title}: ${detail}`}
          onClick={onClick}
        >
          {icon}
        </button>
      </TooltipTrigger>
      <TooltipContent>
        <p className="statusbar-tip-title">{title}</p>
        <p className="statusbar-tip-detail">{detail}</p>
        {servers && servers.length > 0 && (
          <div className="statusbar-tip-servers">
            {servers.map((s) => (
              <span key={s.name} className="statusbar-tip-server">
                <McpStatusIcon status={s.status} />
                <span>{s.name} — {mcpServerDetail(s)}</span>
              </span>
            ))}
          </div>
        )}
        {providers && providers.length > 0 && (
          <div className="statusbar-tip-servers">
            {providers.map((provider) => (
              <span key={provider.name} className="statusbar-tip-server">
                ✓ {providerLabel(provider.name)}
                {` — ${provider.modelCount} model${provider.modelCount === 1 ? "" : "s"}`}
              </span>
            ))}
          </div>
        )}
      </TooltipContent>
    </Tooltip>
  );
}

export function StatusBar({
  status,
  reachable,
  contextWindow,
  usage,
  showContextUsage,
  onOpenShortcuts,
  connection,
  onOpenConnection,
}: {
  status?: StatusInfo;
  reachable?: boolean;
  contextWindow?: number;
  usage?: { input: number; output: number } | undefined;
  showContextUsage: boolean;
  onOpenShortcuts?: () => void;
  connection?: PizzaConnectionState;
  onOpenConnection?: () => void;
}) {
  const serverHealth: Health =
    reachable === false ? "bad" : reachable === true ? "ok" : "info";
  const serverTitle =
    reachable === false
      ? "Server unreachable"
      : connection?.mode === "remote"
        ? "Remote backend"
        : connection?.mode === "local"
          ? "Embedded backend"
          : "Backend";
  const serverDetail =
    reachable === false
      ? connection?.mode === "remote" && connection.remoteUrl
        ? `Can't reach ${connection.remoteUrl}. Retrying automatically.`
        : "Can't reach the embedded backend. Retrying automatically."
      : reachable === undefined
        ? "Connecting..."
        : connection?.mode === "remote" && connection.remoteUrl
          ? `Connected to ${connection.remoteUrl}`
          : connection?.mode === "local"
            ? "Connected to the embedded backend"
            : "Connected";
  const mcpLoading =
    status?.mcp.servers.filter(
      (server) => server.status === "loading" || server.status === "retrying",
    ).length ?? 0;
  const mcpFailed =
    status?.mcp.servers.filter(
      (server) => server.status === "error" || server.status === "crashed",
    ).length ?? 0;
  const mcpHealth: Health = !status
    ? "info"
    : status.mcp.total === 0
      ? "warn"
      : mcpFailed > 0
        ? status.mcp.loaded > 0 || mcpLoading > 0
          ? "warn"
          : "bad"
        : mcpLoading > 0
          ? "info"
          : status.mcp.available
            ? "ok"
            : "bad";
  const mcpProgress = status
    ? `${status.mcp.loaded}/${status.mcp.total} server${status.mcp.total === 1 ? "" : "s"} loaded`
    : "";
  const mcpProgressDetails = [
    mcpLoading > 0 ? `${mcpLoading} connecting` : "",
    mcpFailed > 0 ? `${mcpFailed} failed` : "",
  ].filter(Boolean);
  const mcpDetail = !status
    ? "Checking…"
    : status.mcp.total === 0
      ? status.mcp.disabled > 0
        ? `${status.mcp.disabled} MCP server${status.mcp.disabled === 1 ? "" : "s"} disabled`
        : "No MCP servers configured"
      : [mcpProgress, ...mcpProgressDetails].join(" · ");
  const inferenceHealth: Health = !status
    ? "info"
    : status.inference.available
      ? "ok"
      : "bad";
  const inferenceDetail = !status
    ? "Checking…"
    : status.inference.available
      ? `${status.inference.connected}/${status.inference.total} provider${
          status.inference.total === 1 ? "" : "s"
        } available`
      : "No inference providers available";
  const connectedProviders = status?.inference.providers.filter(
    (provider) => provider.status === "connected",
  );

  const contextUsage = showContextUsage
    ? contextUsageDisplay(usage, contextWindow)
    : undefined;

  return (
    <footer className="statusbar">
      <div className="statusbar-left">
        <StatusIcon
          health={serverHealth}
          icon={reachable === false ? <WifiOff size={16} /> : <Server size={16} />}
          title={serverTitle}
          detail={serverDetail}
          onClick={onOpenConnection}
        />
        <StatusIcon
          health={inferenceHealth}
          icon={<Bot size={16} />}
          title="Inference providers"
          detail={inferenceDetail}
          providers={connectedProviders}
        />
        <StatusIcon
          health={mcpHealth}
          icon={<Cpu size={16} />}
          title="MCP servers"
          detail={mcpDetail}
          servers={status?.mcp.servers}
        />
      </div>

      <div className="statusbar-right">
        {contextUsage && (
          <TokenGauge used={contextUsage.used} windowSize={contextUsage.windowSize} />
        )}
        {onOpenShortcuts && (
          <button
            className="statusbar-icon statusbar-shortcuts"
            type="button"
            title="Keyboard shortcuts"
            aria-label="Keyboard shortcuts"
            onClick={onOpenShortcuts}
          >
            <Keyboard size={16} />
          </button>
        )}
      </div>
    </footer>
  );
}
