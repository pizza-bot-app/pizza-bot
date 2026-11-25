import type { SkillCatalogEntryInfo } from "@/api-client";
import type { ResourceDetailArgs } from "../ResourceModule.js";

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

/** Only a linked user skill can be unlinked; the DELETE route removes just the link. */
export function skillUnlinkAction(
  skill: Pick<SkillCatalogEntryInfo, "id" | "name" | "source" | "linked" | "overrides">,
  confirmAction: ResourceDetailArgs<unknown>["confirmAction"],
  onDelete: (id: string) => Promise<boolean>,
): (() => void) | undefined {
  if (!skill.linked || skill.source !== "user") return undefined;
  return () =>
    void confirmAction(
      `Unlink “${skill.name}”? Only the link is removed; the linked folder stays in place.`,
      () => onDelete(skill.id),
      {
        title: "Unlink skill?",
        confirmLabel: "Unlink",
        destructive: true,
        preserveSelection: Boolean(skill.overrides),
        successMessage: `${skill.name} unlinked`,
      },
    );
}
