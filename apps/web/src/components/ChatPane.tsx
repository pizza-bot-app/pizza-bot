import { useCallback, useState, type PointerEvent, type ReactNode } from "react";
import type { ModelsInfo, ApiClient } from "@/api-client";
import { useThreadSlice } from "../use-thread-slice.js";
import type { PromptHistoryCycler } from "../use-prompt-history.js";
import { ChatFeed } from "./ChatFeed.js";
import { ChatHeader } from "./ChatHeader.js";
import { WelcomeState } from "./WelcomeState.js";
import { Composer } from "./Composer.js";
import { RunErrorBanner } from "./RunErrorBanner.js";
import { BlankTurnNotice } from "./BlankTurnNotice.js";
import { CutOffRetryNotice } from "./CutOffRetryNotice.js";
import { useHotkey } from "../hotkeys/index.js";
import { RecipientField } from "./RecipientField.js";
import { messageAgentLabel, workThreadNotice } from "../lexicon.js";
import type { RecipientOption, ThreadAgent } from "../lib/thread-agent.js";

const INTERACTIVE_CHAT_SELECTOR =
  "a, button, input, textarea, select, [contenteditable='true'], [role='button'], [role='listbox']";

export interface ChatPaneProps {
  threadId: string;
  hydrateOnMount?: boolean;
  onFork?: (threadId: string, messageIndex: number) => void;
  agent?: ThreadAgent;
  /** Shows the To: line; `options` with `onChange` make it a picker until the first message. */
  recipient?: {
    options?: readonly RecipientOption[];
    value?: string;
    onChange?: (agentId: string | undefined) => void;
  };
  /** Runs before the thread's first message is sent; a rejection cancels the send. */
  beforeFirstSend?: () => Promise<void>;
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
  /** An agent's Todo work thread: read-only, with a way to the agent's own conversation. */
  workThread?: { onOpenConversation: () => void };
}

export function ChatPane({
  threadId,
  hydrateOnMount,
  onFork,
  agent,
  recipient,
  beforeFirstSend,
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
  workThread,
}: ChatPaneProps) {
  const { messages, status, errorText, errorCode, blankTurn, retryingCutOff, queued, send, steerNow, cancelQueued, stop, decide } =
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

  const sendFirstAware = useCallback<typeof send>(
    async (...args) => {
      if (messages.length === 0) await beforeFirstSend?.();
      await send(...args);
    },
    [beforeFirstSend, messages.length, send],
  );
  const recipientEditable = messages.length === 0 && recipient?.onChange !== undefined;

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
      {status === "idle" && blankTurn && <BlankTurnNotice reason={blankTurn} />}
      {status === "streaming" && retryingCutOff && <CutOffRetryNotice />}
      {workThread ? (
        <WorkThreadNotice agentName={agent?.name ?? "the agent"} onOpenConversation={workThread.onOpenConversation} />
      ) : (
        <>
      {recipient && (
        <RecipientField
          name={agent?.name ?? "Pizza Bot"}
          {...(recipientEditable && recipient.options
            ? { options: recipient.options, value: recipient.value, onChange: recipient.onChange }
            : {})}
        />
      )}
      <Composer
        threadId={threadId}
        streaming={status === "streaming"}
        interrupted={status === "interrupted"}
        onSend={sendFirstAware}
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
        {...(agent ? { recipientName: agent.name } : {})}
        {...(agent?.model ? { pinnedModel: { id: agent.model, setBy: agent.name } } : {})}
      />
        </>
      )}
    </div>
  );
}

export function WorkThreadNotice({
  agentName,
  onOpenConversation,
}: {
  agentName: string;
  onOpenConversation: () => void;
}) {
  return (
    <div className="work-thread-notice" role="note">
      <span>{workThreadNotice(agentName)}</span>
      <button type="button" className="btn-secondary" onClick={onOpenConversation}>
        {messageAgentLabel(agentName)}
      </button>
    </div>
  );
}
