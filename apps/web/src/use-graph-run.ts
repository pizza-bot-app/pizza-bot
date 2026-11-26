import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import type { UIMessageLike } from "@/projection";
import {
  graphRunStore,
  type AgentTranscriptHandle,
  type GraphRunSnapshot,
} from "./graph-run-store.js";

export function useGraphRun(threadId: string): GraphRunSnapshot {
  return useSyncExternalStore(
    useCallback((cb) => graphRunStore.subscribe(threadId, cb), [threadId]),
    () => graphRunStore.getSnapshot(threadId),
    () => graphRunStore.getSnapshot(threadId),
  );
}

export function useAgentTranscript(
  threadId: string,
  namespace: readonly string[] | null,
): UIMessageLike[] | null {
  const key = namespace?.join("|") ?? "";
  const [handle, setHandle] = useState<AgentTranscriptHandle | null>(null);
  // Each scoped SDK projection is ref-counted and must release on close or switch.
  useEffect(() => {
    if (!key) return;
    const opened = graphRunStore.openAgentTranscript(threadId, key.split("|"));
    setHandle(opened);
    return () => {
      opened.release();
      setHandle(null);
    };
  }, [threadId, key]);
  return useSyncExternalStore(
    useCallback((cb) => handle?.subscribe(cb) ?? (() => {}), [handle]),
    () => handle?.getMessages() ?? null,
    () => null,
  );
}
