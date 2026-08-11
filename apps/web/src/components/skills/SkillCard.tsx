import type { SkillSiblingFile } from "@/api-client";
import { ChevronLeft, FileText, Puzzle, Wrench } from "lucide-react";
import { Badge } from "../ui/badge.js";
import { L } from "../../lexicon.js";
import { SkeletonLines } from "../ResourceDetailSkeleton.js";
import type { ReactNode } from "react";

/**
 * The subset of a skill every list row already carries. Staying narrower than
 * `SkillBundle` is what lets the card paint before the bundle arrives.
 */
export interface SkillCardHeader {
  name: string;
  description: string;
  source: "plugin" | "builtin" | "user";
  pluginName?: string;
  declaredTools: string[];
}

export interface SkillCardContent {
  body: string;
  files: SkillSiblingFile[];
}

export interface SkillCardProps {
  skill: SkillCardHeader;
  /** Null until the bundle resolves; only SKILL.md and the file list wait on it. */
  content: SkillCardContent | null;
  onBack?: () => void;
  enablement?: ReactNode;
}

export function SkillCard({ skill, content, enablement, onBack }: SkillCardProps) {
  const badgeLabel =
    skill.source === "plugin" ? L.pluginBadge : skill.source === "user" ? L.customBadge : L.builtInBadge;

  return (
    <div className="resource-card">
      {onBack && (
        <button className="module-detail-back" onClick={onBack}>
          <ChevronLeft size={18} /> {L.skillsSection}
        </button>
      )}
      <header className="resource-card-head">
        <div className="skill-card-glyph">
          <FileText size={28} strokeWidth={1.5} />
        </div>
        <div className="resource-card-titles">
          <div className="resource-card-name-row">
            <h2 className="resource-card-name">{skill.name}</h2>
            <Badge variant="secondary">{badgeLabel}</Badge>
          </div>
          <p className="resource-card-desc">{skill.description}</p>
          {skill.pluginName && (
            <p className="skill-card-provenance">
              <Puzzle size={13} /> from plugin <code>{skill.pluginName}</code>
            </p>
          )}
        </div>
      </header>

      {enablement}

      <section className="resource-card-section">
        <h3 className="resource-card-section-title">SKILL.md</h3>
        {content ? (
          <pre className="skill-card-body">{content.body || "(empty)"}</pre>
        ) : (
          <div className="skill-card-body pending" aria-busy="true" aria-label="Loading SKILL.md">
            <SkeletonLines count={6} />
          </div>
        )}
      </section>

      {skill.declaredTools.length > 0 && (
        <section className="resource-card-section">
          <h3 className="resource-card-section-title">Tools</h3>
          <ul className="skill-card-files">
            {skill.declaredTools.map((ref) => (
              <li key={ref} className="skill-card-file">
                <Wrench size={13} /> <code>{ref}</code>
              </li>
            ))}
          </ul>
        </section>
      )}

      {content && content.files.length > 0 && (
        <section className="resource-card-section">
          <h3 className="resource-card-section-title">Bundled files</h3>
          <ul className="skill-card-files">
            {content.files.map((f) => (
              <li key={f.path} className="skill-card-file">
                <FileText size={13} /> <code>{f.path}</code>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
