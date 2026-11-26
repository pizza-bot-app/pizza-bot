import type { ReactNode } from "react";
import type { SkillBundle, SkillCatalogEntryInfo } from "@/api-client";
import { Bot, BookOpen, FileText, ScrollText, Unlink } from "lucide-react";
import { ProvenanceBadge } from "../ProvenanceBadge.js";
import { CapabilityStatusDot, type CapabilityVisualState } from "../CapabilityControls.js";
import { EditAction, PluginLink, ResourceSection, ResourceView } from "../ResourceView.js";
import { SkeletonLines } from "../ResourceDetailSkeleton.js";
import { L } from "../../lexicon.js";
import { useAgentName } from "../agent-names.js";

export function SkillView({
  skill,
  bundle,
  visualState,
  statusLabel,
  enablement,
  onEdit,
  onUnlink,
  onOpenPlugin,
  onBack,
}: {
  skill: SkillCatalogEntryInfo;
  bundle: SkillBundle | null | undefined;
  visualState: CapabilityVisualState;
  statusLabel: string;
  enablement?: ReactNode;
  onEdit: () => void;
  onUnlink?: () => void;
  onOpenPlugin?: (pluginName: string) => void;
  onBack?: () => void;
}) {
  const shipped = skill.source !== "user";
  const shippedFrom = skill.overrides ?? (shipped ? skill.source : undefined);
  const provenance =
    skill.pluginName && shippedFrom === "plugin" ? (
      <PluginLink
        prefix={skill.overrides ? "customized from plugin" : "from plugin"}
        pluginName={skill.pluginName}
        onOpenPlugin={onOpenPlugin}
      />
    ) : shippedFrom === "builtin" ? (
      <span>{skill.overrides ? "Customized from the built-in version" : "Built in to Pizza Bot"}</span>
    ) : undefined;
  const linkedNote = skill.linked ? (
    <span>Linked from {skill.linkTarget ?? "another folder"}; edit it at the source</span>
  ) : undefined;
  const agentName = useAgentName();

  return (
    <ResourceView
      glyph={<BookOpen size={28} strokeWidth={1.5} />}
      name={skill.name}
      badge={<ProvenanceBadge provenance={skill.source} overrides={skill.overrides} />}
      status={
        <>
          <CapabilityStatusDot state={visualState} label={statusLabel} /> {statusLabel}
        </>
      }
      provenance={linkedNote ?? provenance}
      headerAction={
        !skill.linked ? (
          <EditAction label={shipped ? "Customize" : "Edit"} onEdit={onEdit} />
        ) : onUnlink ? (
          <button type="button" className="btn-secondary" onClick={onUnlink}>
            <Unlink size={14} /> Unlink
          </button>
        ) : undefined
      }
      backLabel={L.skillsSection}
      onBack={onBack}
    >
      <p className="resource-card-lede">{skill.description}</p>
      {enablement}
      <ResourceSection title="Instructions" icon={<ScrollText size={14} />}>
        {bundle === undefined ? (
          <div className="skill-card-body pending">
            <SkeletonLines count={6} />
          </div>
        ) : (
          <pre className="skill-card-body">{bundle?.body.trim() || "(no instructions)"}</pre>
        )}
      </ResourceSection>
      <ResourceSection title="Used by" icon={<Bot size={14} />}>
        {skill.usedBy?.length ? (
          <ul className="resource-chip-list">
            {skill.usedBy.map((id) => (
              <li key={id}>
                <span className="resource-tool-chip">{agentName(id)}</span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="resource-card-empty">No agent mounts this skill, so Pizza Bot reads it directly.</p>
        )}
      </ResourceSection>
      {bundle && bundle.files.length > 0 && (
        <ResourceSection title="Files" icon={<FileText size={14} />}>
          <ul className="skill-card-files">
            {bundle.files.map((file) => (
              <li key={file.path} className="skill-card-file">
                <FileText size={13} /> <code>{file.path}</code>
              </li>
            ))}
          </ul>
        </ResourceSection>
      )}
    </ResourceView>
  );
}
