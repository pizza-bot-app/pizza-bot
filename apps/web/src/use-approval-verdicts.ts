/**
 * A thread's durable approval verdicts. Read-only, and the tiers come back as the server
 * audited them at dispatch: the browser never re-checks a shipped claim.
 */
import { useEffect, useState } from "react";
import type { ApprovalVerdict } from "@pizza-bot/core";
import type { ApiClient } from "@/api-client";

export function useApprovalVerdicts(
  client: ApiClient | undefined,
  threadId: string | null | undefined,
  /** Any value that changes when a run may have settled an approval; triggers a relist. */
  revision?: string,
): ApprovalVerdict[] {
  const [verdicts, setVerdicts] = useState<ApprovalVerdict[]>([]);

  useEffect(() => {
    if (!client || !threadId) {
      setVerdicts([]);
      return;
    }
    let live = true;
    const settle = (list: ApprovalVerdict[]) => {
      if (live) setVerdicts(list);
    };
    // A server that cannot answer reads the same as a thread that approved nothing.
    client.listApprovalVerdicts(threadId).then(settle, () => settle([]));
    return () => {
      live = false;
    };
  }, [client, threadId, revision]);

  return verdicts;
}
