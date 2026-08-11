/** Pure helpers for generating a title from a thread's opening exchange. */

export const DEFAULT_TITLE = "New conversation";

const TITLE_MAX = 60;

const MESSAGE_SNIPPET_MAX = 500;

export function isDefaultTitle(title: string | undefined | null): boolean {
  const t = (title ?? "").trim();
  return t === "" || t === DEFAULT_TITLE;
}

export function cleanTitle(raw: string | undefined | null): string | undefined {
  let t = (raw ?? "").trim().replace(/\s+/g, " ");
  t = t.replace(/^title:\s*/i, "");
  const quotes = /^["'“”‘’](.*)["'“”‘’]$/;
  const m = quotes.exec(t);
  if (m) t = m[1]!.trim();
  t = t.replace(/[.!?,;:]+$/, "").trim();
  if (!t) return undefined;
  return t.length > TITLE_MAX ? `${t.slice(0, TITLE_MAX).trimEnd()}…` : t;
}

export const TITLE_SYSTEM_PROMPT = `Generate a short title (2-6 words) that captures the TOPIC of the conversation, not what actions were performed.
Think about what the user wanted help with and name it like a folder label.

Rules:
- Output ONLY the title, nothing else
- No quotes, no punctuation at the end
- Use natural, casual language — like how a human would name a chat
- Focus on the subject/topic, NOT the action taken
- Never use words like "retrieved", "generated", "provided", "assisted", "discussed"
- Never mention the AI or assistant

Examples of good titles: "Weekly sales report", "Python regex help", "Logo design feedback", "Vacation budget planning"
Examples of bad titles: "Sales Data Retrieved Successfully", "Assisted With Python Code", "Logo Options Provided"`;

export function buildTitleUserMessage(userMessage: string, assistantMessage: string): string {
  return `User message: ${userMessage.slice(0, MESSAGE_SNIPPET_MAX)}\n\nAssistant response: ${assistantMessage.slice(0, MESSAGE_SNIPPET_MAX)}`;
}
