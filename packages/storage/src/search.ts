/** Full-text search over live or serialized LangChain message shapes. */
import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";

export interface IndexableMessage {
  id?: string | string[];
  content?: string | Array<{ type?: string; text?: string; [k: string]: unknown }>;
  getType?: () => string;
  kwargs?: {
    content?: unknown;
    id?: unknown;
    tool_call_id?: string;
    name?: string;
  };
}

export interface SearchHit {
  threadId: string;
  messageId: string;
  role: string;
  snippet: string;
  highlights: SearchHighlight[];
  rank: number;
}

export interface SearchHighlight {
  text: string;
  highlighted: boolean;
}

interface SearchRow {
  threadId: string;
  messageId: string;
  role: string;
  markedSnippet: string;
  rank: number;
}

export function messageText(m: IndexableMessage): string {
  const content = m.content ?? (m.kwargs?.content as IndexableMessage["content"]);
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((c) =>
      typeof c === "object" && c !== null && "text" in c
        ? String((c as { text?: string }).text ?? "")
        : "",
    )
    .join("");
}

export function messageRole(m: IndexableMessage): string {
  if (typeof m.getType === "function") return m.getType();
  if (Array.isArray(m.id)) {
    const cls = m.id[m.id.length - 1] ?? "";
    if (cls === "HumanMessage") return "human";
    if (cls === "AIMessage" || cls === "AIMessageChunk") return "ai";
    if (cls === "ToolMessage") return "tool";
    if (cls === "SystemMessage") return "system";
  }
  return "unknown";
}

function messageId(m: IndexableMessage, fallback: string): string {
  if (typeof m.id === "string") return m.id;
  if (typeof m.kwargs?.id === "string") return m.kwargs.id;
  return fallback;
}

export class SearchStore {
  private readonly db: Database.Database;

  constructor(db: Database.Database) {
    this.db = db;
    // IDs are stored for retrieval but excluded from the searchable index.
    this.db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
        thread_id UNINDEXED,
        message_id UNINDEXED,
        role,
        text,
        tokenize = 'porter'
      );
    `);
  }

  /** The shared database handle is owned by `openAppDatabase`. */
  close(): void {}

  /** Textless messages, including tool-call-only turns, are not indexed. */
  reindexThread(threadId: string, messages: IndexableMessage[]): void {
    // Replace the thread index atomically so readers never see a partial rebuild.
    const tx = this.db.transaction(() => {
      this.db.prepare("DELETE FROM messages_fts WHERE thread_id = ?").run(threadId);
      const insert = this.db.prepare(
        "INSERT INTO messages_fts (thread_id, message_id, role, text) VALUES (?, ?, ?, ?)",
      );
      messages.forEach((m, i) => {
        const text = messageText(m);
        if (text.trim().length === 0) return;
        insert.run(threadId, messageId(m, `${threadId}:${i}`), messageRole(m), text);
      });
    });
    tx();
  }

  deleteThread(threadId: string): void {
    this.db.prepare("DELETE FROM messages_fts WHERE thread_id = ?").run(threadId);
  }

  search(query: string, limit = 50): SearchHit[] {
    const q = query.trim();
    if (q.length === 0) return [];
    const marker = randomUUID();
    const highlightStart = `\u0001${marker}:start\u0001`;
    const highlightEnd = `\u0002${marker}:end\u0002`;
    const rows = this.db
      .prepare<[string, string, string, number], SearchRow>(
        `SELECT thread_id  AS threadId,
                message_id AS messageId,
                role       AS role,
                snippet(messages_fts, 3, ?, ?, '…', 12) AS markedSnippet,
                rank       AS rank
         FROM messages_fts
         WHERE messages_fts MATCH ?
         ORDER BY rank
         LIMIT ?`,
      )
      .all(highlightStart, highlightEnd, sanitizeQuery(q), limit);
    return rows.map(({ markedSnippet, ...row }) => {
      const highlights = parseHighlights(markedSnippet, highlightStart, highlightEnd);
      return {
        ...row,
        snippet: highlights.map((part) => part.text).join(""),
        highlights,
      };
    });
  }
}

function parseHighlights(
  value: string,
  highlightStart: string,
  highlightEnd: string,
): SearchHighlight[] {
  const parts: SearchHighlight[] = [];
  let highlighted = false;
  let offset = 0;
  while (offset < value.length) {
    const marker = highlighted ? highlightEnd : highlightStart;
    const markerAt = value.indexOf(marker, offset);
    if (markerAt === -1) break;
    if (markerAt > offset) {
      parts.push({ text: value.slice(offset, markerAt), highlighted });
    }
    highlighted = !highlighted;
    offset = markerAt + marker.length;
  }
  if (offset < value.length) parts.push({ text: value.slice(offset), highlighted });
  return parts;
}

/** Quote user input so FTS5 punctuation cannot create malformed MATCH syntax. */
function sanitizeQuery(q: string): string {
  const terms = q.match(/[\p{L}\p{N}]+/gu);
  if (!terms || terms.length === 0) return `"${q.replace(/"/g, '""')}"`;
  return terms.map((t) => `"${t}"*`).join(" OR ");
}
