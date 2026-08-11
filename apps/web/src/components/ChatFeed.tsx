import { useCallback, useEffect, useRef, useState, type PointerEventHandler } from "react";
import { ExternalLink, Forward, MessageCircle } from "lucide-react";
import {
  isForkableTurn,
  rawIndexOf,
  type UIMessageLike,
  type UIPartLike,
} from "@/projection";
import type { HitlDecision } from "@pizza-bot/core";
import type { AgentInfo, ApiClient } from "@/api-client";
import {
  Conversation,
  ConversationContent,
  ConversationEmptyState,
  ConversationScrollButton,
} from "@/components/ai-elements/conversation";
import { Message, MessageContent, MessageResponse } from "@/components/ai-elements/message";
import {
  Reasoning,
  ReasoningContent,
  ReasoningTrigger,
} from "@/components/ai-elements/reasoning";
import {
  Tool,
  ToolHeader,
  ToolContent,
  ToolInput,
  ToolOutput,
  type ToolPart,
} from "@/components/ai-elements/tool";
import {
  Confirmation,
  ConfirmationTitle,
  ConfirmationRequest,
  ConfirmationActions,
  ConfirmationAction,
} from "@/components/ai-elements/confirmation";
import { PartErrorBoundary } from "@/components/PartErrorBoundary";
import { Avatar } from "./Avatar.js";
import { approvalEditState } from "./approval-edit.js";
import { useAttachmentSrc } from "../attachment-src.js";

function subagentTypeOf(input: unknown): string | undefined {
  if (input && typeof input === "object" && "subagent_type" in input) {
    const t = (input as { subagent_type?: unknown }).subagent_type;
    if (typeof t === "string" && t.length > 0) return t;
  }
  return undefined;
}

export interface ChatFeedProps {
  messages: UIMessageLike[];
  client: ApiClient;
  assistant?: Pick<AgentInfo, "name" | "avatar">;
  onDecision?: (
    interruptId: string,
    decision: HitlDecision,
    editedArgs?: unknown,
    editedName?: string,
    message?: string,
  ) => void;
  onFork?: (messageIndex: number) => void;
  searchTarget?: { messageId: string; token: number };
  onSearchTargetHandled?: (token: number) => void;
  onSurfacePointerDown?: PointerEventHandler<HTMLDivElement>;
}

export function ChatFeed({
  messages,
  client,
  assistant,
  onDecision,
  onFork,
  searchTarget,
  onSearchTargetHandled,
  onSurfacePointerDown,
}: ChatFeedProps) {
  const assistantName = assistant?.name ?? "Pizza Bot";
  const assistantAvatar = assistant?.avatar || "🍕";
  const searchTargetsRef = useRef(new Map<string, HTMLElement>());
  const registerSearchTarget = useCallback((messageId: string, element: HTMLElement | null) => {
    if (element) searchTargetsRef.current.set(messageId, element);
    else searchTargetsRef.current.delete(messageId);
  }, []);

  useEffect(() => {
    if (!searchTarget) return;
    const element = searchTargetsRef.current.get(searchTarget.messageId);
    if (!element) return;
    let scrollFrame = 0;
    const layoutFrame = window.requestAnimationFrame(() => {
      scrollFrame = window.requestAnimationFrame(() => {
        element.scrollIntoView({ behavior: "smooth", block: "center" });
        element.classList.remove("search-target-active");
        void element.offsetWidth;
        element.classList.add("search-target-active");
        element.addEventListener(
          "animationend",
          () => element.classList.remove("search-target-active"),
          { once: true },
        );
        onSearchTargetHandled?.(searchTarget.token);
      });
    });
    return () => {
      window.cancelAnimationFrame(layoutFrame);
      window.cancelAnimationFrame(scrollFrame);
    };
  }, [messages, onSearchTargetHandled, searchTarget]);

  return (
    <Conversation
      className="h-full"
      data-hotkey-zone="chat"
      initial={searchTarget ? false : "smooth"}
      onPointerDown={onSurfacePointerDown}
      tabIndex={-1}
    >
      <ConversationContent>
        {messages.length === 0 ? (
          <ConversationEmptyState
            icon={<MessageCircle size={48} strokeWidth={1} />}
            title="Ask Pizza Bot something"
            description="Type a message below to start the conversation"
          />
        ) : (
          messages.map((m) => {
            const rawIndex = rawIndexOf(m.id);
            return (
              <Message
                from={m.role}
                key={m.id}
                ref={
                  m.sourceMessageId
                    ? (element) => registerSearchTarget(m.sourceMessageId!, element)
                    : undefined
                }
              >
                {m.role === "assistant" && (
                  <div className="message-author">
                    <Avatar label={assistantName} avatar={assistantAvatar} size={22} />
                    <span className="message-author-name">{assistantName}</span>
                  </div>
                )}
                <MessageContent>
                  {m.parts.map((part, i) => (
                    <PartErrorBoundary key={i}>
                      <PartView
                        part={part}
                        client={client}
                        onDecision={onDecision}
                        searchTargetMessageId={searchTarget?.messageId}
                        registerSearchTarget={registerSearchTarget}
                      />
                    </PartErrorBoundary>
                  ))}
                  {onFork && rawIndex !== null && isForkableTurn(m) && (
                    <button
                      type="button"
                      className="fork-btn"
                      title="Forward conversation from here"
                      aria-label="Forward conversation from here"
                      onClick={() => onFork(rawIndex)}
                    >
                      <Forward size={14} />
                    </button>
                  )}
                </MessageContent>
              </Message>
            );
          })
        )}
      </ConversationContent>
      <ConversationScrollButton />
    </Conversation>
  );
}

function PartView({
  part,
  client,
  onDecision,
  searchTargetMessageId,
  registerSearchTarget,
}: {
  part: UIPartLike;
  client: ApiClient;
  onDecision?: (
    interruptId: string,
    decision: HitlDecision,
    editedArgs?: unknown,
    editedName?: string,
    message?: string,
  ) => void;
  searchTargetMessageId?: string;
  registerSearchTarget: (messageId: string, element: HTMLElement | null) => void;
}) {
  if (part.type === "text") return <MessageResponse>{part.text}</MessageResponse>;

  if (part.type === "reasoning") {
    return (
      <Reasoning>
        <ReasoningTrigger />
        <ReasoningContent>{part.text}</ReasoningContent>
      </Reasoning>
    );
  }

  if (part.type === "source-url") {
    return (
      <a
        className="inline-flex items-center gap-1 text-primary text-sm underline"
        href={part.url}
        target="_blank"
        rel="noreferrer"
      >
        <ExternalLink size={13} /> {part.title ?? part.url}
      </a>
    );
  }

  if (part.type === "file") {
    return <AttachmentPart part={part} client={client} />;
  }

  if (part.type.startsWith("tool-")) {
    if (part.state === "approval-requested") {
      return <InterruptConfirmation part={part} onDecision={onDecision} />;
    }

    return (
      <ToolPartView
        part={part}
        targeted={
          part.resultMessageId !== undefined && part.resultMessageId === searchTargetMessageId
        }
        registerSearchTarget={registerSearchTarget}
      />
    );
  }

  return null;
}

function ToolPartView({
  part,
  targeted,
  registerSearchTarget,
}: {
  part: Extract<UIPartLike, { type: `tool-${string}` }>;
  targeted: boolean;
  registerSearchTarget: (messageId: string, element: HTMLElement | null) => void;
}) {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (targeted) setOpen(true);
  }, [targeted]);

  const toolType = part.type as Extract<ToolPart, { type: `tool-${string}` }>["type"];
  const delegate = toolType === "tool-task" ? subagentTypeOf(part.input) : undefined;
  return (
    <div
      className="w-full"
      ref={
        part.resultMessageId
          ? (element) => registerSearchTarget(part.resultMessageId!, element)
          : undefined
      }
    >
      <Tool open={open} onOpenChange={setOpen}>
        <ToolHeader
          type={toolType}
          state={part.state}
          {...(delegate
            ? { title: `Delegate to ${delegate}`, avatar: <Avatar label={delegate} size={18} /> }
            : {})}
        />
        <ToolContent>
          <ToolInput input={part.input ?? {}} />
          <ToolOutput output={part.output} errorText={part.errorText} />
        </ToolContent>
      </Tool>
    </div>
  );
}

function AttachmentPart({
  part,
  client,
}: {
  part: Extract<UIPartLike, { type: "file" }>;
  client: ApiClient;
}) {
  const src = useAttachmentSrc(part.url, client);
  const label = part.filename ?? "attachment";
  if (!src) return <span className="feed-attachment feed-attachment-file">{label}</span>;
  if (part.mediaType.startsWith("image/")) {
    return (
      <a href={src} target="_blank" rel="noreferrer" className="feed-attachment feed-attachment-image">
        <img src={src} alt={label} />
      </a>
    );
  }
  return (
    <a
      href={src}
      download={label}
      target="_blank"
      rel="noreferrer"
      className="feed-attachment feed-attachment-file"
    >
      {label}
    </a>
  );
}

function InterruptConfirmation({
  part,
  onDecision,
}: {
  part: Extract<UIPartLike, { type: `tool-${string}` }>;
  onDecision?: (
    interruptId: string,
    decision: HitlDecision,
    editedArgs?: unknown,
    editedName?: string,
    message?: string,
  ) => void;
}) {
  const toolName = part.type.slice("tool-".length);
  const [editing, setEditing] = useState(false);
  const [responding, setResponding] = useState(false);
  const [originalDraft] = useState(() => JSON.stringify(part.input, null, 2));
  const [draft, setDraft] = useState(originalDraft);
  const [responseDraft, setResponseDraft] = useState("");
  const [error, setError] = useState<string | null>(null);

  const batch = part.batch;
  const isBatch = Array.isArray(batch) && batch.length > 1;
  const allowed = part.allowedDecisions ?? ["approve", "edit", "reject"];
  const canRespond = !isBatch && allowed.includes("respond");
  const canEdit = !isBatch && allowed.includes("edit");
  const editState = approvalEditState(originalDraft, draft);

  const submitEdit = () => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(draft);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Invalid JSON");
      return;
    }
    setError(null);
    onDecision?.(part.toolCallId, "edit", parsed, toolName);
  };

  const revertEdit = () => {
    setDraft(originalDraft);
    setError(null);
  };

  const submitRespond = () => {
    if (!responseDraft.trim()) return;
    onDecision?.(part.toolCallId, "respond", undefined, undefined, responseDraft.trim());
  };

  return (
    <Confirmation approval={{ id: part.toolCallId }} state="approval-requested">
      <ConfirmationTitle>
        {isBatch ? (
          <>
            Approve <b>{batch!.length}</b> <b>{toolName}</b> calls?
          </>
        ) : (
          <>
            Approve <b>{toolName}</b>? <code className="text-xs">{JSON.stringify(part.input)}</code>
          </>
        )}
      </ConfirmationTitle>
      <ConfirmationRequest>
        {isBatch && (
          <ul className="mb-2 flex flex-col gap-1">
            {batch!.map((call, i) => (
              <li key={i} className="text-xs">
                <b>{call.toolName}</b> <code>{JSON.stringify(call.args)}</code>
              </li>
            ))}
          </ul>
        )}
        {editing && (
          <div className="mb-2 flex flex-col gap-1">
            <textarea
              className="w-full rounded-md border border-border bg-background p-2 font-mono text-xs text-foreground"
              rows={Math.min(12, draft.split("\n").length + 1)}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              spellCheck={false}
            />
            {error && <span className="text-destructive text-xs">⚠ {error}</span>}
          </div>
        )}
        {responding && (
          <div className="mb-2 flex flex-col gap-1">
            <textarea
              className="w-full rounded-md border border-border bg-background p-2 text-sm text-foreground"
              rows={3}
              value={responseDraft}
              onChange={(e) => setResponseDraft(e.target.value)}
              placeholder="Your response (used as the tool result instead of running the tool)..."
              spellCheck={false}
            />
          </div>
        )}
        <ConfirmationActions>
          {editing && editState.changed && (
            <ConfirmationAction variant="outline" onClick={revertEdit}>
              Revert changes
            </ConfirmationAction>
          )}
          <ConfirmationAction
            variant="outline"
            onClick={() => onDecision?.(part.toolCallId, "reject")}
          >
            Reject
          </ConfirmationAction>
          {canRespond && !editing && (
            responding ? (
              <ConfirmationAction onClick={submitRespond}>Send response</ConfirmationAction>
            ) : (
              <ConfirmationAction variant="outline" onClick={() => { setResponding(true); setEditing(false); }}>
                Respond
              </ConfirmationAction>
            )
          )}
          {canEdit && !responding && (
            editing ? (
              editState.changed && (
                <ConfirmationAction onClick={submitEdit}>
                  {editState.approveLabel}
                </ConfirmationAction>
              )
            ) : (
              <ConfirmationAction variant="outline" onClick={() => { setEditing(true); setResponding(false); }}>
                Edit
              </ConfirmationAction>
            )
          )}
          {!responding && (!editing || !editState.changed) && (
            <ConfirmationAction onClick={() => onDecision?.(part.toolCallId, "approve")}>
              Approve
            </ConfirmationAction>
          )}
        </ConfirmationActions>
      </ConfirmationRequest>
    </Confirmation>
  );
}
