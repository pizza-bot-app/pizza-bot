export const DEFAULT_BODY_CHARS = 6000;

export function header(headers, name) {
  const lower = name.toLowerCase();
  return headers?.find((h) => h.name?.toLowerCase() === lower)?.value ?? undefined;
}

function decode(data) {
  return Buffer.from(data, "base64url").toString("utf8");
}

function stripHtml(html) {
  return html
    .replace(/<(style|script)[\s\S]*?<\/\1>/gi, "")
    .replace(/<br\s*\/?>|<\/(p|div|tr|li|h\d)>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&");
}

function findPart(payload, mimeType) {
  if (payload?.mimeType === mimeType && payload.body?.data) return payload.body.data;
  for (const part of payload?.parts ?? []) {
    const found = findPart(part, mimeType);
    if (found) return found;
  }
  return undefined;
}

export function extractBody(payload) {
  const plain = findPart(payload, "text/plain");
  if (plain) return decode(plain).trim();
  const html = findPart(payload, "text/html");
  if (html) return stripHtml(decode(html)).replace(/\n{3,}/g, "\n\n").trim();
  return "";
}

export function truncate(text, max) {
  return text.length > max ? `${text.slice(0, max)}\n[truncated ${text.length - max} chars]` : text;
}

export function summarizeMessage(message, { maxBodyChars = DEFAULT_BODY_CHARS } = {}) {
  const headers = message.payload?.headers;
  return {
    id: message.id,
    from: header(headers, "From"),
    to: header(headers, "To"),
    cc: header(headers, "Cc"),
    subject: header(headers, "Subject"),
    date: header(headers, "Date"),
    labels: message.labelIds,
    attachments: collectAttachments(message.payload),
    body: truncate(extractBody(message.payload), maxBodyChars),
  };
}

function collectAttachments(payload, out = []) {
  if (payload?.filename && payload.body?.attachmentId) {
    out.push({ filename: payload.filename, mimeType: payload.mimeType, size: payload.body.size });
  }
  for (const part of payload?.parts ?? []) collectAttachments(part, out);
  return out;
}

export function summarizeThreadHead(thread) {
  const messages = thread.messages ?? [];
  const first = messages[0];
  const last = messages.at(-1);
  return {
    id: thread.id,
    subject: header(first?.payload?.headers, "Subject"),
    from: header(first?.payload?.headers, "From"),
    lastDate: header(last?.payload?.headers, "Date"),
    messageCount: messages.length,
    snippet: last?.snippet ?? thread.snippet,
  };
}

export function summarizeEvent(event) {
  return {
    id: event.id,
    summary: event.summary,
    start: event.start?.dateTime ?? event.start?.date,
    end: event.end?.dateTime ?? event.end?.date,
    allDay: Boolean(event.start?.date),
    location: event.location,
    description: event.description ? truncate(event.description, 2000) : undefined,
    attendees: event.attendees?.map((a) => ({ email: a.email, status: a.responseStatus })),
    organizer: event.organizer?.email,
    status: event.status,
    meetLink: event.hangoutLink,
    link: event.htmlLink,
  };
}

/** Gaps of at least `minMs` inside [timeMin, timeMax] not covered by any busy interval. */
export function freeSlots(busy, timeMin, timeMax, minMs) {
  const start = Date.parse(timeMin);
  const end = Date.parse(timeMax);
  const sorted = busy
    .map((b) => ({ start: Date.parse(b.start), end: Date.parse(b.end) }))
    .sort((a, b) => a.start - b.start);
  const slots = [];
  let cursor = start;
  for (const interval of sorted) {
    if (interval.start - cursor >= minMs) {
      slots.push({ start: new Date(cursor).toISOString(), end: new Date(interval.start).toISOString() });
    }
    cursor = Math.max(cursor, interval.end);
  }
  if (end - cursor >= minMs) {
    slots.push({ start: new Date(cursor).toISOString(), end: new Date(end).toISOString() });
  }
  return slots;
}

function encodeWord(value) {
  return /^[\x20-\x7e]*$/.test(value) ? value : `=?UTF-8?B?${Buffer.from(value, "utf8").toString("base64")}?=`;
}

function assertSingleLine(name, value) {
  if (/[\r\n]/.test(value)) throw new Error(`${name} must not contain line breaks.`);
}

export function buildRawMessage({ to, cc, bcc, subject, body, inReplyTo, references }) {
  for (const [name, value] of Object.entries({ to, cc, bcc, subject, inReplyTo, references })) {
    if (value) assertSingleLine(name, value);
  }
  const lines = [
    `To: ${to}`,
    cc ? `Cc: ${cc}` : undefined,
    bcc ? `Bcc: ${bcc}` : undefined,
    `Subject: ${encodeWord(subject)}`,
    inReplyTo ? `In-Reply-To: ${inReplyTo}` : undefined,
    references ? `References: ${references}` : undefined,
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=UTF-8",
    "Content-Transfer-Encoding: base64",
    "",
    Buffer.from(body, "utf8").toString("base64").replace(/(.{76})/g, "$1\r\n"),
  ].filter((line) => line !== undefined);
  return Buffer.from(lines.join("\r\n"), "utf8").toString("base64url");
}
