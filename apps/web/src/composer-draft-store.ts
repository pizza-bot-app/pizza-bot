import type { AttachmentMeta } from "@pizza-bot/core";

export interface ComposerDraft {
  text: string;
  model: string;
  attachments: AttachmentMeta[];
  uploading: number;
}

const EMPTY_DRAFT: ComposerDraft = {
  text: "",
  model: "",
  attachments: [],
  uploading: 0,
};

type ComposerDraftContent = Omit<ComposerDraft, "uploading">;

export class ComposerDraftStore {
  private readonly drafts = new Map<string, ComposerDraft>();
  private readonly discarded = new Set<string>();
  private readonly listeners = new Map<string, Set<() => void>>();

  get(threadId: string): ComposerDraft {
    const draft = this.drafts.get(threadId) ?? EMPTY_DRAFT;
    return { ...draft, attachments: [...draft.attachments] };
  }

  set(threadId: string, draft: ComposerDraftContent): void {
    if (this.discarded.has(threadId)) return;
    const uploading = this.drafts.get(threadId)?.uploading ?? 0;
    if (!draft.text && !draft.model && draft.attachments.length === 0 && uploading === 0) {
      this.drafts.delete(threadId);
      this.notify(threadId);
      return;
    }
    this.drafts.set(threadId, {
      ...draft,
      attachments: [...draft.attachments],
      uploading,
    });
    this.notify(threadId);
  }

  addAttachment(threadId: string, attachment: AttachmentMeta): boolean {
    if (this.discarded.has(threadId)) return false;
    const draft = this.get(threadId);
    if (draft.attachments.some((item) => item.id === attachment.id)) return true;
    draft.attachments.push(attachment);
    this.set(threadId, draft);
    return true;
  }

  removeAttachment(threadId: string, attachmentId: string): void {
    const draft = this.get(threadId);
    draft.attachments = draft.attachments.filter((item) => item.id !== attachmentId);
    this.set(threadId, draft);
  }

  clear(threadId: string): void {
    this.drafts.delete(threadId);
    this.notify(threadId);
  }

  discard(threadId: string): void {
    this.drafts.delete(threadId);
    this.discarded.add(threadId);
    this.notify(threadId);
  }

  beginUploads(threadId: string, count: number): boolean {
    if (this.discarded.has(threadId) || count <= 0) return false;
    const draft = this.get(threadId);
    this.drafts.set(threadId, { ...draft, uploading: draft.uploading + count });
    this.notify(threadId);
    return true;
  }

  finishUpload(threadId: string): void {
    if (this.discarded.has(threadId)) return;
    const draft = this.get(threadId);
    const uploading = Math.max(0, draft.uploading - 1);
    if (!draft.text && !draft.model && draft.attachments.length === 0 && uploading === 0) {
      this.drafts.delete(threadId);
    } else {
      this.drafts.set(threadId, { ...draft, uploading });
    }
    this.notify(threadId);
  }

  subscribe(threadId: string, listener: () => void): () => void {
    const listeners = this.listeners.get(threadId) ?? new Set<() => void>();
    listeners.add(listener);
    this.listeners.set(threadId, listeners);
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) this.listeners.delete(threadId);
    };
  }

  private notify(threadId: string): void {
    for (const listener of this.listeners.get(threadId) ?? []) listener();
  }
}

export const composerDraftStore = new ComposerDraftStore();
