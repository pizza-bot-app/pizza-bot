import { L } from "../lexicon.js";

export type Provenance = "user" | "plugin" | "builtin";
export type ShippedProvenance = Exclude<Provenance, "user">;

const LABEL: Record<Provenance, string> = {
  user: L.customBadge,
  plugin: L.pluginBadge,
  builtin: L.builtInBadge,
};

export function provenanceBadgeLabel(
  provenance: Provenance,
  overrides?: ShippedProvenance,
): string {
  return provenance === "user" && overrides ? L.customizedBadge : LABEL[provenance];
}

export function ProvenanceBadge({
  provenance,
  overrides,
}: {
  provenance: Provenance;
  overrides?: ShippedProvenance;
}) {
  const label = provenanceBadgeLabel(provenance, overrides);
  const title =
    provenance === "user" && overrides
      ? `User customization of a ${overrides === "builtin" ? "built-in" : "plugin"} skill`
      : undefined;
  return (
    <span className={`provenance-badge ${provenance}`} title={title}>
      {label}
    </span>
  );
}
