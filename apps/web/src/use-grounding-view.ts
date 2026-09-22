/**
 * Subscribes the evidence ledger to whatever ids a set of tool arguments cite, so a
 * pending approval and the settled call it becomes read citations the same way.
 */
import { useEffect, useMemo } from "react";
import { citedEvidenceIds } from "@/projection";
import type { GroundingView } from "./components/ApprovalArguments.js";
import { useEvidence } from "./use-evidence.js";

export function useGroundingView(args: readonly unknown[]): GroundingView | undefined {
  const ledger = useEvidence();
  // Memoized on a primitive so a caller need not stabilize the array it passes.
  const key = [...new Set(args.flatMap(citedEvidenceIds))].sort().join(" ");
  const citedIds = useMemo(() => (key === "" ? [] : key.split(" ")), [key]);

  const { cite } = ledger;
  useEffect(() => {
    if (citedIds.length > 0) cite(citedIds);
  }, [citedIds, cite]);

  return useMemo<GroundingView | undefined>(() => {
    if (citedIds.length === 0) return undefined;
    // A body still in flight must not be reported as a missing source; one the server
    // would not hand over is only unreadable while its entry is still in the ledger,
    // since an id that is not there at all is the audit's own missing-source case.
    const listed = (id: string) =>
      !ledger.loaded || ledger.entries.some((entry) => entry.id === id);
    const pending = new Set(
      citedIds.filter((id) => !ledger.bodies.has(id) && !ledger.unavailable.has(id) && listed(id)),
    );
    const unavailable = new Set(citedIds.filter((id) => ledger.unavailable.has(id) && listed(id)));
    return {
      bodies: ledger.bodies,
      pending,
      unavailable,
      hoveredId: ledger.hoveredId,
      onHover: ledger.hover,
      onSelect: ledger.select,
    };
  }, [citedIds, ledger]);
}
