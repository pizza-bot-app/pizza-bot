import { createParser } from "eventsource-parser";
import {
  threadActivityEventSchema,
  threadActivityReadySchema,
  type ThreadActivityEvent,
} from "@pizza-bot/core";
import type { NativeNotificationRequest } from "./native-notifications.js";

export interface ThreadActivityConnection {
  sourceId: string;
  apiBase: string;
  apiToken?: string;
}

export interface ThreadActivityWatcherOptions {
  notify(request: NativeNotificationRequest): void;
  onError?(error: unknown): void;
  fetch?: typeof fetch;
  reconnectDelayMs?: number;
  maxReconnectDelayMs?: number;
  connectTimeoutMs?: number;
  idleTimeoutMs?: number;
}

interface ActivityHandlers {
  onReady(cursor: number): void;
  onActivity(event: ThreadActivityEvent): void;
}

const DEFAULT_RECONNECT_DELAY_MS = 1_000;
const DEFAULT_MAX_RECONNECT_DELAY_MS = 30_000;
const DEFAULT_CONNECT_TIMEOUT_MS = 10_000;
const DEFAULT_IDLE_TIMEOUT_MS = 45_000;

export function notificationForThreadActivity(
  event: ThreadActivityEvent,
): NativeNotificationRequest | undefined {
  const base = {
    threadId: event.threadId,
    threadTitle: event.threadTitle,
  };
  switch (event.outcome) {
    case "success":
      return { ...base, kind: "run-complete" };
    case "error":
    case "timeout":
      return { ...base, kind: "run-failed", reason: event.outcome };
    case "interrupted":
      return { ...base, kind: "action-required" };
    case "cancelled":
      return undefined;
  }
}

export class ThreadActivityWatcher {
  private connection: ThreadActivityConnection | undefined;
  private cursor: number | undefined;
  private generation = 0;
  private reconnectDelayMs: number;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private activeAbort: AbortController | undefined;
  private stopped = false;

  private readonly doFetch: typeof fetch;
  private readonly initialReconnectDelayMs: number;
  private readonly maxReconnectDelayMs: number;
  private readonly connectTimeoutMs: number;
  private readonly idleTimeoutMs: number;

  constructor(private readonly options: ThreadActivityWatcherOptions) {
    this.doFetch = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.initialReconnectDelayMs =
      options.reconnectDelayMs ?? DEFAULT_RECONNECT_DELAY_MS;
    this.maxReconnectDelayMs =
      options.maxReconnectDelayMs ?? DEFAULT_MAX_RECONNECT_DELAY_MS;
    this.connectTimeoutMs =
      options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
    this.idleTimeoutMs = options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
    this.reconnectDelayMs = this.initialReconnectDelayMs;
  }

  setConnection(input: ThreadActivityConnection): void {
    if (this.stopped) return;
    const connection = {
      ...input,
      apiBase: input.apiBase.replace(/\/$/, ""),
    };
    if (connection.sourceId !== this.connection?.sourceId) {
      this.cursor = undefined;
    }
    this.connection = connection;
    this.restart();
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.generation++;
    this.activeAbort?.abort();
    this.activeAbort = undefined;
    if (this.reconnectTimer !== undefined) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
  }

  private restart(): void {
    this.generation++;
    this.activeAbort?.abort();
    this.activeAbort = undefined;
    if (this.reconnectTimer !== undefined) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
    this.reconnectDelayMs = this.initialReconnectDelayMs;
    void this.connect(this.generation);
  }

  private async connect(generation: number): Promise<void> {
    const connection = this.connection;
    if (this.stopped || !connection || generation !== this.generation) return;

    const abort = new AbortController();
    this.activeAbort = abort;
    try {
      await watchThreadActivityOnce(
        this.doFetch,
        connection,
        this.cursor,
        abort.signal,
        {
          onReady: (cursor) => {
            this.reconnectDelayMs = this.initialReconnectDelayMs;
            if (this.cursor === undefined) this.cursor = cursor;
          },
          onActivity: (event) => this.onActivity(event),
        },
        this.connectTimeoutMs,
        this.idleTimeoutMs,
      );
    } catch (error) {
      if (!abort.signal.aborted && generation === this.generation) {
        this.options.onError?.(error);
      }
    } finally {
      if (this.activeAbort === abort) this.activeAbort = undefined;
    }

    if (this.stopped || generation !== this.generation) return;
    const delay = this.reconnectDelayMs;
    this.reconnectDelayMs = Math.min(
      Math.max(delay * 2, this.initialReconnectDelayMs),
      this.maxReconnectDelayMs,
    );
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      void this.connect(generation);
    }, delay);
    this.reconnectTimer.unref?.();
  }

  private onActivity(event: ThreadActivityEvent): void {
    if (this.cursor === undefined) {
      this.cursor = event.seq;
      return;
    }
    if (event.seq <= this.cursor) return;
    this.cursor = event.seq;
    const notification = notificationForThreadActivity(event);
    if (!notification) return;
    try {
      this.options.notify(notification);
    } catch (error) {
      this.options.onError?.(error);
    }
  }
}

async function watchThreadActivityOnce(
  doFetch: typeof fetch,
  connection: ThreadActivityConnection,
  cursor: number | undefined,
  signal: AbortSignal,
  handlers: ActivityHandlers,
  connectTimeoutMs: number,
  idleTimeoutMs: number,
): Promise<void> {
  const suffix = cursor === undefined ? "" : `?since=${cursor}`;
  const response = await fetchWithTimeout(
    doFetch,
    `${connection.apiBase}/threads/activity/events${suffix}`,
    {
      headers: {
        accept: "text/event-stream",
        ...(connection.apiToken
          ? { authorization: `Bearer ${connection.apiToken}` }
          : {}),
      },
    },
    connectTimeoutMs,
    signal,
  );
  if (!response.ok) {
    throw new Error(
      `thread activity stream failed: ${response.status} ${response.statusText}`,
    );
  }
  if (!response.body) {
    throw new Error("thread activity stream failed: response has no body");
  }

  const parser = createParser({
    maxBufferSize: 64 * 1024,
    onEvent: (event) => {
      if (event.event === "ready") {
        handlers.onReady(
          threadActivityReadySchema.parse(JSON.parse(event.data)).cursor,
        );
      } else if (event.event === "activity") {
        handlers.onActivity(
          threadActivityEventSchema.parse(JSON.parse(event.data)),
        );
      }
    },
  });
  await consumeSseBody(
    response.body,
    signal,
    (chunk) => parser.feed(chunk),
    idleTimeoutMs,
  );
}

async function fetchWithTimeout(
  doFetch: typeof fetch,
  url: string,
  init: RequestInit,
  timeoutMs: number,
  parentSignal: AbortSignal,
): Promise<Response> {
  const abort = new AbortController();
  const onAbort = () => abort.abort(parentSignal.reason);
  if (parentSignal.aborted) onAbort();
  else parentSignal.addEventListener("abort", onAbort, { once: true });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      abort.abort();
      reject(new Error(`request timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    timer.unref?.();
  });
  try {
    return await Promise.race([
      doFetch(url, { ...init, signal: abort.signal }),
      timeout,
    ]);
  } finally {
    if (timer) clearTimeout(timer);
    parentSignal.removeEventListener("abort", onAbort);
  }
}

async function consumeSseBody(
  body: ReadableStream<Uint8Array>,
  signal: AbortSignal,
  feed: (chunk: string) => void,
  idleTimeoutMs: number,
): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const onAbort = () => {
    void reader.cancel().catch(() => {});
  };
  if (signal.aborted) onAbort();
  else signal.addEventListener("abort", onAbort, { once: true });
  try {
    while (true) {
      const { done, value } = await readSseChunk(reader, idleTimeoutMs);
      if (done) break;
      feed(decoder.decode(value, { stream: true }));
    }
    feed(decoder.decode());
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  } finally {
    signal.removeEventListener("abort", onAbort);
    reader.releaseLock();
  }
}

async function readSseChunk(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  idleTimeoutMs: number,
) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () =>
        reject(
          new Error(`SSE stream received no data for ${idleTimeoutMs}ms`),
        ),
      idleTimeoutMs,
    );
    timer.unref?.();
  });
  try {
    return await Promise.race([reader.read(), timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
