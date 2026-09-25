import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ClipboardEvent,
  type DragEvent,
  type FormEvent,
  type KeyboardEvent,
} from "react";
import { Plus, SendHorizontal, Square, X, FileText, Loader2 } from "lucide-react";
import type { ModelsInfo, ApiClient } from "@/api-client";
import type { AttachmentMeta } from "@pizza-bot/core";
import { ATTACHMENT_ACCEPT, isImageAttachmentType, resolveAttachmentMediaType } from "@pizza-bot/core";
import type { PromptHistoryCycler } from "../use-prompt-history.js";
import { reconcileSelectedModel } from "../model-options.js";
import { ModelCombobox } from "./ModelCombobox.js";
import { useAttachmentSrc } from "../attachment-src.js";
import { composerDraftStore } from "../composer-draft-store.js";

export function Composer({
  threadId,
  streaming,
  interrupted,
  onSend,
  onSteerNow,
  onStop,
  queued,
  onCancelQueued,
  models,
  initialModel,
  onModelChange,
  client,
  prefill,
  prefillToken,
  composerRef,
  history,
}: {
  threadId: string;
  streaming?: boolean;
  interrupted?: boolean;
  onSend: (text: string, model?: string, attachments?: AttachmentMeta[]) => Promise<void>;
  onSteerNow?: (text: string, model?: string, attachments?: AttachmentMeta[]) => Promise<void>;
  onStop?: () => void;
  queued?: string[];
  onCancelQueued?: (index: number) => void;
  models: ModelsInfo;
  initialModel?: string;
  onModelChange?: (modelId: string) => void;
  client: ApiClient;
  prefill?: string;
  prefillToken?: number;
  composerRef?: React.RefObject<HTMLTextAreaElement | null>;
  history?: PromptHistoryCycler;
}) {
  const initialDraft = useRef(composerDraftStore.get(threadId)).current;
  const [text, setText] = useState(initialDraft.text);
  const [model, setModel] = useState<string>(initialDraft.model || initialModel || "");
  const localRef = useRef<HTMLTextAreaElement>(null);
  const textareaRef = composerRef ?? localRef;
  const fileInputRef = useRef<HTMLInputElement>(null);
  const composing = useRef(false);
  const draftRevision = useRef(0);

  const [attachments, setAttachments] = useState<AttachmentMeta[]>(initialDraft.attachments);
  const [uploading, setUploading] = useState(initialDraft.uploading);
  const [dragOver, setDragOver] = useState(false);
  const [attachError, setAttachError] = useState<string | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    composerDraftStore.set(threadId, { text, model, attachments });
  }, [attachments, model, text, threadId]);

  useEffect(() => {
    if (model) onModelChange?.(model);
  }, [model, onModelChange]);

  useEffect(
    () =>
      composerDraftStore.subscribe(threadId, () => {
        const draft = composerDraftStore.get(threadId);
        setUploading(draft.uploading);
        setAttachments((current) =>
          sameAttachments(current, draft.attachments) ? current : draft.attachments,
        );
      }),
    [threadId],
  );

  const addFiles = useCallback(
    async (files: File[]) => {
      const accepted = files.filter((f) => resolveAttachmentMediaType(f.type, f.name) !== undefined);
      const rejected = files.length - accepted.length;
      if (rejected > 0) setAttachError(`${rejected} file(s) skipped — unsupported type`);
      if (accepted.length === 0) return;
      if (!composerDraftStore.beginUploads(threadId, accepted.length)) return;
      draftRevision.current += 1;
      await Promise.all(
        accepted.map(async (file) => {
          try {
            const meta = await client.uploadAttachment(file, threadId);
            if (!composerDraftStore.addAttachment(threadId, meta)) {
              // Thread deletion may race an eager upload finishing.
              await client.deleteAttachment(meta.id);
            }
            // The draft-store subscription updates mounted panes; unmounted
            // panes read the same attachment when they remount.
          } catch (err) {
            if (mounted.current) {
              setAttachError(err instanceof Error ? err.message : "upload failed");
            }
          } finally {
            composerDraftStore.finishUpload(threadId);
          }
        }),
      );
    },
    [client, threadId],
  );

  const removeAttachment = (id: string) => {
    // Uploads are eager, so removing an unsent chip must delete its server copy.
    draftRevision.current += 1;
    setAttachments((prev) => prev.filter((a) => a.id !== id));
    composerDraftStore.removeAttachment(threadId, id);
    void client.deleteAttachment(id).catch((err) => {
      setAttachError(err instanceof Error ? err.message : "attachment delete failed");
    });
  };

  // Do not submit while uploads are unresolved; the turn would omit their IDs.
  const sendDisabled =
    uploading > 0 || (!text.trim() && attachments.length === 0);

  useEffect(() => {
    setModel((selected) => reconcileSelectedModel(selected || initialModel || "", models));
  }, [initialModel, models]);

  useEffect(() => {
    if (prefillToken === undefined || prefill === undefined) return;
    draftRevision.current += 1;
    setText(prefill);
    const el = textareaRef.current;
    if (el) {
      el.focus();
      const len = prefill.length;
      requestAnimationFrame(() => el.setSelectionRange(len, len));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prefillToken]);

  async function submit(e?: FormEvent, interrupt = false) {
    e?.preventDefault();
    if (sendDisabled) return;
    const submittedText = text;
    const submittedAttachments = attachments;
    const submittedRevision = draftRevision.current;
    const files = attachments.length > 0 ? attachments : undefined;
    setSubmitError(null);
    setText("");
    setAttachments([]);
    composerDraftStore.clear(threadId);
    setAttachError(null);
    try {
      if (interrupt && onSteerNow) {
        await onSteerNow(submittedText, model || undefined, files);
      } else {
        await onSend(submittedText, model || undefined, files);
      }
      if (submittedText.trim()) history?.addEntry(submittedText);
    } catch (err) {
      if (draftRevision.current === submittedRevision) {
        setText((current) => (current === "" ? submittedText : current));
        setAttachments((current) =>
          current.length === 0 ? submittedAttachments : current,
        );
      }
      setSubmitError(err instanceof Error ? err.message : "message send failed");
    }
  }

  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (history && (e.key === "ArrowUp" || e.key === "ArrowDown")) {
      const empty = text.trim() === "";
      if (e.key === "ArrowUp" && (empty || history.isCycling)) {
        const recalled = history.cycleBack();
        if (recalled !== null) {
          e.preventDefault();
          draftRevision.current += 1;
          setText(recalled);
        }
        return;
      }
      if (e.key === "ArrowDown" && history.isCycling) {
        const recalled = history.cycleForward();
        if (recalled !== null) {
          e.preventDefault();
          draftRevision.current += 1;
          setText(recalled);
        }
        return;
      }
    }

    if (e.key === "Enter" && !e.shiftKey) {
      // Enter must not submit during IME composition.
      if (composing.current || e.nativeEvent.isComposing) return;
      e.preventDefault();
      if (sendDisabled) return;
      submit(undefined, (e.metaKey || e.ctrlKey) && !!streaming);
    }
  }

  function onPaste(e: ClipboardEvent<HTMLTextAreaElement>) {
    const files = Array.from(e.clipboardData?.files ?? []);
    if (files.length > 0) {
      e.preventDefault();
      void addFiles(files);
    }
  }

  function onDragOver(e: DragEvent<HTMLFormElement>) {
    if (e.dataTransfer?.types?.includes("Files")) {
      e.preventDefault();
      setDragOver(true);
    }
  }
  function onDragLeave(e: DragEvent<HTMLFormElement>) {
    // Moving between children is not leaving the drop target.
    if (!e.currentTarget.contains(e.relatedTarget as Node)) setDragOver(false);
  }
  function onDrop(e: DragEvent<HTMLFormElement>) {
    const files = Array.from(e.dataTransfer?.files ?? []);
    if (files.length > 0) {
      e.preventDefault();
      void addFiles(files);
    }
    setDragOver(false);
  }

  const clearHistoryCursor = useCallback(() => history?.stopCycling(), [history]);

  return (
    <div className="composer-wrap" data-hotkey-zone="chat">
      {queued && queued.length > 0 && (
        <ul className="composer-queued" aria-label="Queued messages">
          {queued.map((q, i) => (
            <li key={i} className="composer-queued-chip" title={q}>
              <span className="composer-queued-text">{q}</span>
              {onCancelQueued && (
                <button
                  type="button"
                  className="composer-queued-remove"
                  aria-label="Remove queued message"
                  title="Remove queued message"
                  onClick={() => onCancelQueued(i)}
                >
                  <X size={12} />
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      <form
        className={`composer${dragOver ? " drag-over" : ""}`}
        onSubmit={submit}
        onDragOver={onDragOver}
        onDragLeave={onDragLeave}
        onDrop={onDrop}
      >
        {(attachments.length > 0 || uploading > 0 || attachError || submitError) && (
          <div className="composer-attachments" aria-label="Attachments">
            {attachments.map((a) => (
              <AttachmentChip
                key={a.id}
                attachment={a}
                client={client}
                onRemove={() => removeAttachment(a.id)}
              />
            ))}
            {Array.from({ length: uploading }).map((_, i) => (
              <span key={`up_${i}`} className="attachment-chip attachment-uploading" title="Uploading…">
                <Loader2 size={14} className="spin" />
                <span className="attachment-name">Uploading…</span>
              </span>
            ))}
            {attachError && (
              <span className="attachment-error" role="alert">
                {attachError}
              </span>
            )}
            {submitError && (
              <span className="attachment-error" role="alert">
                {submitError}
              </span>
            )}
          </div>
        )}
        <textarea
          ref={textareaRef}
          value={text}
          onChange={(e) => {
            draftRevision.current += 1;
            setText(e.target.value);
            clearHistoryCursor();
          }}
          onKeyDown={onKeyDown}
          onPaste={onPaste}
          onCompositionStart={() => (composing.current = true)}
          onCompositionEnd={() => (composing.current = false)}
          placeholder={
            interrupted
              ? "Queue until approval is resolved…"
              : streaming
              ? "Steer… Enter to queue, ⌘/Ctrl+Enter to send now"
              : "Message Pizza Bot…"
          }
          rows={1}
        />
        <div className="composer-footer">
          <div className="composer-tools">
            <button
              type="button"
              className="composer-attach"
              title="Attach files"
              aria-label="Attach files"
              onClick={() => fileInputRef.current?.click()}
            >
              <Plus size={18} />
            </button>
            <input
              ref={fileInputRef}
              type="file"
              multiple
              accept={ATTACHMENT_ACCEPT}
              style={{ display: "none" }}
              onChange={(e) => {
                const files = Array.from(e.target.files ?? []);
                if (files.length > 0) void addFiles(files);
                // Browsers suppress change when the same file remains selected.
                e.target.value = "";
              }}
            />

            <ModelCombobox
              models={models.models}
              value={model}
              onChange={setModel}
              formatModelLabel={(option) => shortModelName(option.displayName)}
            />

          </div>

          <div className="composer-actions">
            {streaming && onStop && (
              <button
                type="button"
                className="composer-send composer-stop"
                onClick={onStop}
                aria-label="Stop generating"
                title="Stop generating"
              >
                <Square size={16} />
              </button>
            )}
            <button
              type="submit"
              className="composer-send"
              disabled={sendDisabled}
              aria-label={streaming || interrupted ? "Queue message" : "Send message"}
              title={
                interrupted
                  ? "Queue until approval is resolved"
                  : streaming
                    ? "Queue for next turn (⌘/Ctrl+Enter to send now)"
                    : "Send"
              }
            >
              <SendHorizontal size={18} />
            </button>
          </div>
        </div>
      </form>
    </div>
  );
}

function shortModelName(displayName: string): string {
  const paren = displayName.indexOf(" (");
  return paren === -1 ? displayName : displayName.slice(0, paren);
}

function sameAttachments(left: AttachmentMeta[], right: AttachmentMeta[]): boolean {
  return left.length === right.length && left.every((item, index) => item.id === right[index]?.id);
}

function AttachmentChip({
  attachment,
  client,
  onRemove,
}: {
  attachment: AttachmentMeta;
  client: ApiClient;
  onRemove: () => void;
}) {
  const isImage = isImageAttachmentType(attachment.mediaType);
  const src = useAttachmentSrc(`attachment://${attachment.id}`, client);
  return (
    <span className="attachment-chip" title={attachment.filename}>
      {isImage && src ? (
        <img className="attachment-thumb" src={src} alt={attachment.filename} />
      ) : (
        <FileText size={14} className="attachment-icon" />
      )}
      <span className="attachment-name">{attachment.filename}</span>
      <button
        type="button"
        className="attachment-remove"
        aria-label={`Remove ${attachment.filename}`}
        title="Remove"
        onClick={onRemove}
      >
        <X size={12} />
      </button>
    </span>
  );
}
