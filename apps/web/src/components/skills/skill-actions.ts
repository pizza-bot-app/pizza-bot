import type { SkillCatalogEntryInfo } from "@/api-client";

export interface SkillRemovalPresentation {
  title: string;
  label: string;
  confirmLabel: string;
  confirmation: string;
  mode: "delete" | "revert";
}

export function skillRemovalPresentation(
  skill: Pick<SkillCatalogEntryInfo, "overrides">,
): SkillRemovalPresentation {
  if (skill.overrides) {
    const source = skill.overrides === "builtin" ? "built-in" : "plugin";
    return {
      title: "Revert skill?",
      label: `Revert to ${source}`,
      confirmLabel: "Revert",
      confirmation: `Revert this skill to the ${source} version? Your customizations will be removed.`,
      mode: "revert",
    };
  }
  return {
    title: "Delete skill?",
    label: "Delete",
    confirmLabel: "Delete",
    confirmation: "Delete this skill? This can’t be undone.",
    mode: "delete",
  };
}
