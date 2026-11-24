import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { SkillCatalogEntryInfo } from "@/api-client";
import { SkillView } from "./SkillView.js";
import { skillUnlinkAction } from "./skill-actions.js";

const skill: SkillCatalogEntryInfo = {
  id: "shared",
  name: "Shared",
  description: "Lives in another repo.",
  source: "user",
  declaredTools: [],
  enabled: true,
  status: "ready",
  mcpDependencies: [],
};

function render(entry: SkillCatalogEntryInfo): string {
  const onUnlink = skillUnlinkAction(entry, vi.fn(), vi.fn());
  return renderToStaticMarkup(
    <SkillView
      skill={entry}
      bundle={undefined}
      tools={{ servers: [], builtins: [] }}
      visualState="active"
      statusLabel="Ready"
      onEdit={vi.fn()}
      onUnlink={onUnlink}
    />,
  );
}

const linked = { ...skill, linked: true, linkTarget: "/repos/skills/shared" };

describe("SkillView", () => {
  it("offers Edit for an ordinary custom skill", () => {
    expect(render(skill)).toContain("Edit</button>");
  });

  it("offers Unlink instead of Edit for a linked user skill and names its source folder", () => {
    const html = render(linked);
    expect(html).not.toContain("Edit</button>");
    expect(html).toContain("Unlink</button>");
    expect(html).toContain("Linked from /repos/skills/shared; edit it at the source");
  });

  it("offers no action for a linked built-in skill", () => {
    expect(render({ ...linked, source: "builtin" })).not.toContain("<button");
  });

  it("does not offer Unlink for an ordinary custom skill", () => {
    expect(skillUnlinkAction(skill, vi.fn(), vi.fn())).toBeUndefined();
  });

  it("confirms that only the link is removed, then deletes it", async () => {
    const onDelete = vi.fn(async () => true);
    const confirmAction = vi.fn(async (_message: string, action: () => Promise<unknown>) => {
      await action();
    });

    skillUnlinkAction(linked, confirmAction, onDelete)!();

    expect(confirmAction).toHaveBeenCalledWith(
      "Unlink “Shared”? Only the link is removed; the linked folder stays in place.",
      expect.any(Function),
      expect.objectContaining({ title: "Unlink skill?", confirmLabel: "Unlink", destructive: true }),
    );
    await vi.waitFor(() => expect(onDelete).toHaveBeenCalledWith("shared"));
  });
});
