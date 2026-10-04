import assert from "node:assert/strict";
import { test } from "node:test";
import { buildRawMessage, extractBody, freeSlots, summarizeEvent, truncate } from "./format.mjs";

const b64 = (s) => Buffer.from(s, "utf8").toString("base64url");

test("extractBody prefers text/plain in nested multipart", () => {
  const payload = {
    mimeType: "multipart/mixed",
    parts: [
      {
        mimeType: "multipart/alternative",
        parts: [
          { mimeType: "text/html", body: { data: b64("<p>html</p>") } },
          { mimeType: "text/plain", body: { data: b64("plain") } },
        ],
      },
    ],
  };
  assert.equal(extractBody(payload), "plain");
});

test("extractBody strips html when no plain part exists", () => {
  const payload = {
    mimeType: "text/html",
    body: { data: b64("<style>p{}</style><p>Hi&nbsp;&amp; bye</p><br>next") },
  };
  assert.equal(extractBody(payload), "Hi & bye\n\nnext");
});

test("truncate reports dropped characters", () => {
  assert.equal(truncate("abcdef", 4), "abcd\n[truncated 2 chars]");
  assert.equal(truncate("abc", 4), "abc");
});

test("freeSlots returns gaps of at least the minimum, merging overlapping busy blocks", () => {
  const slots = freeSlots(
    [
      { start: "2026-10-05T10:00:00Z", end: "2026-10-05T11:00:00Z" },
      { start: "2026-10-05T10:30:00Z", end: "2026-10-05T12:00:00Z" },
      { start: "2026-10-05T12:15:00Z", end: "2026-10-05T13:00:00Z" },
    ],
    "2026-10-05T09:00:00Z",
    "2026-10-05T14:00:00Z",
    30 * 60_000,
  );
  assert.deepEqual(slots, [
    { start: "2026-10-05T09:00:00.000Z", end: "2026-10-05T10:00:00.000Z" },
    { start: "2026-10-05T13:00:00.000Z", end: "2026-10-05T14:00:00.000Z" },
  ]);
});

test("freeSlots is empty when the range is fully busy", () => {
  const slots = freeSlots(
    [{ start: "2026-10-05T08:00:00Z", end: "2026-10-05T15:00:00Z" }],
    "2026-10-05T09:00:00Z",
    "2026-10-05T14:00:00Z",
    60_000,
  );
  assert.deepEqual(slots, []);
});

test("buildRawMessage encodes non-ASCII subjects and threads replies", () => {
  const raw = buildRawMessage({
    to: "a@example.com",
    subject: "Café ☕",
    body: "héllo",
    inReplyTo: "<id@mail>",
    references: "<root@mail> <id@mail>",
  });
  const mime = Buffer.from(raw, "base64url").toString("utf8");
  assert.match(mime, /^To: a@example\.com\r\n/);
  assert.match(mime, /Subject: =\?UTF-8\?B\?[A-Za-z0-9+/=]+\?=\r\n/);
  assert.match(mime, /In-Reply-To: <id@mail>\r\n/);
  assert.match(mime, /References: <root@mail> <id@mail>\r\n/);
  const body = mime.split("\r\n\r\n")[1];
  assert.equal(Buffer.from(body.replace(/\r\n/g, ""), "base64").toString("utf8"), "héllo");
});

test("buildRawMessage rejects header injection", () => {
  assert.throws(
    () => buildRawMessage({ to: "a@example.com\r\nBcc: evil@example.com", subject: "s", body: "b" }),
    /line breaks/,
  );
  assert.throws(() => buildRawMessage({ to: "a@example.com", subject: "s\nX: y", body: "b" }), /line breaks/);
});

test("summarizeEvent distinguishes all-day events", () => {
  const event = summarizeEvent({ id: "1", summary: "Offsite", start: { date: "2026-10-05" }, end: { date: "2026-10-06" } });
  assert.equal(event.allDay, true);
  assert.equal(event.start, "2026-10-05");
});
