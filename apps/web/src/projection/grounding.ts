/**
 * The citation audit lives in `@pizza-bot/core` and runs on the server; the web only splits
 * text at the tiers the server reached, so the card and the record cannot disagree.
 */
export {
  citedEvidenceIds,
  countGroundedSegments,
  groundingSpans,
  segmentAuditedText,
  withoutGroundingArgument,
  type GroundingGap,
  type GroundingSegment,
  type GroundingTier,
} from "@pizza-bot/core";
