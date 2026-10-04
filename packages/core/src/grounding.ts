/**
 * Citation audit: resolve each cited span to a unique position in the argument it quotes,
 * settle what is decidable from the evidence lines it cites, and grade the rest from a
 * judge's verdict, believed only through cited lines that state the claim's numbers.
 */
import { GROUNDING_ARGUMENT, type Citation, type GroundingSpan } from "./evidence.js";
import { parseEvidenceLines } from "./evidence-lines.js";
import { canonicalize, figuresOf, holdsFigure, isFigure, numbersOf, trimTrailing } from "./grounding-text.js";

/**
 * `uncited` is text no span claims. `unresolved` is the opposite failure: a span was
 * declared but its quote does not address the arguments being dispatched.
 */
export type GroundingTier =
  | "verifiable"
  | "inconclusive"
  | "asserted"
  | "uncited"
  | "unresolved";

/**
 * Why a span is not `verifiable`. `no-entry`, `bad-lines`, `figures` and `refuted` accuse the
 * citation, so they read `asserted`; the rest only say the claim was not settled.
 */
export type GroundingGap =
  | { reason: "no-entry" }
  | { reason: "bad-lines" }
  | { reason: "figures"; tokens: string[] }
  | { reason: "refuted" }
  | { reason: "broad-citation" }
  | { reason: "unjudged" }
  | { reason: "judge-error" }
  | { reason: "unclear" }
  | { reason: "unverified-support" };

const ACCUSING: ReadonlySet<GroundingGap["reason"]> = new Set([
  "no-entry",
  "bad-lines",
  "figures",
  "refuted",
]);

/** A claim resting on more lines than this is a pointer at a document, not a citation. */
export const MAX_CITED_LINES = 12;
/** A sentence joins facts from a few lookups; more than this is not one claim. */
export const MAX_CITED_SOURCES = 4;

function tierOfGap(gap: GroundingGap | undefined): GroundingTier {
  if (!gap) return "verifiable";
  return ACCUSING.has(gap.reason) ? "asserted" : "inconclusive";
}

/**
 * A cited source as the ledger kept it: the numbered text the model read. A clipped entry
 * holds only the lines that were kept, so a citation can only ever name lines that exist.
 */
export interface CitedSource {
  text: string;
  truncated?: boolean;
}

export type JudgeVerdict = "supported" | "unsupported" | "unclear";

/**
 * A judge's answer for one claim. `lines` are the labels ({@link labelSupportLines}) of the
 * cited lines it says support the claim, not yet checked.
 */
export type JudgeOutcome =
  | { verdict: JudgeVerdict; lines: string[] }
  | { failed: true };

/** One judging pass, keyed by {@link judgeKey}. */
export interface JudgeResults {
  /** Qualified id of the model that judged, recorded beside every tier it decided. */
  judge: string;
  outcomes: ReadonlyMap<string, JudgeOutcome>;
}

/** A judgement depends only on the claim and the lines it cites, so edits elsewhere reuse it. */
export function judgeKey(span: Pick<GroundingSpan, "text" | "cites">): string {
  const cites = span.cites.map((cite) => `${cite.evidenceId}:${cite.lines.join(",")}`).join(";");
  return `${span.text}\u0000${cites}`;
}

export interface GroundingSegment {
  text: string;
  tier: GroundingTier;
  /** The evidence the span cites, so a reviewer can be taken straight to it; absent on uncited text. */
  cites?: Citation[];
  gap?: GroundingGap;
  /** A figure inside uncited text: the one thing a reviewer must not read as backed. */
  unbacked?: boolean;
  /** The cited lines a `verifiable` span rests on, shown so the reviewer can judge them. */
  support?: SupportLine[];
}

export interface SupportLine {
  evidenceId: string;
  line: number;
  text: string;
}

/**
 * Labels cited lines for a judge: a letter per source in citation order, then the line
 * number, so `A3` and `B3` stay distinct when a claim joins two lookups.
 */
export function labelSupportLines(lines: readonly SupportLine[]): Map<string, SupportLine> {
  const letters = new Map<string, string>();
  const labelled = new Map<string, SupportLine>();
  for (const line of lines) {
    let letter = letters.get(line.evidenceId);
    if (!letter) {
      letter = String.fromCharCode(65 + letters.size);
      letters.set(line.evidenceId, letter);
    }
    labelled.set(`${letter}${line.line}`, line);
  }
  return labelled;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * The line numbers a citation names, ascending and once each. Anything that is not a positive
 * integer empties the list, which the audit reports as a citation naming no real line.
 */
function lineNumbers(lines: unknown): number[] {
  if (!Array.isArray(lines) || !lines.every((n) => Number.isSafeInteger(n) && n > 0)) return [];
  return [...new Set(lines as number[])].sort((a, b) => a - b);
}

/**
 * One citation per entry, so a source named twice reads as one source with both sets of lines.
 * An unusable line list poisons its entry: the citation cannot be checked as the model wrote it.
 */
function citations(raw: unknown): Citation[] {
  if (!Array.isArray(raw)) return [];
  const byEntry = new Map<string, number[]>();
  for (const cite of raw) {
    if (!isRecord(cite) || typeof cite.evidenceId !== "string" || cite.evidenceId === "") continue;
    const lines = lineNumbers(cite.lines);
    const seen = byEntry.get(cite.evidenceId);
    if (seen === undefined) byEntry.set(cite.evidenceId, lines);
    else if (seen.length === 0 || lines.length === 0) byEntry.set(cite.evidenceId, []);
    else byEntry.set(cite.evidenceId, [...new Set([...seen, ...lines])].sort((a, b) => a - b));
  }
  return [...byEntry].map(([evidenceId, lines]) => ({ evidenceId, lines }));
}

/**
 * Citations are model-written: a span with no usable quote or no named entry is dropped, and
 * one whose line numbers are unusable is kept so the reviewer sees the citation failed.
 */
export function groundingSpans(args: unknown): GroundingSpan[] {
  if (!isRecord(args)) return [];
  const raw = args[GROUNDING_ARGUMENT];
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((span) => {
    if (!isRecord(span) || typeof span.arg !== "string" || typeof span.text !== "string" || !span.text) return [];
    const cites = citations(span.cites);
    return cites.length > 0 ? [{ arg: span.arg, text: span.text, cites }] : [];
  });
}

export function citedEvidenceIds(args: unknown): string[] {
  return [...new Set(groundingSpans(args).flatMap((span) => span.cites.map((cite) => cite.evidenceId)))];
}

/** Citations are provenance, not content: an arguments view must not render them. */
export function withoutGroundingArgument(args: unknown): unknown {
  if (!isRecord(args) || !(GROUNDING_ARGUMENT in args)) return args;
  const { [GROUNDING_ARGUMENT]: _spans, ...rest } = args;
  return rest;
}

interface ResolvedSpan<T extends GroundingSpan = GroundingSpan> {
  span: T;
  start: number;
  end: number;
}

/** A quote that is absent or occurs twice does not resolve: guessing mislabels a clause. */
function resolveSpans<T extends GroundingSpan>(
  text: string,
  spans: readonly T[],
): ResolvedSpan<T>[] {
  const resolved: ResolvedSpan<T>[] = [];
  for (const span of spans) {
    const start = text.indexOf(span.text);
    if (start < 0 || text.indexOf(span.text, start + 1) >= 0) continue;
    resolved.push({ span, start, end: start + span.text.length });
  }
  resolved.sort((a, b) => a.start - b.start || b.end - a.end);
  const kept: ResolvedSpan<T>[] = [];
  for (const candidate of resolved) {
    const last = kept[kept.length - 1];
    if (last && candidate.start < last.end) continue;
    kept.push(candidate);
  }
  return kept;
}

interface CitedLines {
  lines: SupportLine[];
  canonical: string;
}

/**
 * What can be decided without a model. A citation naming lines the entry does not have, or
 * an exact figure none of its cited lines states, is an accusation that needs no opinion.
 * `undefined` means the claim is left to the judge.
 */
function settle(span: GroundingSpan, cited: CitedLines | undefined): GroundingGap | undefined {
  const { text } = span;
  if (!cited) return { reason: "no-entry" };
  if (cited.lines.length === 0) return { reason: "bad-lines" };
  if (cited.lines.length > MAX_CITED_LINES || span.cites.length > MAX_CITED_SOURCES) {
    return { reason: "broad-citation" };
  }
  const missing = figuresOf(text).filter((figure) => !holdsFigure(cited.canonical, figure));
  return missing.length > 0
    ? { reason: "figures", tokens: missing.map((figure) => figure.display) }
    : undefined;
}

/**
 * A judge's "supported" stands only if it names cited lines, and those lines state every
 * number the claim does. A line label is checkable; an opinion is not, and a judge will
 * call "37 minutes" support for "73 minutes".
 */
function supportFor(text: string, cited: CitedLines, labels: readonly string[]): SupportLine[] | undefined {
  const byLabel = labelSupportLines(cited.lines);
  const support = [...new Set(labels)].map((label) => byLabel.get(label));
  if (support.length === 0 || support.some((line) => line === undefined)) return undefined;
  const held = canonicalize(support.map((line) => line!.text).join(" \u0000 "));
  if (!figuresOf(text).every((figure) => holdsFigure(held, figure))) return undefined;
  const stated = numbersOf(held);
  if (![...numbersOf(text)].every((value) => stated.has(value))) return undefined;
  return support as SupportLine[];
}

function judged(
  span: GroundingSpan,
  cited: CitedLines,
  outcome: JudgeOutcome | undefined,
): { gap?: GroundingGap; support?: SupportLine[] } {
  if (!outcome || "failed" in outcome) return { gap: { reason: "judge-error" } };
  if (outcome.verdict === "unclear") return { gap: { reason: "unclear" } };
  if (outcome.verdict === "unsupported") return { gap: { reason: "refuted" } };
  const support = supportFor(span.text, cited, outcome.lines);
  return support ? { support } : { gap: { reason: "unverified-support" } };
}

/** A citation as audited, with the identity of its entry kept so a record outlives the body. */
export interface AuditedCitation extends Citation {
  breadcrumb?: string;
  bytes?: number;
  truncated?: boolean;
}

export interface AuditedSpan {
  arg: string;
  text: string;
  cites: AuditedCitation[];
  tier: GroundingTier;
  gap?: GroundingGap;
  /** The judge that graded this span; absent when nothing but the deterministic checks ran. */
  judge?: string;
  /** The cited lines a `verifiable` tier rests on, kept so the record outlives the body. */
  support?: SupportLine[];
}

/** A claim the deterministic checks left open, with the only lines a judge may read. */
export interface PendingJudgement {
  key: string;
  claim: string;
  lines: SupportLine[];
}

function resolvedSpans(args: unknown): { spans: GroundingSpan[]; resolved: Set<GroundingSpan> } {
  const spans = groundingSpans(args);
  const values = isRecord(args) ? args : {};
  const byArg = new Map<string, GroundingSpan[]>();
  for (const span of spans) {
    const list = byArg.get(span.arg);
    if (list) list.push(span);
    else byArg.set(span.arg, [span]);
  }
  const resolved = new Set<GroundingSpan>();
  for (const [arg, argSpans] of byArg) {
    const value = values[arg];
    if (typeof value !== "string") continue;
    for (const hit of resolveSpans(value, argSpans)) resolved.add(hit.span);
  }
  return { spans, resolved };
}

/**
 * The lines a span cites across all its entries. `undefined` when an entry is missing; an
 * empty list when any citation names no line or a line its entry does not have.
 */
function citedLinesReader(
  sources: ReadonlyMap<string, CitedSource>,
): (span: GroundingSpan) => CitedLines | undefined {
  // Parsed once per entry, since several spans usually cite the same one.
  const parsed = new Map<string, Map<number, string>>();
  const linesOf = (id: string): Map<number, string> | undefined => {
    const source = sources.get(id);
    if (source === undefined) return undefined;
    let lines = parsed.get(id);
    if (!lines) {
      lines = parseEvidenceLines(source.text);
      parsed.set(id, lines);
    }
    return lines;
  };
  return (span) => {
    const cited: SupportLine[] = [];
    let valid = true;
    for (const cite of span.cites) {
      const lines = linesOf(cite.evidenceId);
      if (!lines) return undefined;
      if (cite.lines.length === 0 || cite.lines.some((n) => !lines.has(n))) valid = false;
      else for (const line of cite.lines) cited.push({ evidenceId: cite.evidenceId, line, text: lines.get(line)! });
    }
    if (!valid) return { lines: [], canonical: "" };
    return { lines: cited, canonical: canonicalize(cited.map((line) => line.text).join("\n")) };
  };
}

/** The claims a judge must see before {@link auditGroundingSpans} can grade them, once each. */
export function pendingJudgements(
  args: unknown,
  sources: ReadonlyMap<string, CitedSource>,
): PendingJudgement[] {
  const { spans, resolved } = resolvedSpans(args);
  const read = citedLinesReader(sources);
  const pending = new Map<string, PendingJudgement>();
  for (const span of spans) {
    if (!resolved.has(span)) continue;
    const cited = read(span);
    if (!cited || settle(span, cited)) continue;
    const key = judgeKey(span);
    if (!pending.has(key)) pending.set(key, { key, claim: span.text, lines: cited.lines });
  }
  return [...pending.values()];
}

/**
 * Audits every span the model declared, in declaration order, against the arguments
 * actually being dispatched. Without `results`, no span can reach `verifiable`: the
 * deterministic checks only ever find reasons to doubt a claim.
 *
 * A span recorded `unresolved` failed to address a unique position in those arguments.
 * Under an `edit` decision that is the reviewer rewriting the quoted text; under `approve`,
 * where nothing changed, it means the model mis-quoted its own draft.
 */
export function auditGroundingSpans(
  args: unknown,
  sources: ReadonlyMap<string, CitedSource>,
  results?: JudgeResults,
): AuditedSpan[] {
  const { spans, resolved } = resolvedSpans(args);
  const read = citedLinesReader(sources);
  return spans.map((span) => {
    const identity = { arg: span.arg, text: span.text, cites: span.cites };
    if (!resolved.has(span)) return { ...identity, tier: "unresolved" };
    const cited = read(span);
    const settled = settle(span, cited);
    if (settled || !cited) return { ...identity, tier: tierOfGap(settled), ...(settled ? { gap: settled } : {}) };
    if (!results) return { ...identity, tier: "inconclusive", gap: { reason: "unjudged" } };
    const { gap, support } = judged(span, cited, results.outcomes.get(judgeKey(span)));
    return {
      ...identity,
      tier: tierOfGap(gap),
      ...(gap ? { gap } : {}),
      judge: results.judge,
      ...(support ? { support } : {}),
    };
  });
}

/**
 * Text no span claims, with its figures marked out. A citation audit grades only what was
 * cited, so an uncited amount or date is the one place a fabrication can hide in plain prose.
 */
function uncitedSegments(text: string): GroundingSegment[] {
  const segments: GroundingSegment[] = [];
  let cursor = 0;
  for (const match of text.matchAll(/\S+/gu)) {
    const figure = trimTrailing(match[0]);
    if (!isFigure(figure)) continue;
    const start = match.index;
    if (start > cursor) segments.push({ text: text.slice(cursor, start), tier: "uncited" });
    segments.push({ text: figure, tier: "uncited", unbacked: true });
    cursor = start + figure.length;
  }
  if (cursor < text.length) segments.push({ text: text.slice(cursor), tier: "uncited" });
  return segments;
}

/**
 * Splits one argument's text into consecutive segments at the tiers an audit reached, so a
 * reviewer reads what was decided when the action was graded, even once the cited source
 * has changed or gone. Concatenating the segments reproduces the text exactly.
 */
export function segmentAuditedText(
  text: string,
  spans: readonly AuditedSpan[],
): GroundingSegment[] {
  const segments: GroundingSegment[] = [];
  let cursor = 0;
  for (const { span, start, end } of resolveSpans(text, spans)) {
    if (start > cursor) segments.push(...uncitedSegments(text.slice(cursor, start)));
    segments.push({
      text: text.slice(start, end),
      tier: span.tier,
      cites: span.cites.map(({ evidenceId, lines }) => ({ evidenceId, lines })),
      ...(span.gap ? { gap: span.gap } : {}),
      ...(span.support ? { support: span.support } : {}),
    });
    cursor = end;
  }
  if (cursor < text.length) segments.push(...uncitedSegments(text.slice(cursor)));
  return segments;
}

export function countGroundedSegments(
  segments: readonly GroundingSegment[],
): { verifiable: number; inconclusive: number; asserted: number } {
  return {
    verifiable: segments.filter((segment) => segment.tier === "verifiable").length,
    inconclusive: segments.filter((segment) => segment.tier === "inconclusive").length,
    asserted: segments.filter((segment) => segment.tier === "asserted").length,
  };
}

/** A decision that dispatches the action under review; reject and respond do not. */
export type ApprovalDecision = "approve" | "edit";

/** A span as the approval record keeps it; its citations carry their entries' identities. */
export type ApprovalVerdictSpan = AuditedSpan;

export interface ApprovalVerdict {
  seq: number;
  verdictId: string;
  threadId: string;
  /** The run that carried out the approved action, not the one that paused. */
  runId: string;
  interruptId: string;
  toolName: string;
  decision: ApprovalDecision;
  /**
   * The arguments as dispatched, without their citations. The audit grades only cited
   * spans, so without the text they sat in an uncited fabrication leaves no trace at all.
   */
  args?: unknown;
  spans: ApprovalVerdictSpan[];
  createdAt: string;
}
