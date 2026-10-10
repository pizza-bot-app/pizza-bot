/**
 * The server's grading of a pending approval's citations, one view per action. The browser
 * never grades a claim itself: the tiers come from the same judgement the record will keep.
 */
import { useEffect, useMemo, useState } from "react";
import { citedEvidenceIds } from "@/projection";
import type { InterruptGrounding } from "./api-client.js";
import type { GroundingView } from "./components/ApprovalArguments.js";
import { useEvidence } from "./use-evidence.js";

type Grading =
  | { status: "checking" }
  | { status: "ready"; grounding: InterruptGrounding }
  | { status: "unavailable" };

export function useGroundingViews(
  interruptId: string,
  calls: readonly unknown[],
): Array<GroundingView | undefined> {
  const ledger = useEvidence();
  // Memoized on a primitive so a caller need not stabilize the array it passes.
  const key = [...new Set(calls.flatMap(citedEvidenceIds))].sort().join(" ");
  const citedIds = useMemo(() => (key === "" ? [] : key.split(" ")), [key]);
  const cites = citedIds.length > 0;

  const { cite, client, threadId } = ledger;
  useEffect(() => {
    if (cites) cite(citedIds);
  }, [cites, citedIds, cite]);

  const [grading, setGrading] = useState<Grading>({ status: "checking" });
  useEffect(() => {
    if (!cites || !client || !threadId) return;
    let live = true;
    setGrading({ status: "checking" });
    client.getInterruptGrounding(threadId, interruptId).then(
      (grounding) => {
        if (live) setGrading(grounding ? { status: "ready", grounding } : { status: "unavailable" });
      },
      () => {
        if (live) setGrading({ status: "unavailable" });
      },
    );
    return () => {
      live = false;
    };
  }, [cites, client, threadId, interruptId]);

  const count = calls.length;
  return useMemo(
    () =>
      Array.from({ length: count }, (_, index) =>
        cites
          ? {
              status: grading.status,
              spans: grading.status === "ready" ? grading.grounding.actions[index]?.spans ?? [] : [],
              hoveredId: ledger.hoveredId,
              onHover: ledger.hover,
              onSelect: ledger.select,
            }
          : undefined,
      ),
    [count, cites, grading, ledger.hoveredId, ledger.hover, ledger.select],
  );
}
