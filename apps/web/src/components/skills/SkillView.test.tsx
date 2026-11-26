import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { SkillCatalogEntryInfo } from "@/api-client";
import { AgentNamesContext } from "../agent-names.js";
import { SkillView } from "./SkillView.js";
import { skillUnlinkAction } from "./skill-actions.js";

const skill: SkillCatalogEntryInfo = {
  id: "calendar",
  name: "Calendar",
  description: "Schedules.",
  source: "plugin",
  enabled: true,
};

function render(entry: SkillCatalogEntryInfo): string {
  const onUnlink = skillUnlinkAction(entry, vi.fn(), vi.fn());
  return renderToStaticMarkup(
    <AgentNamesContext.Provider value={new Map([["google-workspace", "Google Workspace"]])}>
      <SkillView
        skill={entry}
        bundle={null}
        visualState="active"
        statusLabel="Enabled"
        onEdit={vi.fn()}
        onUnlink={onUnlink}
      />
    </AgentNamesContext.Provider>,
  );
}

const custom: SkillCatalogEntryInfo = { ...skill, id: "shared", name: "Shared", source: "user" };
const linked: SkillCatalogEntryInfo = { ...custom, linked: true, linkTarget: "/repos/skills/shared" };

describe("SkillView", () => {
  it("names the agents that mount the skill", () => {
    expect(render({ ...skill, usedBy: ["google-workspace"] })).toContain(">Google Workspace<");
  });

  it("says Pizza Bot reads an unclaimed skill directly", () => {
    expect(render(skill)).toContain("Pizza Bot reads it directly");
  });

  it("offers Edit for an ordinary custom skill", () => {
    expect(render(custom)).toContain("Edit</button>");
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
    expect(skillUnlinkAction(custom, vi.fn(), vi.fn())).toBeUndefined();
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
