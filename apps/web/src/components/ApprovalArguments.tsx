import { Fragment, useEffect, useId, useMemo, useRef, useState } from "react";
import type { AuditedSpan, SupportLine } from "@pizza-bot/core";
import {
  groundingSpans,
  segmentAuditedText,
  withoutGroundingArgument,
  type GroundingGap,
  type GroundingSegment,
  type GroundingTier,
} from "@/projection";

type JsonPath = Array<string | number>;

/**
 * What a rendered citation needs beyond its tier: whether the server has graded it yet, and
 * the link back to its evidence card. The stored record renders through this too, always
 * `ready` — a verdict already reached must not be redrawn by what this browser can load now.
 */
export interface GroundingLinks {
  /** `checking` until the server's grading arrives; `unavailable` if it never will. */
  status: "checking" | "ready" | "unavailable";
  hoveredId: string | null;
  onHover: (id: string | null) => void;
  /** Opens the evidence card, with the span's cited lines picked out. */
  onSelect: (id: string, lines?: readonly number[]) => void;
}

/** A live citation: the links, plus the tiers the server graded for this call's spans. */
export interface GroundingView extends GroundingLinks {
  spans: readonly AuditedSpan[];
}

interface ApprovalArgumentsProps {
  value: unknown;
  grounding?: GroundingView | undefined;
}

interface ApprovalArgumentEditorProps {
  value: unknown;
  rawDraft: string;
  rawError: string | null;
  onChange: (value: unknown) => void;
  onRawChange: (value: string) => void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isStructured(value: unknown): value is Record<string, unknown> | unknown[] {
  return isRecord(value) || Array.isArray(value);
}

const LABEL_ACRONYMS = new Set([
  "api",
  "arn",
  "aws",
  "html",
  "http",
  "https",
  "id",
  "json",
  "mcp",
  "sql",
  "uri",
  "url",
]);

export function formatArgumentLabel(key: string): string {
  const tokens = key
    .replace(/[_-]+/g, " ")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((token) => {
      const lower = token.toLowerCase();
      return LABEL_ACRONYMS.has(lower) ? lower.toUpperCase() : lower;
    });
  if (tokens.length === 0) return key;
  if (!LABEL_ACRONYMS.has(tokens[0]!.toLowerCase())) {
    tokens[0] = tokens[0]!.charAt(0).toUpperCase() + tokens[0]!.slice(1);
  }
  return tokens.join(" ");
}

export function updateArgumentAtPath(value: unknown, path: JsonPath, next: unknown): unknown {
  if (path.length === 0) return next;

  const [head, ...tail] = path;
  if (Array.isArray(value) && typeof head === "number") {
    const copy = [...value];
    copy[head] = updateArgumentAtPath(copy[head], tail, next);
    return copy;
  }
  if (isRecord(value) && typeof head === "string") {
    return {
      ...value,
      [head]: updateArgumentAtPath(value[head], tail, next),
    };
  }
  return value;
}

export type ParsedArgumentDraft =
  | { ok: true; value: unknown; error: null }
  | { ok: false; error: string };

export function parseArgumentDraft(draft: string): ParsedArgumentDraft {
  try {
    return { ok: true, value: JSON.parse(draft), error: null };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : "Invalid JSON",
    };
  }
}

function ScalarValue({
  children,
  type,
  empty = false,
  showType = false,
}: {
  children: string;
  type: "Boolean" | "Null" | "Number" | "Text";
  empty?: boolean;
  showType?: boolean;
}) {
  return (
    <span className="approval-argument-scalar">
      <span className={empty ? "approval-argument-empty" : "approval-argument-value"}>
        {children}
      </span>
      {showType && <span className="approval-argument-type">{type}</span>}
    </span>
  );
}

function isAmbiguousText(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  return (
    normalized !== "" &&
    (Number.isFinite(Number(normalized)) ||
      normalized === "true" ||
      normalized === "false" ||
      normalized === "null")
  );
}

function PrimitiveValue({ value }: { value: unknown }) {
  if (value === null) {
    return <ScalarValue type="Null" empty showType>Not set</ScalarValue>;
  }
  if (typeof value === "boolean") {
    return <ScalarValue type="Boolean">{value ? "Yes" : "No"}</ScalarValue>;
  }
  if (typeof value === "number") {
    return <ScalarValue type="Number">{String(value)}</ScalarValue>;
  }
  if (typeof value === "string") {
    return value === "" ? (
      <ScalarValue type="Text" empty showType>
        Empty text
      </ScalarValue>
    ) : (
      <ScalarValue type="Text" showType={isAmbiguousText(value)}>{value}</ScalarValue>
    );
  }
  return <span className="approval-argument-value">{String(value)}</span>;
}

function ArgumentValue({ value }: { value: unknown }) {
  if (Array.isArray(value)) {
    if (value.length === 0) return <span className="approval-argument-empty">None</span>;
    return (
      <ol className="approval-argument-list">
        {value.map((item, index) => (
          <li key={index}>
            <span className="approval-argument-index">{index + 1}</span>
            <ArgumentValue value={item} />
          </li>
        ))}
      </ol>
    );
  }

  if (isRecord(value)) {
    if (Object.keys(value).length === 0) {
      return <span className="approval-argument-empty">None</span>;
    }
    return (
      <dl className="approval-argument-nested">
        {Object.entries(value).map(([key, item]) => (
          <div key={key}>
            <dt title={key}>{formatArgumentLabel(key)}</dt>
            <dd>
              <ArgumentValue value={item} />
            </dd>
          </div>
        ))}
      </dl>
    );
  }

  return <PrimitiveValue value={value} />;
}

/**
 * Two display states sit beside the audited tiers, because neither is a verdict on the
 * draft: a body still in flight, and one the reviewer's browser could not read at all.
 */
export type SpanTier = GroundingTier | "pending" | "unchecked";

/** A figure no citation covers; stated as coverage, since absence is not a falsehood. */
export const UNBACKED_TITLE = "No citation covers this figure, so no source was checked for it.";

/** One wording per tier, so the reviewer's card and the durable record read alike. */
export function groundingTitle(
  tier: SpanTier,
  gap?: GroundingGap,
  support?: readonly SupportLine[],
): string {
  if (tier === "verifiable" && support && support.length > 0) {
    const lines = support.map((line) => `[${line.line}] ${line.text}`).join("\n");
    return `${groundingTitle(tier, gap)}\n\nThe source says:\n${lines}`;
  }
  if (tier === "pending") return "Checking the cited source…";
  if (tier === "unchecked") {
    return "The check could not be loaded, so nothing here was checked.";
  }
  if (tier === "unresolved") {
    return "This quote is not in the text that was sent, so it was never checked against the source.";
  }
  if (tier === "verifiable") {
    return "The claim checker found this in the cited lines of the source. Click to read them.";
  }
  switch (gap?.reason) {
    case "refuted":
      return "The claim checker found that the cited lines do not support this. Click to read them.";
    case "figures":
      return `Not in the cited lines: ${gap.tokens.join(", ")}. Click to read them.`;
    case "bad-lines":
      return "This citation names lines the cited source does not have, so it points at nothing.";
    case "broad-citation":
      return "This cites too much of the source to check, so it was not checked. Click to read it.";
    case "no-entry":
      return "The cited source is not in this thread's ledger.";
    case "unjudged":
      return "Claim checking is off, so this citation was not checked. Turn it on in Settings.";
    case "judge-error":
      return "The claim checker could not be reached, so this was not checked. Click to read the source.";
    case "unclear":
      return "The claim checker could not tell whether the cited source supports this. Click to read it.";
    case "unverified-support":
      return "The claim checker called this supported, but the lines it relied on do not state what the claim does, so the verdict was not trusted. Click to read them.";
    default:
      return "Nothing in this phrase could be checked against the cited source.";
  }
}

function GroundedSpan({
  segment,
  links,
}: {
  segment: GroundingSegment;
  links: GroundingLinks;
}) {
  const id = segment.evidenceId!;
  const tier: SpanTier =
    links.status === "unavailable" ? "unchecked" : links.status === "checking" ? "pending" : segment.tier;
  // A button is an atomic inline box in Chromium, so a multi-word citation would
  // refuse to wrap mid-span; only a real inline element flows with the sentence.
  return (
    <span
      role="button"
      tabIndex={0}
      className={`grounding-span grounding-${tier}${links.hoveredId === id ? " hovered" : ""}`}
      title={groundingTitle(tier, segment.gap, segment.support)}
      onMouseEnter={() => links.onHover(id)}
      onMouseLeave={() => links.onHover(null)}
      onFocus={() => links.onHover(id)}
      onBlur={() => links.onHover(null)}
      onClick={() => links.onSelect(id, segment.lines)}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          links.onSelect(id, segment.lines);
        }
      }}
    >
      {segment.text}
    </span>
  );
}

/** The one place a tier becomes a mark on the page, so every surface reads a tier alike. */
export function GroundedSegments({
  segments,
  links,
}: {
  segments: readonly GroundingSegment[];
  links: GroundingLinks;
}) {
  return (
    <>
      {segments.map((segment, index) =>
        segment.evidenceId !== undefined ? (
          <GroundedSpan key={index} segment={segment} links={links} />
        ) : segment.unbacked ? (
          <span key={index} className="grounding-unbacked" title={UNBACKED_TITLE}>
            {segment.text}
          </span>
        ) : (
          <Fragment key={index}>{segment.text}</Fragment>
        ),
      )}
    </>
  );
}

function GroundedText({
  text,
  spans,
  grounding,
}: {
  text: string;
  spans: readonly AuditedSpan[];
  grounding: GroundingView;
}) {
  const segments = useMemo(() => segmentAuditedText(text, spans), [text, spans]);
  return (
    <span className="approval-argument-scalar">
      <span className="approval-argument-value">
        <GroundedSegments segments={segments} links={grounding} />
      </span>
    </span>
  );
}

export function ApprovalArguments({ value, grounding }: ApprovalArgumentsProps) {
  // Until the server's grading arrives, the declared spans still mark where citations sit.
  const declared = groundingSpans(value);
  const spans: readonly AuditedSpan[] =
    grounding?.status === "ready"
      ? grounding.spans
      : declared.map((span) => ({ ...span, tier: "inconclusive" as const }));
  // Citations are provenance, not content: they annotate the arguments, never join them.
  const shown = withoutGroundingArgument(value);

  if (isRecord(shown)) {
    const entries = Object.entries(shown);
    if (entries.length === 0) {
      return <div className="approval-arguments-empty">No arguments</div>;
    }
    return (
      <dl className="approval-arguments">
        {entries.map(([key, item]) => {
          // A call that cites anything is a grounded call, so every one of its text
          // arguments is read for coverage — including the ones that cite nothing, where
          // an uncovered figure is exactly what would otherwise pass unremarked.
          const cited =
            grounding && typeof item === "string" ? spans.filter((span) => span.arg === key) : [];
          return (
            <div className="approval-argument" key={key}>
              <dt title={key}>{formatArgumentLabel(key)}</dt>
              <dd>
                {grounding && typeof item === "string" && item !== "" ? (
                  <GroundedText text={item} spans={cited} grounding={grounding} />
                ) : (
                  <ArgumentValue value={item} />
                )}
              </dd>
            </div>
          );
        })}
      </dl>
    );
  }

  return (
    <div className="approval-arguments approval-arguments-single">
      <ArgumentValue value={shown} />
    </div>
  );
}

function resizeArgumentTextarea(textarea: HTMLTextAreaElement) {
  textarea.style.height = "auto";
  const borderHeight = textarea.offsetHeight - textarea.clientHeight;
  textarea.style.height = `${Math.min(textarea.scrollHeight + borderHeight, 180)}px`;
}

function TextArgumentField({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
}) {
  const inputId = useId();
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (textareaRef.current) resizeArgumentTextarea(textareaRef.current);
  }, [value]);

  useEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea || typeof ResizeObserver === "undefined") return;

    let width = textarea.getBoundingClientRect().width;
    const observer = new ResizeObserver(() => {
      const nextWidth = textarea.getBoundingClientRect().width;
      if (nextWidth === width) return;
      width = nextWidth;
      resizeArgumentTextarea(textarea);
    });
    observer.observe(textarea);
    return () => observer.disconnect();
  }, []);

  return (
    <label className="approval-field" htmlFor={inputId}>
      <span className="approval-field-label">{label}</span>
      <textarea
        ref={textareaRef}
        id={inputId}
        className="approval-field-text"
        value={value}
        rows={1}
        onChange={(event) => {
          resizeArgumentTextarea(event.currentTarget);
          onChange(event.target.value);
        }}
        spellCheck
        wrap="soft"
      />
    </label>
  );
}

function NumberArgumentField({
  label,
  value,
  onChange,
}: {
  label: string;
  value: number;
  onChange: (value: number) => void;
}) {
  const inputId = useId();
  const [draft, setDraft] = useState(String(value));

  useEffect(() => {
    setDraft(String(value));
  }, [value]);

  const commit = (next: string) => {
    setDraft(next);
    if (next.trim() === "") return;
    const parsed = Number(next);
    if (Number.isFinite(parsed)) onChange(parsed);
  };

  return (
    <label className="approval-field" htmlFor={inputId}>
      <span className="approval-field-label">{label}</span>
      <input
        id={inputId}
        className="approval-field-input"
        type="text"
        inputMode="decimal"
        value={draft}
        onChange={(event) => commit(event.target.value)}
        onBlur={() => {
          const parsed = Number(draft);
          setDraft(
            draft.trim() !== "" && Number.isFinite(parsed) ? String(parsed) : String(value),
          );
        }}
      />
    </label>
  );
}

function NullArgumentField({
  label,
  onChange,
}: {
  label: string;
  onChange: (value: unknown) => void;
}) {
  const inputId = useId();
  return (
    <label className="approval-field" htmlFor={inputId}>
      <span className="approval-field-label">{label}</span>
      <select
        id={inputId}
        className="approval-field-input approval-null-type"
        value="null"
        onChange={(event) => {
          if (event.target.value === "string") onChange("");
          if (event.target.value === "number") onChange(0);
          if (event.target.value === "boolean") onChange(false);
        }}
      >
        <option value="null">Not set</option>
        <option value="string">Text</option>
        <option value="number">Number</option>
        <option value="boolean">Yes / no</option>
      </select>
    </label>
  );
}

function ArgumentField({
  label,
  value,
  path,
  onChange,
}: {
  label: string;
  value: unknown;
  path: JsonPath;
  onChange: (path: JsonPath, value: unknown) => void;
}) {
  if (Array.isArray(value)) {
    return (
      <div className="approval-field approval-field-group">
        <div className="approval-field-label">{label}</div>
        <div className="approval-field-children">
          {value.length === 0 ? (
            <span className="approval-argument-empty">None</span>
          ) : (
            value.map((item, index) => (
              <ArgumentField
                key={index}
                label={`Item ${index + 1}`}
                value={item}
                path={[...path, index]}
                onChange={onChange}
              />
            ))
          )}
        </div>
      </div>
    );
  }

  if (isRecord(value)) {
    return (
      <div className="approval-field approval-field-group">
        <div className="approval-field-label">{label}</div>
        <div className="approval-field-children">
          {Object.keys(value).length === 0 ? (
            <span className="approval-argument-empty">None</span>
          ) : (
            Object.entries(value).map(([key, item]) => (
              <ArgumentField
                key={key}
                label={formatArgumentLabel(key)}
                value={item}
                path={[...path, key]}
                onChange={onChange}
              />
            ))
          )}
        </div>
      </div>
    );
  }

  if (typeof value === "boolean") {
    return (
      <div className="approval-field approval-field-boolean">
        <span className="approval-field-label">{label}</span>
        <label className="approval-boolean-control">
          <input
            type="checkbox"
            checked={value}
            onChange={(event) => onChange(path, event.target.checked)}
          />
          <span>{value ? "Yes" : "No"}</span>
        </label>
      </div>
    );
  }

  if (typeof value === "number") {
    return (
      <NumberArgumentField
        label={label}
        value={value}
        onChange={(next) => onChange(path, next)}
      />
    );
  }

  if (typeof value === "string") {
    return (
      <TextArgumentField
        label={label}
        value={value}
        onChange={(next) => onChange(path, next)}
      />
    );
  }

  if (value === null) {
    return <NullArgumentField label={label} onChange={(next) => onChange(path, next)} />;
  }

  return <PrimitiveValue value={value} />;
}

export function ApprovalArgumentEditor({
  value,
  rawDraft,
  rawError,
  onChange,
  onRawChange,
}: ApprovalArgumentEditorProps) {
  // Editing a quoted argument invalidates its citations, so the fields view hides them;
  // the JSON view still shows them, and edits keep the key because paths are named.
  const shown = withoutGroundingArgument(value);
  const fields = isStructured(shown) ? shown : undefined;
  const supportsFields =
    fields !== undefined && (Array.isArray(fields) ? fields.length > 0 : Object.keys(fields).length > 0);
  const [mode, setMode] = useState<"fields" | "json">(supportsFields ? "fields" : "json");
  const errorId = useId();

  const updateField = (path: JsonPath, next: unknown) => {
    onChange(updateArgumentAtPath(value, path, next));
  };

  return (
    <div className="approval-editor">
      {supportsFields && (
        <div className="approval-editor-modes" role="group" aria-label="Argument editor view">
          <button
            type="button"
            aria-pressed={mode === "fields"}
            aria-disabled={Boolean(rawError)}
            aria-describedby={rawError ? errorId : undefined}
            className={mode === "fields" ? "active" : undefined}
            onClick={() => {
              if (!rawError) setMode("fields");
            }}
          >
            Fields
          </button>
          <button
            type="button"
            aria-pressed={mode === "json"}
            className={mode === "json" ? "active" : undefined}
            onClick={() => setMode("json")}
          >
            JSON
          </button>
        </div>
      )}

      {mode === "fields" && supportsFields && fields ? (
        <div className="approval-fields">
          {Array.isArray(fields) ? (
            fields.map((item, index) => (
              <ArgumentField
                key={index}
                label={`Item ${index + 1}`}
                value={item}
                path={[index]}
                onChange={updateField}
              />
            ))
          ) : (
            Object.entries(fields).map(([key, item]) => (
              <ArgumentField
                key={key}
                label={formatArgumentLabel(key)}
                value={item}
                path={[key]}
                onChange={updateField}
              />
            ))
          )}
        </div>
      ) : (
        <textarea
          className="approval-json-editor"
          rows={Math.min(14, Math.max(5, rawDraft.split("\n").length + 1))}
          value={rawDraft}
          onChange={(event) => onRawChange(event.target.value)}
          aria-invalid={Boolean(rawError)}
          aria-label="Tool arguments as JSON"
          spellCheck={false}
          wrap="soft"
        />
      )}

      {rawError && (
        <span className="approval-editor-error" id={errorId} role="alert">
          {rawError}
        </span>
      )}
    </div>
  );
}
