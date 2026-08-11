import { useCallback, useState, type PointerEvent, type ReactNode } from "react";
import type { AgentInfo, ModelsInfo, ApiClient } from "@/api-client";
import { useThreadSlice } from "../use-thread-slice.js";
import type { PromptHistoryCycler } from "../use-prompt-history.js";
import { ChatFeed } from "./ChatFeed.js";
import { ChatHeader } from "./ChatHeader.js";
import { WelcomeState } from "./WelcomeState.js";
import { Composer } from "./Composer.js";
import { RunErrorBanner } from "./RunErrorBanner.js";
import { useHotkey } from "../hotkeys/index.js";

const INTERACTIVE_CHAT_SELECTOR =
  "a, button, input, textarea, select, [contenteditable='true'], [role='button'], [role='listbox']";

export interface ChatPaneProps {
  threadId: string;
  hydrateOnMount?: boolean;
  onFork?: (threadId: string, messageIndex: number) => void;
  agent?: AgentInfo;
  onRename?: (title: string) => Promise<void>;
  models: ModelsInfo;
  initialModel?: string;
  onModelChange?: (modelId: string) => void;
  client: ApiClient;
  title?: string;
  composerRef?: React.RefObject<HTMLTextAreaElement | null>;
  onComposerEscape?: () => void;
  history?: PromptHistoryCycler;
  onBack?: () => void;
  headerActions?: ReactNode;
  searchTarget?: { messageId: string; token: number };
  onSearchTargetHandled?: (token: number) => void;
}

export function ChatPane({
  threadId,
  hydrateOnMount,
  onFork,
  agent,
  onRename,
  models,
  initialModel,
  onModelChange,
  client,
  title,
  composerRef,
  onComposerEscape,
  history,
  onBack,
  headerActions,
  searchTarget,
  onSearchTargetHandled,
}: ChatPaneProps) {
  const { messages, status, errorText, errorCode, queued, send, steerNow, cancelQueued, stop, decide } =
    useThreadSlice(threadId, hydrateOnMount);
  const [prefill, setPrefill] = useState<string | undefined>();
  const [prefillToken, setPrefillToken] = useState(0);
  useHotkey("chat.escapeToList", () => onComposerEscape?.(), {
    enabled: !!onComposerEscape,
  });

  const focusChatSurface = useCallback((event: PointerEvent<HTMLDivElement>) => {
    const target = event.target;
    if (target instanceof Element && target.closest(INTERACTIVE_CHAT_SELECTOR)) return;
    event.currentTarget.focus({ preventScroll: true });
  }, []);

  const applyPrefill = (prompt: string) => {
    setPrefill(prompt);
    setPrefillToken((t) => t + 1);
  };

  const headerTitle = title ?? agent?.name ?? "New Pizza Bot Conversation";
  return (
    <div className="chat-pane-inner" data-testid={`pane-${threadId}`}>
      <ChatHeader
        title={headerTitle}
        onRename={onRename}
        onBack={onBack}
        actions={headerActions}
      />
      {messages.length === 0 ? (
        <div
          className="feed-scroll"
          data-hotkey-zone="chat"
          onPointerDown={focusChatSurface}
          tabIndex={-1}
        >
          <WelcomeState agent={agent} onPrefill={applyPrefill} />
        </div>
      ) : (
        <ChatFeed
          messages={messages}
          client={client}
          assistant={agent}
          onDecision={decide}
          onFork={onFork && status !== "streaming" ? (index) => onFork(threadId, index) : undefined}
          searchTarget={searchTarget}
          onSearchTargetHandled={onSearchTargetHandled}
          onSurfacePointerDown={focusChatSurface}
        />
      )}
      {status === "error" && errorText && (
        <RunErrorBanner text={errorText} code={errorCode} />
      )}
      <Composer
        threadId={threadId}
        streaming={status === "streaming"}
        interrupted={status === "interrupted"}
        onSend={send}
        onSteerNow={steerNow}
        onStop={stop}
        queued={queued}
        onCancelQueued={cancelQueued}
        models={models}
        initialModel={initialModel}
        onModelChange={onModelChange}
        client={client}
        prefill={prefill}
        prefillToken={prefillToken}
        composerRef={composerRef}
        history={history}
      />
    </div>
  );
}
