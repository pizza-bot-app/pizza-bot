import { useCallback, useEffect, useMemo, useSyncExternalStore } from "react";
import type { HitlDecision, AttachmentMeta } from "@pizza-bot/core";
import type { UIMessageLike } from "@/projection";
import {
  protocolStreamStore as streamStore,
  type ProtocolThreadSlice,
} from "./protocol-stream-store.js";

export interface ThreadBinding extends ProtocolThreadSlice {
  send: (text: string, model?: string, attachments?: AttachmentMeta[]) => Promise<void>;
  steerNow: (text: string, model?: string, attachments?: AttachmentMeta[]) => Promise<void>;
  cancelQueued: (index: number) => void;
  stop: () => Promise<void>;
  decide: (
    interruptId: string,
    decision: HitlDecision,
    editedArgs?: unknown,
    editedName?: string,
  ) => Promise<void>;
}

export function useThreadSlice(
  threadId: string,
  hydrateOnMount = false,
): ThreadBinding {
  const slice = useSyncExternalStore(
    useCallback((cb) => streamStore.subscribe(threadId, cb), [threadId]),
    () => streamStore.getSlice(threadId),
    () => streamStore.getSlice(threadId),
  );

  useEffect(() => {
    void streamStore.attach(threadId, hydrateOnMount).catch(() => {
      // The store exposes the error state. A later mount/attach retries it.
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [threadId]);

  const send = useCallback(
    (text: string, model?: string, attachments?: AttachmentMeta[]) =>
      streamStore.send(threadId, text, model, attachments),
    [threadId],
  );
  const steerNow = useCallback(
    (text: string, model?: string, attachments?: AttachmentMeta[]) =>
      streamStore.steerNow(threadId, text, model, attachments),
    [threadId],
  );
  const cancelQueued = useCallback(
    (index: number) => streamStore.cancelQueued(threadId, index),
    [threadId],
  );
  const stop = useCallback(() => streamStore.stop(threadId), [threadId]);
  const decide = useCallback(
    (interruptId: string, decision: HitlDecision, editedArgs?: unknown, editedName?: string, message?: string) =>
      streamStore.decide(threadId, interruptId, decision, editedArgs, editedName, message),
    [threadId],
  );

  return { ...slice, send, steerNow, cancelQueued, stop, decide };
}

export function useThreadSliceReadOnly(threadId: string | null): ProtocolThreadSlice {
  return useSyncExternalStore(
    useCallback((cb) => (threadId ? streamStore.subscribe(threadId, cb) : () => {}), [threadId]),
    () => streamStore.getSlice(threadId),
    () => streamStore.getSlice(threadId),
  );
}

export function useSubagentTranscript(
  threadId: string,
  delegationId: string,
  open: boolean,
): UIMessageLike[] | null {
  const handle = useMemo(
    () => (open ? streamStore.openSubagentTranscript(threadId, delegationId) : null),
    [threadId, delegationId, open],
  );

  // Each scoped SDK projection is ref-counted and must release on close or switch.
  useEffect(() => {
    if (!handle) return;
    return () => handle.release();
  }, [handle]);

  return useSyncExternalStore(
    useCallback((cb) => handle?.subscribe(cb) ?? (() => {}), [handle]),
    () => handle?.getMessages() ?? null,
    () => null,
  );
}

export function useKnownThreadIds(): string[] {
  return useSyncExternalStore(
    useCallback((cb) => streamStore.subscribeGlobal(cb), []),
    () => streamStore.knownThreadIds(),
    () => streamStore.knownThreadIds(),
  );
}

export function useRunningThreadIds(): string[] {
  return useSyncExternalStore(
    useCallback((cb) => streamStore.subscribeGlobal(cb), []),
    () => streamStore.runningThreadIds(),
    () => streamStore.runningThreadIds(),
  );
}
