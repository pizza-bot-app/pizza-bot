import { afterEach, describe, it, expect, vi } from "vitest";
import { ApiClient } from "./api-client.js";

describe("ApiClient", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("rejects a failed thread-list request instead of treating it as an empty inbox", async () => {
    const client = new ApiClient({
      baseUrl: "http://x",
      fetch: (async () => new Response("unavailable", { status: 503 })) as unknown as typeof fetch,
    });

    await expect(client.listThreads()).rejects.toThrow("list threads failed: 503");
  });

  it("lists logs with encoded filters and authorization headers", async () => {
    const captured: { url?: string; headers?: unknown } = {};
    const client = new ApiClient({
      baseUrl: "http://x",
      headers: { Authorization: "Bearer secret" },
      fetch: (async (url: string, init?: RequestInit) => {
        captured.url = url;
        captured.headers = init?.headers;
        return new Response(JSON.stringify({ records: [], truncated: false }), { status: 200 });
      }) as unknown as typeof fetch,
    });
    await expect(
      client.listLogs({ levels: ["warn", "error"], search: "mcp failure", limit: 25 }),
    ).resolves.toEqual({ records: [], truncated: false });
    expect(captured.url).toBe(
      "http://x/logs?levels=warn%2Cerror&search=mcp+failure&limit=25",
    );
    expect(captured.headers).toEqual({ Authorization: "Bearer secret" });
  });

  it("clears logs with an authenticated DELETE request", async () => {
    const captured: { url?: string; method?: string; headers?: unknown } = {};
    const client = new ApiClient({
      baseUrl: "http://x",
      headers: { Authorization: "Bearer secret" },
      fetch: (async (url: string, init?: RequestInit) => {
        captured.url = url;
        captured.method = init?.method;
        captured.headers = init?.headers;
        return new Response(JSON.stringify({ deleted: 2 }), { status: 200 });
      }) as unknown as typeof fetch,
    });

    await expect(client.clearLogs()).resolves.toEqual({ deleted: 2 });
    expect(captured).toEqual({
      url: "http://x/logs",
      method: "DELETE",
      headers: { Authorization: "Bearer secret" },
    });
  });

  it("getState maps the snake_case wire shape back to ThreadState", async () => {
    const jsonFetch = (async () =>
      new Response(JSON.stringify({ thread_id: "t1", checkpoint_id: "c9", values: { a: 1 }, next: ["tools"], created_at: "ts" }), {
        status: 200,
      })) as unknown as typeof fetch;
    const client = new ApiClient({ baseUrl: "http://x", fetch: jsonFetch });
    const state = await client.getState("t1");
    expect(state).toEqual({ threadId: "t1", checkpointId: "c9", values: { a: 1 }, next: ["tools"], createdAt: "ts" });
  });

  it("stops the current thread run through the protocol command endpoint", async () => {
    const captured: { url?: string; method?: string; body?: unknown } = {};
    const client = new ApiClient({
      baseUrl: "http://x",
      fetch: (async (url: string, init?: RequestInit) => {
        captured.url = url;
        captured.method = init?.method;
        captured.body = init?.body ? JSON.parse(init.body as string) : undefined;
        return new Response(null, { status: 204 });
      }) as unknown as typeof fetch,
    });

    await client.stopRun("thread/1");

    expect(captured).toMatchObject({
      url: "http://x/threads/thread%2F1/commands",
      method: "POST",
      body: { method: "run.stop", params: {} },
    });
    expect((captured.body as { id?: unknown }).id).toEqual(expect.any(Number));
  });

  it("generateSkill POSTs the prompt to /skills/generate and returns the draft", async () => {
    const captured: { url?: string; method?: string | undefined; body?: unknown } = {};
    const client = new ApiClient({
      baseUrl: "http://x",
      fetch: (async (url: string, init?: RequestInit) => {
        captured.url = url;
        captured.method = init?.method;
        captured.body = init?.body ? JSON.parse(init.body as string) : undefined;
        return new Response(
          JSON.stringify({
            name: "Weekly Status",
            description: "d",
            body: "# body",
            declaredTools: ["mcp:outlook:send_email"],
            interruptOn: {
              "mcp:outlook:send_email": {
                allowedDecisions: ["approve", "edit", "reject"],
              },
            },
          }),
          { status: 200 },
        );
      }) as unknown as typeof fetch,
    });
    const draft = await client.generateSkill("summarize my open tickets");
    expect(draft).toEqual({
      name: "Weekly Status",
      description: "d",
      body: "# body",
      declaredTools: ["mcp:outlook:send_email"],
      interruptOn: {
        "mcp:outlook:send_email": {
          allowedDecisions: ["approve", "edit", "reject"],
        },
      },
    });
    expect(captured.url).toBe("http://x/skills/generate");
    expect(captured.method).toBe("POST");
    expect(captured.body).toEqual({ prompt: "summarize my open tickets" });
  });

  it("importSkill uploads multipart ZIP data and returns the imported bundle", async () => {
    const captured: { url?: string; method?: string | undefined; body?: unknown } = {};
    const imported = {
      id: "review-change",
      name: "review-change",
      description: "Reviews changes.",
      body: "# Review",
      files: [],
      source: "user",
      declaredTools: [],
      interruptOn: {},
    };
    const client = new ApiClient({
      baseUrl: "http://x",
      fetch: (async (url: string, init?: RequestInit) => {
        captured.url = url;
        captured.method = init?.method;
        captured.body = init?.body;
        return new Response(JSON.stringify(imported), { status: 201 });
      }) as unknown as typeof fetch,
    });
    const file = new File(["zip"], "review-change.zip", { type: "application/zip" });

    await expect(client.importSkill(file)).resolves.toEqual(imported);
    expect(captured.url).toBe("http://x/skills/import");
    expect(captured.method).toBe("POST");
    expect(captured.body).toBeInstanceOf(FormData);
    expect((captured.body as FormData).get("file")).toBe(file);
  });

  it("importSkill surfaces the server validation detail", async () => {
    const client = new ApiClient({
      baseUrl: "http://x",
      fetch: (async () =>
        new Response(JSON.stringify({ error: "invalid_skill_md", detail: "SKILL.md needs a name." }), {
          status: 400,
        })) as unknown as typeof fetch,
    });

    await expect(client.importSkill(new File(["zip"], "bad.zip"))).rejects.toThrow(
      "SKILL.md needs a name.",
    );
  });

  it("setThreadPinned PATCHes the thread and returns the updated ThreadInfo", async () => {
    const captured: { url?: string; method?: string | undefined; body?: unknown } = {};
    const client = new ApiClient({
      baseUrl: "http://x",
      fetch: (async (url: string, init?: RequestInit) => {
        captured.url = url;
        captured.method = init?.method;
        captured.body = init?.body ? JSON.parse(init.body as string) : undefined;
        return new Response(
          JSON.stringify({ threadId: "t1", title: "First", source: "user", pinned: true, createdAt: "", lastActivityAt: "" }),
          { status: 200 },
        );
      }) as unknown as typeof fetch,
    });
    const info = await client.setThreadPinned("t1", true);
    expect(info.pinned).toBe(true);
    expect(captured.url).toBe("http://x/threads/t1");
    expect(captured.method).toBe("PATCH");
    expect(captured.body).toEqual({ pinned: true });
  });

  it("setThreadTitle PATCHes the thread and returns the updated ThreadInfo", async () => {
    const captured: { url?: string; method?: string | undefined; body?: unknown } = {};
    const client = new ApiClient({
      baseUrl: "http://x",
      fetch: (async (url: string, init?: RequestInit) => {
        captured.url = url;
        captured.method = init?.method;
        captured.body = init?.body ? JSON.parse(init.body as string) : undefined;
        return new Response(
          JSON.stringify({
            threadId: "t1",
            title: "A better title",
            source: "user",
            pinned: false,
            unread: false,
            createdAt: "",
            lastActivityAt: "",
          }),
          { status: 200 },
        );
      }) as unknown as typeof fetch,
    });
    const info = await client.setThreadTitle("t1", "A better title");
    expect(info.title).toBe("A better title");
    expect(captured.url).toBe("http://x/threads/t1");
    expect(captured.method).toBe("PATCH");
    expect(captured.body).toEqual({ title: "A better title" });
  });

  it("markThreadRead PATCHes unread:false and returns the updated ThreadInfo", async () => {
    const captured: { url?: string; method?: string | undefined; body?: unknown } = {};
    const client = new ApiClient({
      baseUrl: "http://x",
      fetch: (async (url: string, init?: RequestInit) => {
        captured.url = url;
        captured.method = init?.method;
        captured.body = init?.body ? JSON.parse(init.body as string) : undefined;
        return new Response(
          JSON.stringify({ threadId: "t1", title: "First", source: "user", pinned: false, unread: false, createdAt: "", lastActivityAt: "" }),
          { status: 200 },
        );
      }) as unknown as typeof fetch,
    });
    const info = await client.markThreadRead("t1");
    expect(info.unread).toBe(false);
    expect(captured.url).toBe("http://x/threads/t1");
    expect(captured.method).toBe("PATCH");
    expect(captured.body).toEqual({ unread: false });
  });

  it("deleteThread DELETEs the thread and returns the server's deleted flag", async () => {
    const captured: { url?: string; method?: string | undefined } = {};
    const client = new ApiClient({
      baseUrl: "http://x",
      fetch: (async (url: string, init?: RequestInit) => {
        captured.url = url;
        captured.method = init?.method;
        return new Response(JSON.stringify({ deleted: true }), { status: 200 });
      }) as unknown as typeof fetch,
    });
    expect(await client.deleteThread("t1")).toBe(true);
    expect(captured.url).toBe("http://x/threads/t1");
    expect(captured.method).toBe("DELETE");
  });

  it("deleteAttachment DELETEs a discarded upload", async () => {
    const captured: { url?: string; method?: string | undefined } = {};
    const client = new ApiClient({
      baseUrl: "http://x",
      fetch: (async (url: string, init?: RequestInit) => {
        captured.url = url;
        captured.method = init?.method;
        return new Response(JSON.stringify({ deleted: true }), { status: 200 });
      }) as unknown as typeof fetch,
    });
    expect(await client.deleteAttachment("a1")).toBe(true);
    expect(captured).toEqual({ url: "http://x/attachments/a1", method: "DELETE" });
  });

  it("keeps settings updates alive while a page is refreshing", async () => {
    const captured: { url?: string; init: RequestInit | undefined } = { init: undefined };
    const client = new ApiClient({
      baseUrl: "http://x",
      fetch: (async (url: string, init?: RequestInit) => {
        captured.url = url;
        captured.init = init;
        return new Response(JSON.stringify({ theme: "light" }), { status: 200 });
      }) as unknown as typeof fetch,
    });

    expect((await client.updateSettings({ theme: "light" })).theme).toBe("light");
    expect(captured.url).toBe("http://x/settings");
    expect(captured.init).toMatchObject({ method: "PUT", keepalive: true });
  });

  it("browses, creates, and removes backend-local folder grants", async () => {
    const calls: Array<{ url: string; method?: string; body?: string }> = [];
    const client = new ApiClient({
      baseUrl: "http://x",
      fetch: (async (url: string, init?: RequestInit) => {
        calls.push({
          url,
          method: init?.method,
          body: typeof init?.body === "string" ? init.body : undefined,
        });
        return new Response(
          init?.method === "DELETE"
            ? JSON.stringify({ deleted: true })
            : url.includes("/browse")
              ? JSON.stringify({
                  currentPath: "/srv",
                  parentPath: null,
                  directories: [{ name: "project", path: "/srv/project" }],
                })
            : JSON.stringify({
                id: "project",
                label: "Project",
                path: "/srv/project",
                virtualPath: "/local/project",
                readOnly: false,
                createdAt: "now",
              }),
          { status: init?.method === "POST" ? 201 : 200 },
        );
      }) as unknown as typeof fetch,
    });

    expect(await client.browseLocalFolders("/srv")).toMatchObject({
      currentPath: "/srv",
      directories: [{ path: "/srv/project" }],
    });
    expect(
      await client.createLocalFolder({
        path: "/srv/project",
        readOnly: false,
      }),
    ).toMatchObject({ id: "project", readOnly: false });
    expect(await client.deleteLocalFolder("project")).toBe(true);
    expect(calls).toEqual([
      {
        url: "http://x/local-folders/browse?path=%2Fsrv",
        method: undefined,
        body: undefined,
      },
      {
        url: "http://x/local-folders",
        method: "POST",
        body: JSON.stringify({ path: "/srv/project", readOnly: false }),
      },
      {
        url: "http://x/local-folders/project",
        method: "DELETE",
        body: undefined,
      },
    ]);
  });

  it("watches authenticated thread-change events over SSE", async () => {
    const captured: { url?: string; headers?: RequestInit["headers"] } = {};
    const client = new ApiClient({
      baseUrl: "http://x",
      headers: { Authorization: "Bearer secret" },
      fetch: (async (url: string, init?: RequestInit) => {
        captured.url = url;
        captured.headers = init?.headers;
        const body = new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode("event: ready\ndata: {}\n\n"));
            controller.enqueue(
              new TextEncoder().encode(
                'event: changed\ndata: {"type":"upsert","threadId":"t1"}\n\n',
              ),
            );
            controller.close();
          },
        });
        return new Response(body, {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        });
      }) as unknown as typeof fetch,
    });
    const ready = vi.fn();
    const changed = vi.fn();

    await client.watchThreadChanges(new AbortController().signal, {
      onReady: ready,
      onChange: changed,
    });

    expect(captured.url).toBe("http://x/threads/events");
    expect(captured.headers).toEqual({
      accept: "text/event-stream",
      Authorization: "Bearer secret",
    });
    expect(ready).toHaveBeenCalledTimes(1);
    expect(changed).toHaveBeenCalledTimes(1);
  });

  it("rejects a failed thread-change subscription", async () => {
    const client = new ApiClient({
      baseUrl: "http://x",
      fetch: (async () => new Response("nope", { status: 500 })) as unknown as typeof fetch,
    });
    await expect(
      client.watchThreadChanges(new AbortController().signal, {
        onReady: () => {},
        onChange: () => {},
      }),
    ).rejects.toThrow("watch thread changes failed: 500");
  });

  it("cancels the thread-change response reader when its subscription is aborted", async () => {
    let cancelled = false;
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("event: ready\ndata: {}\n\n"));
      },
      cancel() {
        cancelled = true;
      },
    });
    const client = new ApiClient({
      baseUrl: "http://x",
      fetch: (async () =>
        new Response(body, {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        })) as unknown as typeof fetch,
    });
    const abort = new AbortController();
    const watching = client.watchThreadChanges(abort.signal, {
      onReady: () => abort.abort(),
      onChange: () => {},
    });

    await expect(watching).resolves.toBeUndefined();
    expect(cancelled).toBe(true);
  });

  it("abandons a half-open thread-change stream after its heartbeat deadline", async () => {
    vi.useFakeTimers();
    let cancelled = false;
    const body = new ReadableStream({
      cancel() {
        cancelled = true;
      },
    });
    const client = new ApiClient({
      baseUrl: "http://x",
      fetch: (async () =>
        new Response(body, {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        })) as unknown as typeof fetch,
    });
    const watching = client.watchThreadChanges(
      new AbortController().signal,
      {
        onReady: () => {},
        onChange: () => {},
      },
    );
    const rejected = expect(watching).rejects.toThrow(
      "SSE stream received no data for 45000ms",
    );

    await vi.advanceTimersByTimeAsync(45_000);
    await rejected;
    expect(cancelled).toBe(true);
  });

  it("bounds opening a thread-change stream when the backend is half-open", async () => {
    vi.useFakeTimers();
    const client = new ApiClient({
      baseUrl: "http://x",
      fetch: (() => new Promise<Response>(() => {})) as typeof fetch,
    });
    const watching = client.watchThreadChanges(
      new AbortController().signal,
      {
        onReady: () => {},
        onChange: () => {},
      },
    );
    const rejected = expect(watching).rejects.toThrow(
      "request timed out after 10000ms",
    );

    await vi.advanceTimersByTimeAsync(10_000);
    await rejected;
  });

  it("bounds status probes when a backend connection is half-open", async () => {
    vi.useFakeTimers();
    const client = new ApiClient({
      baseUrl: "http://x",
      fetch: (() => new Promise<Response>(() => {})) as typeof fetch,
    });
    const status = client.getStatus();
    const rejected = expect(status).rejects.toThrow(
      "request timed out after 10000ms",
    );

    await vi.advanceTimersByTimeAsync(10_000);
    await rejected;
  });

  it("getState surfaces the durable awaiting_input flag as awaitingInput", async () => {
    const jsonFetch = (async () =>
      new Response(
        JSON.stringify({
          thread_id: "t1",
          checkpoint_id: "c9",
          values: {},
          next: ["tools"],
          created_at: "ts",
          awaiting_input: true,
        }),
        { status: 200 },
      )) as unknown as typeof fetch;
    const client = new ApiClient({ baseUrl: "http://x", fetch: jsonFetch });
    expect((await client.getState("t1")).awaitingInput).toBe(true);
  });

  it("listTriggers GETs /triggers and returns the defs", async () => {
    const captured: { url?: string } = {};
    const client = new ApiClient({
      baseUrl: "http://x",
      fetch: (async (url: string) => {
        captured.url = url;
        return new Response(
          JSON.stringify([{ id: "trg_1", kind: "cron", enabled: true, cron: "0 9 * * *", createdAt: "ts" }]),
          { status: 200 },
        );
      }) as unknown as typeof fetch,
    });
    const triggers = await client.listTriggers();
    expect(captured.url).toBe("http://x/triggers");
    expect(triggers).toHaveLength(1);
    expect(triggers[0]).toMatchObject({ id: "trg_1", kind: "cron" });
  });

  it("listTriggers rejects a non-200 instead of masking it as an empty list", async () => {
    const client = new ApiClient({
      baseUrl: "http://x",
      fetch: (async () => new Response("nope", { status: 500 })) as unknown as typeof fetch,
    });
    await expect(client.listTriggers()).rejects.toThrow("list triggers failed: 500");
  });

  it("optional GET resolves to undefined on 404 but rejects other failures", async () => {
    const absent = new ApiClient({
      baseUrl: "http://x",
      fetch: (async () => new Response("missing", { status: 404 })) as unknown as typeof fetch,
    });
    expect(await absent.getSkill("nope")).toBeUndefined();

    const broken = new ApiClient({
      baseUrl: "http://x",
      fetch: (async () => new Response("boom", { status: 500 })) as unknown as typeof fetch,
    });
    await expect(broken.getSkill("x")).rejects.toThrow("get skill failed: 500");
  });

  it("surfaces the server error detail in ApiError messages", async () => {
    const client = new ApiClient({
      baseUrl: "http://x",
      fetch: (async () =>
        new Response(JSON.stringify({ error: "boom", detail: "backend unavailable" }), {
          status: 503,
        })) as unknown as typeof fetch,
    });
    await expect(client.listModels()).rejects.toThrow("list models failed: 503 backend unavailable");
  });

  it("requests an unfiltered forced model catalog refresh", async () => {
    const captured: { url?: string } = {};
    const client = new ApiClient({
      baseUrl: "http://x",
      fetch: (async (url: string) => {
        captured.url = url;
        return new Response(JSON.stringify({ models: [], providers: [], default: "" }));
      }) as unknown as typeof fetch,
    });

    await client.listModels(true, true);

    expect(captured.url).toBe("http://x/models?include_disabled=true&refresh=true");
  });

  it("createTrigger POSTs the def and returns the server's created trigger", async () => {
    const captured: { url?: string; method?: string | undefined; body?: unknown } = {};
    const client = new ApiClient({
      baseUrl: "http://x",
      fetch: (async (url: string, init?: RequestInit) => {
        captured.url = url;
        captured.method = init?.method;
        captured.body = init?.body ? JSON.parse(init.body as string) : undefined;
        return new Response(
          JSON.stringify({ id: "trg_new", kind: "cron", enabled: true, cron: "0 8 * * 1", createdAt: "ts" }),
          { status: 201 },
        );
      }) as unknown as typeof fetch,
    });
    const created = await client.createTrigger({ kind: "cron", cron: "0 8 * * 1" });
    expect(captured.url).toBe("http://x/triggers");
    expect(captured.method).toBe("POST");
    expect(captured.body).toMatchObject({ kind: "cron" });
    expect(created.id).toBe("trg_new");
  });

  it("updateTrigger PATCHes /triggers/:id and returns the updated def", async () => {
    const captured: { url?: string; method?: string | undefined; body?: unknown } = {};
    const client = new ApiClient({
      baseUrl: "http://x",
      fetch: (async (url: string, init?: RequestInit) => {
        captured.url = url;
        captured.method = init?.method;
        captured.body = init?.body ? JSON.parse(init.body as string) : undefined;
        return new Response(
          JSON.stringify({ id: "trg_1", kind: "cron", enabled: false, cron: "0 9 * * *", createdAt: "ts" }),
          { status: 200 },
        );
      }) as unknown as typeof fetch,
    });
    const updated = await client.updateTrigger("trg_1", { enabled: false });
    expect(captured.url).toBe("http://x/triggers/trg_1");
    expect(captured.method).toBe("PATCH");
    expect(captured.body).toEqual({ enabled: false });
    expect(updated.enabled).toBe(false);
  });

  it("deleteTrigger DELETEs /triggers/:id and returns the deleted flag", async () => {
    const captured: { url?: string; method?: string | undefined } = {};
    const client = new ApiClient({
      baseUrl: "http://x",
      fetch: (async (url: string, init?: RequestInit) => {
        captured.url = url;
        captured.method = init?.method;
        return new Response(JSON.stringify({ deleted: true }), { status: 200 });
      }) as unknown as typeof fetch,
    });
    expect(await client.deleteTrigger("trg_1")).toBe(true);
    expect(captured.url).toBe("http://x/triggers/trg_1");
    expect(captured.method).toBe("DELETE");
  });

  it("invokeTrigger POSTs the secret-guarded invoke route and maps the run ids", async () => {
    const captured: { url?: string; headers?: Record<string, string> } = {};
    const client = new ApiClient({
      baseUrl: "http://x",
      fetch: (async (url: string, init?: RequestInit) => {
        captured.url = url;
        captured.headers = init?.headers as Record<string, string>;
        return new Response(JSON.stringify({ run_id: "r9", thread_id: "t9", status: "running" }), { status: 200 });
      }) as unknown as typeof fetch,
    });
    const res = await client.invokeTrigger("trg_hook", "s3cret", { hello: "world" });
    expect(captured.url).toBe("http://x/triggers/trg_hook/invoke");
    expect(captured.headers?.["x-trigger-secret"]).toBe("s3cret");
    expect(res).toEqual({ runId: "r9", threadId: "t9", status: "running" });
  });

  it("runTrigger POSTs the manual /run route (no secret) and maps the run ids", async () => {
    const captured: { url?: string; method?: string | undefined; headers?: Record<string, string> } = {};
    const client = new ApiClient({
      baseUrl: "http://x",
      fetch: (async (url: string, init?: RequestInit) => {
        captured.url = url;
        captured.method = init?.method;
        captured.headers = init?.headers as Record<string, string>;
        return new Response(JSON.stringify({ run_id: "rn", thread_id: "tn", status: "running" }), { status: 200 });
      }) as unknown as typeof fetch,
    });
    const res = await client.runTrigger("trg_cron");
    expect(captured.url).toBe("http://x/triggers/trg_cron/run");
    expect(captured.method).toBe("POST");
    expect(captured.headers?.["x-trigger-secret"]).toBeUndefined();
    expect(res).toEqual({ runId: "rn", threadId: "tn", status: "running" });
  });

  it("fetchAttachment forwards configured authentication headers", async () => {
    let captured: RequestInit | undefined;
    const client = new ApiClient({
      baseUrl: "http://x",
      headers: { authorization: "Bearer secret" },
      fetch: (async (_url: string, init?: RequestInit) => {
        captured = init;
        return new Response("bytes", { status: 200 });
      }) as unknown as typeof fetch,
    });

    expect(await (await client.fetchAttachment("a/b")).text()).toBe("bytes");
    expect(captured?.headers).toEqual({ authorization: "Bearer secret" });
  });
});
