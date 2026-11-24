import type { ReactNode } from "react";
import type { SkillBundle, SkillCatalogEntryInfo } from "@/api-client";
import { BookOpen, Cable, FileText, Hand, ScrollText, Wrench } from "lucide-react";
import { ProvenanceBadge } from "../ProvenanceBadge.js";
import { CapabilityStatusDot, type CapabilityVisualState } from "../CapabilityControls.js";
import { EditAction, PluginLink, ResourceSection, ResourceView } from "../ResourceView.js";
import { SkeletonLines } from "../ResourceDetailSkeleton.js";
import { L } from "../../lexicon.js";

export function SkillView({
  skill,
  bundle,
  visualState,
  statusLabel,
  enablement,
  onEdit,
  onOpenPlugin,
  onBack,
}: {
  skill: SkillCatalogEntryInfo;
  bundle: SkillBundle | null | undefined;
  visualState: CapabilityVisualState;
  statusLabel: string;
  enablement?: ReactNode;
  onEdit: () => void;
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
  const interruptRefs = Object.keys(bundle?.interruptOn ?? {});

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
      provenance={provenance}
      headerAction={<EditAction label={shipped ? "Customize" : "Edit"} onEdit={onEdit} />}
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
      <ResourceSection title="Tools" icon={<Wrench size={14} />}>
        {skill.declaredTools.length === 0 ? (
          <p className="resource-card-empty">This skill uses only the built-in tools.</p>
        ) : (
          <ul className="resource-chip-list">
            {skill.declaredTools.map((ref) => (
              <li key={ref} className="resource-tool-chip">
                <code>{ref}</code>
              </li>
            ))}
          </ul>
        )}
      </ResourceSection>
      {interruptRefs.length > 0 && (
        <ResourceSection title="Asks before running" icon={<Hand size={14} />}>
          <ul className="resource-chip-list">
            {interruptRefs.map((ref) => (
              <li key={ref} className="resource-tool-chip">
                <code>{ref}</code>
              </li>
            ))}
          </ul>
        </ResourceSection>
      )}
      {skill.mcpDependencies.length > 0 && (
        <ResourceSection title="Requires MCP servers" icon={<Cable size={14} />}>
          <ul className="skill-card-files">
            {skill.mcpDependencies.map((dependency) => (
              <li key={dependency.id} className="skill-card-file">
                <code>{dependency.id}</code>
                <span>{dependency.status === "missing" ? "not configured" : dependency.status}</span>
              </li>
            ))}
          </ul>
        </ResourceSection>
      )}
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
