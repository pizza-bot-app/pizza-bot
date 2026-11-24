import { useEffect, useState } from "react";
import { Dialog as DialogPrimitive } from "radix-ui";
import { Wrench, X } from "lucide-react";
import type { McpToolInfo } from "@/api-client";
import { SkeletonLines } from "../ResourceDetailSkeleton.js";
import { filterTools } from "../tools/tool-catalog.js";
import { ToolFilterInput, ToolRow } from "../tools/ToolList.js";

export interface McpToolsDialogProps {
  serverId: string;
  toolCount: number;
  onGetTools: (id: string) => Promise<McpToolInfo[]>;
  onClose: () => void;
}

type LoadState =
  | { kind: "loading" }
  | { kind: "loaded"; tools: McpToolInfo[] }
  | { kind: "failed"; message: string };

export function McpToolsDialog({ serverId, toolCount, onGetTools, onClose }: McpToolsDialogProps) {
  const [state, setState] = useState<LoadState>({ kind: "loading" });
  const [query, setQuery] = useState("");
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let alive = true;
    setState({ kind: "loading" });
    onGetTools(serverId).then(
      (tools) => alive && setState({ kind: "loaded", tools }),
      (cause: unknown) =>
        alive &&
        setState({
          kind: "failed",
          message: cause instanceof Error ? cause.message : "Could not load tools.",
        }),
    );
    return () => {
      alive = false;
    };
  }, [serverId, onGetTools, attempt]);

  const visible = state.kind === "loaded" ? filterTools(state.tools, query) : [];

  return (
    <DialogPrimitive.Root open onOpenChange={(open) => !open && onClose()}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="sidebar-modal-backdrop" />
        <DialogPrimitive.Content className="sidebar-modal mcp-tools-modal" aria-busy={state.kind === "loading"}>
          <header className="mcp-tools-head">
            <div>
              <DialogPrimitive.Title className="sidebar-modal-title">
                <Wrench size={15} /> Tools from <code>{serverId}</code>
              </DialogPrimitive.Title>
              <DialogPrimitive.Description className="sidebar-modal-body">
                {toolCount} tool{toolCount === 1 ? "" : "s"} available to Pizza Bot
              </DialogPrimitive.Description>
            </div>
            <DialogPrimitive.Close asChild>
              <button type="button" className="thread-action" aria-label="Close">
                <X size={16} />
              </button>
            </DialogPrimitive.Close>
          </header>

          <ToolFilterInput value={query} onChange={setQuery} autoFocus />

          <div className="mcp-tools-list-wrap">
            {state.kind === "loading" && (
              <ul className="tool-rows" aria-label="Loading tools">
                {Array.from({ length: Math.min(Math.max(toolCount, 1), 6) }, (_, index) => (
                  <li key={index} className="tool-row tool-row-body">
                    <SkeletonLines count={2} />
                  </li>
                ))}
              </ul>
            )}
            {state.kind === "failed" && (
              <div className="sidebar-modal-error" role="alert">
                {state.message}{" "}
                <button
                  type="button"
                  className="resource-card-link"
                  onClick={() => setAttempt((current) => current + 1)}
                >
                  Retry
                </button>
              </div>
            )}
            {state.kind === "loaded" && visible.length === 0 && (
              <p className="resource-card-empty">
                {state.tools.length === 0 ? "This server exposes no tools." : `No tools match “${query}”`}
              </p>
            )}
            {state.kind === "loaded" && visible.length > 0 && (
              <ul className="tool-rows">
                {visible.map((tool) => (
                  <ToolRow key={tool.name} name={tool.name} description={tool.description} />
                ))}
              </ul>
            )}
          </div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
