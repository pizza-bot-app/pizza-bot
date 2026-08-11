/** Compatibility exports for wildcard tool resolution implemented in core. */
export {
  isWildcard,
  expandToolPattern,
  resolveToolReferences,
  InvalidWildcardError,
} from "@pizza-bot/core";
export type { ToolReference, ToolCatalog, ExpandResult } from "@pizza-bot/core";
