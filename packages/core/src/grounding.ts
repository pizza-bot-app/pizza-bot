/**
 * Citation audit: resolve each cited span to a unique position in the argument it quotes,
 * settle what is decidable without a model, and grade the rest from a judge's verdict whose
 * supporting quotes are checked against the cited body before they are believed.
 */
import { GROUNDING_ARGUMENT, type GroundingSpan } from "./evidence.js";
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
 * Why a span is not `verifiable`. `no-entry`, `figures` and `refuted` accuse the draft, so
 * they read `asserted`; the rest only say the claim was not settled.
 */
export type GroundingGap =
  | { reason: "no-entry" }
  | { reason: "figures"; tokens: string[] }
  | { reason: "refuted" }
  | { reason: "clipped" }
  | { reason: "unjudged" }
  | { reason: "judge-error" }
  | { reason: "unclear" }
  | { reason: "unverified-quote" };

const ACCUSING: ReadonlySet<GroundingGap["reason"]> = new Set(["no-entry", "figures", "refuted"]);

function tierOfGap(gap: GroundingGap | undefined): GroundingTier {
  if (!gap) return "verifiable";
  return ACCUSING.has(gap.reason) ? "asserted" : "inconclusive";
}

/**
 * A cited source as the ledger kept it. `truncated` is load-bearing: what a clipped copy
 * does not contain is unknown, not missing, so the audit must not read it as invention.
 */
export interface CitedSource {
  text: string;
  truncated?: boolean;
}

export type JudgeVerdict = "supported" | "unsupported" | "unclear";

/** A judge's answer for one claim; `quotes` are its claimed support, not yet checked. */
export type JudgeOutcome =
  | { verdict: JudgeVerdict; quotes: string[] }
  | { failed: true };

/** One judging pass, keyed by {@link judgeKey}. */
export interface JudgeResults {
  /** Qualified id of the model that judged, recorded beside every tier it decided. */
  judge: string;
  outcomes: ReadonlyMap<string, JudgeOutcome>;
}

/** A judgement depends only on the claim and its cited entry, so edits elsewhere reuse it. */
export function judgeKey(span: Pick<GroundingSpan, "evidenceId" | "text">): string {
  return `${span.evidenceId}\u0000${span.text}`;
}

export interface GroundingSegment {
  text: string;
  tier: GroundingTier;
  /** Absent on uncited text. */
  evidenceId?: string;
  gap?: GroundingGap;
  /** A figure inside uncited text: the one thing a reviewer must not read as backed. */
  unbacked?: boolean;
  /** The verified passages a `verifiable` span rests on, shown so the reviewer can judge them. */
  support?: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isSpan(value: unknown): value is GroundingSpan {
  return (
    isRecord(value) &&
    typeof value.arg === "string" &&
    typeof value.text === "string" &&
    value.text.length > 0 &&
    typeof value.evidenceId === "string" &&
    value.evidenceId.length > 0
  );
}

/** Citations are model-written, so anything malformed is dropped rather than trusted. */
export function groundingSpans(args: unknown): GroundingSpan[] {
  if (!isRecord(args)) return [];
  const raw = args[GROUNDING_ARGUMENT];
  return Array.isArray(raw) ? raw.filter(isSpan) : [];
}

export function citedEvidenceIds(args: unknown): string[] {
  return [...new Set(groundingSpans(args).map((span) => span.evidenceId))];
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

/**
 * What can be decided without a model. An exact figure the cited body never states is an
 * accusation that needs no opinion; the same absence from a clipped body proves nothing.
 * `undefined` means the claim is left to the judge.
 */
function settle(text: string, source: CitedSource | undefined, canonical: string): GroundingGap | undefined {
  if (source === undefined) return { reason: "no-entry" };
  const missing = figuresOf(text).filter((figure) => !holdsFigure(canonical, figure));
  if (missing.length === 0) return undefined;
  return source.truncated
    ? { reason: "clipped" }
    : { reason: "figures", tokens: missing.map((figure) => figure.display) };
}

/**
 * A judge's "supported" stands only if every quote it gave is in the cited body and the
 * quotes between them state every number the claim does. A quote is checkable; an opinion
 * is not, and a judge will quote "37 minutes" in support of "73 minutes".
 */
function quotesSupport(text: string, quotes: readonly string[], canonical: string): boolean {
  const checked = quotes.map(canonicalize).filter((quote) => quote.length > 0);
  if (checked.length === 0 || checked.length !== quotes.length) return false;
  if (!checked.every((quote) => canonical.includes(quote))) return false;
  const held = checked.join(" \u0000 ");
  if (!figuresOf(text).every((figure) => holdsFigure(held, figure))) return false;
  const stated = numbersOf(held);
  return [...numbersOf(text)].every((value) => stated.has(value));
}

function judgedGap(
  span: GroundingSpan,
  source: CitedSource,
  canonical: string,
  outcome: JudgeOutcome | undefined,
): GroundingGap | undefined {
  if (!outcome || "failed" in outcome) return { reason: "judge-error" };
  if (outcome.verdict === "unclear") return { reason: "unclear" };
  // A judge that finds no support in a clipped body may be looking at the wrong half.
  if (outcome.verdict === "unsupported") {
    return source.truncated ? { reason: "clipped" } : { reason: "refuted" };
  }
  return quotesSupport(span.text, outcome.quotes, canonical)
    ? undefined
    : { reason: "unverified-quote" };
}

export interface AuditedSpan {
  arg: string;
  text: string;
  evidenceId: string;
  tier: GroundingTier;
  gap?: GroundingGap;
  /** The judge that graded this span; absent when nothing but the deterministic checks ran. */
  judge?: string;
  /** The verified passages of the cited body a `verifiable` tier rests on. */
  support?: string[];
}

/** A claim the deterministic checks left open, with the passage a judge should read. */
export interface PendingJudgement {
  key: string;
  claim: string;
  evidenceId: string;
  source: CitedSource;
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

/** Canonicalizes each cited body once, since several spans usually cite the same entry. */
function canonicalBodies(sources: ReadonlyMap<string, CitedSource>): (id: string) => string {
  const cache = new Map<string, string>();
  return (id) => {
    let body = cache.get(id);
    if (body === undefined) {
      body = canonicalize(sources.get(id)?.text ?? "");
      cache.set(id, body);
    }
    return body;
  };
}

/** The claims a judge must see before {@link auditGroundingSpans} can grade them, once each. */
export function pendingJudgements(
  args: unknown,
  sources: ReadonlyMap<string, CitedSource>,
): PendingJudgement[] {
  const { spans, resolved } = resolvedSpans(args);
  const canonical = canonicalBodies(sources);
  const pending = new Map<string, PendingJudgement>();
  for (const span of spans) {
    if (!resolved.has(span)) continue;
    const source = sources.get(span.evidenceId);
    if (!source || settle(span.text, source, canonical(span.evidenceId))) continue;
    const key = judgeKey(span);
    if (!pending.has(key)) pending.set(key, { key, claim: span.text, evidenceId: span.evidenceId, source });
  }
  return [...pending.values()];
}

/**
 * Audits every span the model declared, in declaration order, against the arguments
 * actually being dispatched. Without `judged`, no span can reach `verifiable`: the
 * deterministic checks only ever find reasons to doubt a claim.
 *
 * A span recorded `unresolved` failed to address a unique position in those arguments.
 * Under an `edit` decision that is the reviewer rewriting the quoted text; under `approve`,
 * where nothing changed, it means the model mis-quoted its own draft.
 */
export function auditGroundingSpans(
  args: unknown,
  sources: ReadonlyMap<string, CitedSource>,
  judged?: JudgeResults,
): AuditedSpan[] {
  const { spans, resolved } = resolvedSpans(args);
  const canonical = canonicalBodies(sources);
  return spans.map((span) => {
    const identity = { arg: span.arg, text: span.text, evidenceId: span.evidenceId };
    if (!resolved.has(span)) return { ...identity, tier: "unresolved" };
    const source = sources.get(span.evidenceId);
    const settled = settle(span.text, source, canonical(span.evidenceId));
    if (settled || !source) return { ...identity, tier: tierOfGap(settled), ...(settled ? { gap: settled } : {}) };
    if (!judged) return { ...identity, tier: "inconclusive", gap: { reason: "unjudged" } };
    const outcome = judged.outcomes.get(judgeKey(span));
    const gap = judgedGap(span, source, canonical(span.evidenceId), outcome);
    const support =
      !gap && outcome && !("failed" in outcome) ? { support: outcome.quotes } : {};
    return {
      ...identity,
      tier: tierOfGap(gap),
      ...(gap ? { gap } : {}),
      judge: judged.judge,
      ...support,
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
      evidenceId: span.evidenceId,
      tier: span.tier,
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

export interface ApprovalVerdictSpan extends AuditedSpan {
  /** Evidence identity, kept so the record still means something once the body is gone. */
  breadcrumb?: string;
  bytes?: number;
  truncated?: boolean;
}

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
