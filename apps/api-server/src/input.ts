import type { RunInput, MessagePart } from "@pizza-bot/core";
import type { NormalizedMessage } from "@pizza-bot/core";
import { parseAttachmentUrl } from "@pizza-bot/core";

export function toRunInput(body: unknown): RunInput {
  const obj = (body ?? {}) as Record<string, unknown>;

  if (typeof obj.prompt === "string") {
    return { messages: [userMessage(obj.prompt)] };
  }

  const input = (obj.input ?? obj) as Record<string, unknown>;

  // ApiClient nests resume commands under input; other clients may not.
  const command = obj.command ?? input.command;
  if (command && typeof command === "object") {
    return { command: command as RunInput extends { command: infer C } ? C : never };
  }

  const rawMessages = input.messages;
  if (Array.isArray(rawMessages)) {
    return { messages: rawMessages.map(normalizeMessage) };
  }

  return { messages: [] };
}

function userMessage(text: string): NormalizedMessage {
  return { id: "u_0", role: "user", parts: [{ type: "text", text }] };
}

function normalizeMessage(raw: unknown, i: number): NormalizedMessage {
  const m = (raw ?? {}) as Record<string, unknown>;
  const id = typeof m.id === "string" ? m.id : `m_${i}`;
  const role = (m.role as NormalizedMessage["role"]) ?? "user";
  // Sanitize rich parts at the request boundary instead of accepting synthetic tool events.
  if (Array.isArray(m.parts)) {
    return { id, role, parts: m.parts.map(normalizePart).filter((p): p is MessagePart => p !== null) };
  }
  const content = typeof m.content === "string" ? m.content : "";
  return { id, role, parts: [{ type: "text", text: content }] };
}

function normalizePart(raw: unknown): MessagePart | null {
  if (!raw || typeof raw !== "object") return null;
  const p = raw as Record<string, unknown>;
  if (p.type === "text" && typeof p.text === "string") return { type: "text", text: p.text };
  if (p.type === "file" && typeof p.url === "string" && typeof p.mediaType === "string") {
    const attachmentId = parseAttachmentUrl(p.url);
    if (!attachmentId) return null;
    return {
      type: "file",
      url: p.url,
      mediaType: p.mediaType,
      ...(typeof p.name === "string" ? { name: p.name } : {}),
      attachmentId,
      ...(typeof p.sizeBytes === "number" ? { sizeBytes: p.sizeBytes } : {}),
    };
  }
  return null;
}
