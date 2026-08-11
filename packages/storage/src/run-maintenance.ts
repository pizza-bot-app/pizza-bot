/** Best-effort indexing, titles, and presentation updates after a run completes. */
import type { ThreadStore } from "./threads.js";
import type { SearchStore, IndexableMessage } from "./search.js";
import { messageText, messageRole } from "./search.js";
import {
  isDefaultTitle,
  cleanTitle,
  TITLE_SYSTEM_PROMPT,
  buildTitleUserMessage,
} from "./title.js";

const PREVIEW_MAX = 140;

export interface RunMaintenanceDeps {
  readonly threadStore: ThreadStore;
  readonly search: SearchStore;
  getMessages(threadId: string): Promise<IndexableMessage[]>;
  generateTitle(userMessage: string, assistantMessage: string): Promise<string | undefined>;
  log?: (msg: string) => void;
}

/** Tool, system, and textless messages do not produce sidebar previews. */
export function previewOf(
  messages: IndexableMessage[],
): { lastMessage?: string; lastMessageRole?: string } {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    const role = messageRole(m);
    if (role === "tool" || role === "system") continue;
    const text = messageText(m).trim().replace(/\s+/g, " ");
    if (!text) continue;
    return {
      lastMessage: text.length > PREVIEW_MAX ? `${text.slice(0, PREVIEW_MAX)}…` : text,
      lastMessageRole: role,
    };
  }
  return {};
}

export function firstTextByRole(messages: IndexableMessage[], role: string): string {
  for (const m of messages) {
    if (messageRole(m) !== role) continue;
    const text = messageText(m).trim();
    if (text) return text;
  }
  return "";
}

export class RunMaintenance {
  constructor(private readonly deps: RunMaintenanceDeps) {}

  /** Reindexing must create the thread row before title generation reads it. */
  async onRunEnd(threadId: string): Promise<void> {
    await this.reindexThread(threadId);
    await this.maybeGenerateTitle(threadId);
  }

  async reindexThread(threadId: string): Promise<void> {
    try {
      // Run activity remains authoritative even if checkpoint reads or indexing fail.
      this.deps.threadStore.ensure({ threadId });
      this.deps.threadStore.touch(threadId);
      const messages = await this.deps.getMessages(threadId);
      this.deps.search.reindexThread(threadId, messages);
      this.deps.threadStore.update(threadId, previewOf(messages));
    } catch {
      // Search indexing is best-effort.
    }
  }

  /**
   * Generate only from a completed opening exchange, and never replace a
   * non-default title.
   */
  async maybeGenerateTitle(threadId: string): Promise<void> {
    try {
      const thread = this.deps.threadStore.get(threadId);
      if (!thread || !isDefaultTitle(thread.title)) return;

      const messages = await this.deps.getMessages(threadId);
      const userMessage = firstTextByRole(messages, "human");
      const assistantMessage = firstTextByRole(messages, "ai");
      if (!userMessage || !assistantMessage) return;

      const raw = await this.deps.generateTitle(userMessage, assistantMessage);
      const title = cleanTitle(raw);
      if (!title) return;

      // Recheck after the model call to avoid overwriting a concurrent rename.
      const fresh = this.deps.threadStore.get(threadId);
      if (!fresh || !isDefaultTitle(fresh.title)) return;
      this.deps.threadStore.update(threadId, { title });
      this.deps.log?.(`✨ Generated title for thread ${threadId}: "${title}"`);
    } catch {
      // Title generation is best-effort.
    }
  }
}

export { TITLE_SYSTEM_PROMPT, buildTitleUserMessage };
