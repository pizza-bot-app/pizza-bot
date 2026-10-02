/**
 * The citation audit itself lives in `@pizza-bot/core` so the api-server can recompute
 * it when a human approves, rather than trusting a tier a browser arrived at.
 */
export {
  citedEvidenceIds,
  countGroundedSegments,
  groundingSpans,
  segmentAuditedText,
  segmentGroundedText,
  withoutGroundingArgument,
  type GroundingGap,
  type GroundingSegment,
  type GroundingTier,
} from "@pizza-bot/core";
