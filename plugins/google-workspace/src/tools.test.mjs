import assert from "node:assert/strict";
import { test } from "node:test";
import { createTools } from "./tools.mjs";

const b64 = (s) => Buffer.from(s, "utf8").toString("base64url");
const headers = (h) => Object.entries(h).map(([name, value]) => ({ name, value }));

function toolsWith(fakes) {
  const tools = new Map(createTools(() => fakes).map((t) => [t.name, t]));
  return (name, args = {}) => tools.get(name).handler(args);
}

test("search_threads lists then summarizes each thread", async () => {
  const gets = [];
  const call = toolsWith({
    gmail: {
      users: {
        threads: {
          list: async ({ q }) => ({ data: { threads: [{ id: "t1" }], nextPageToken: "n" }, q }),
          get: async (params) => {
            gets.push(params);
            return {
              data: {
                id: "t1",
                messages: [
                  { snippet: "first", payload: { headers: headers({ Subject: "Lunch", From: "a@x.com", Date: "d1" }) } },
                  { snippet: "last", payload: { headers: headers({ Date: "d2" }) } },
                ],
              },
            };
          },
        },
      },
    },
  });
  const result = await call("search_threads", { query: "from:a", maxResults: 10 });
  assert.deepEqual(result, {
    threads: [{ id: "t1", subject: "Lunch", from: "a@x.com", lastDate: "d2", messageCount: 2, snippet: "last" }],
    nextPageToken: "n",
  });
  assert.equal(gets[0].format, "metadata");
});

test("create_draft derives subject and threading headers from the thread", async () => {
  let created;
  const call = toolsWith({
    gmail: {
      users: {
        threads: {
          get: async () => ({
            data: {
              messages: [
                { payload: { headers: headers({ Subject: "Plans", "Message-ID": "<1@m>" }) } },
                { payload: { headers: headers({ "Message-ID": "<2@m>", References: "<1@m>" }) } },
              ],
            },
          }),
        },
        drafts: {
          create: async (params) => {
            created = params;
            return { data: { id: "d1", message: { threadId: "t1" } } };
          },
        },
      },
    },
  });
  const result = await call("create_draft", { to: "a@x.com", body: "ok", replyToThreadId: "t1" });
  assert.deepEqual(result, { draftId: "d1", threadId: "t1" });
  assert.equal(created.requestBody.message.threadId, "t1");
  const mime = Buffer.from(created.requestBody.message.raw, "base64url").toString("utf8");
  assert.match(mime, /Subject: Re: Plans\r\n/);
  assert.match(mime, /In-Reply-To: <2@m>\r\n/);
  assert.match(mime, /References: <1@m> <2@m>\r\n/);
});

test("create_draft without a thread requires a subject", async () => {
  const call = toolsWith({ gmail: {} });
  await assert.rejects(call("create_draft", { to: "a@x.com", body: "hi" }), /subject is required/);
});

test("get_thread decodes and truncates bodies", async () => {
  const call = toolsWith({
    gmail: {
      users: {
        threads: {
          get: async () => ({
            data: {
              id: "t1",
              messages: [{ id: "m1", payload: { mimeType: "text/plain", headers: headers({}), body: { data: b64("x".repeat(300)) } } }],
            },
          }),
        },
      },
    },
  });
  const { messages } = await call("get_thread", { threadId: "t1", maxBodyChars: 200 });
  assert.match(messages[0].body, /\[truncated 100 chars\]$/);
});

test("find_free_time merges busy blocks across calendars", async () => {
  const call = toolsWith({
    calendar: {
      freebusy: {
        query: async () => ({
          data: {
            calendars: {
              primary: { busy: [{ start: "2026-10-05T10:00:00Z", end: "2026-10-05T11:00:00Z" }] },
              work: { busy: [{ start: "2026-10-05T10:30:00Z", end: "2026-10-05T12:00:00Z" }] },
            },
          },
        }),
      },
    },
  });
  const { freeSlots } = await call("find_free_time", {
    timeMin: "2026-10-05T09:00:00Z",
    timeMax: "2026-10-05T13:00:00Z",
    durationMinutes: 60,
    calendarIds: ["primary", "work"],
  });
  assert.deepEqual(freeSlots, [
    { start: "2026-10-05T09:00:00.000Z", end: "2026-10-05T10:00:00.000Z" },
    { start: "2026-10-05T12:00:00.000Z", end: "2026-10-05T13:00:00.000Z" },
  ]);
});

test("create_event defaults to not notifying attendees", async () => {
  let inserted;
  const call = toolsWith({
    calendar: {
      events: {
        insert: async (params) => {
          inserted = params;
          return { data: { id: "e1", summary: "Sync", start: { dateTime: "s" }, end: { dateTime: "e" } } };
        },
      },
    },
  });
  await call("create_event", {
    summary: "Sync",
    start: "2026-10-05T09:00:00-07:00",
    end: "2026-10-05T09:30:00-07:00",
    calendarId: "primary",
    attendees: ["a@x.com"],
    sendUpdates: "none",
  });
  assert.equal(inserted.sendUpdates, "none");
  assert.deepEqual(inserted.requestBody.attendees, [{ email: "a@x.com" }]);
});

test("tools expose no send or delete capability", () => {
  const names = createTools(() => ({})).map((t) => t.name);
  assert.ok(!names.some((n) => /send|delete|trash/.test(n)));
});
