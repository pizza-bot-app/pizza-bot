/**
 * Deterministic citation audit: resolve each cited span to a unique position in the
 * argument it quotes, then require its rare tokens to co-occur inside one window of the
 * cited body, with matching polarity. Co-occurrence is not entailment.
 */
import { GROUNDING_ARGUMENT, type GroundingSpan } from "./evidence.js";

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
 * Why a span is not `verifiable`. `no-entry` and `tokens` accuse the draft, so they read
 * `asserted`; `polarity`, `scattered` and `clipped` only say the match cannot be trusted.
 */
export type GroundingGap =
  | { reason: "no-entry" }
  | { reason: "tokens"; tokens: string[] }
  | { reason: "polarity" }
  | { reason: "scattered" }
  | { reason: "clipped" };

function tierOfGap(gap: GroundingGap | undefined): GroundingTier {
  if (!gap) return "verifiable";
  return gap.reason === "no-entry" || gap.reason === "tokens" ? "asserted" : "inconclusive";
}

/**
 * A cited source as the ledger kept it. `truncated` is load-bearing: what a clipped copy
 * does not contain is unknown, not missing, so the audit must not read it as invention.
 */
export interface CitedSource {
  text: string;
  truncated?: boolean;
}

export interface GroundingSegment {
  text: string;
  tier: GroundingTier;
  /** Absent on uncited text. */
  evidenceId?: string;
  gap?: GroundingGap;
  /** A figure inside uncited text: the one thing a reviewer must not read as backed. */
  unbacked?: boolean;
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

/** Words that appear in any prose prove nothing, so they are not evidence of a source. */
const COMMON_WORDS = new Set([
  "about", "after", "again", "also", "always", "another", "because", "been", "before",
  "being", "below", "both", "cannot", "come", "could", "dear", "does", "doing", "done",
  "down", "during", "each", "either", "else", "even", "ever", "every", "from", "further",
  "give", "going", "gone", "have", "having", "hello", "help", "here", "hope", "into",
  "just", "keep", "kind", "know", "less", "like", "look", "made", "make", "many", "more",
  "most", "much", "must", "need", "next", "once", "only", "other", "over", "please",
  "regards", "same", "should", "since", "some", "such", "sure", "take", "than", "thanks",
  "that", "their", "them", "then", "there", "these", "they", "thing", "think", "this",
  "those", "through", "time", "under", "until", "upon", "very", "want", "well", "were",
  "what", "when", "where", "which", "while", "will", "with", "without", "would", "your",
]);

/**
 * Drops the trailing characters `unwanted` matches. An end-anchored `[^…]+$` does the same
 * in quadratic time, and the text it runs on can echo whatever a tool returned.
 */
function trimEndMatching(token: string, unwanted: RegExp): string {
  let end = token.length;
  while (end > 0) {
    const width =
      end > 1 && /[\uDC00-\uDFFF]/.test(token[end - 1]!) && /[\uD800-\uDBFF]/.test(token[end - 2]!)
        ? 2
        : 1;
    if (!unwanted.test(token.slice(end - width, end))) break;
    end -= width;
  }
  return token.slice(0, end);
}

function trimPunctuation(token: string): string {
  return trimTrailing(token.replace(/^[^\p{L}\p{N}$€£]+/u, ""));
}

interface TokenProbe {
  /** The span's own spelling, for naming what the body does not contain. */
  display: string;
  needle: string;
  numeric: boolean;
}

interface SpanProbes {
  /** Specifics a source either states or does not: numbers, amounts, dates, names, ids. */
  facts: TokenProbe[];
  /** Content words; a draft paraphrases, so only wholesale absence is meaningful. */
  words: TokenProbe[];
}

/** Suffixes a draft varies its source's wording by, so "renews" reaches "renewal". */
const SUFFIXES = ["ing", "ion", "ed", "es", "al", "s"];
const MIN_STEM = 4;
const MIN_WORD = 4;

function stem(word: string): string {
  for (const suffix of SUFFIXES) {
    if (word.length - suffix.length >= MIN_STEM && word.endsWith(suffix)) {
      return word.slice(0, word.length - suffix.length);
    }
  }
  return word;
}

const ORDINAL = /^(\d+)(?:st|nd|rd|th)$/i;

/** "March 4th" cites a body that says "March 4"; "$1,200.00" cites one that says 1200.00. */
function numberNeedle(token: string): string {
  const ordinal = ORDINAL.exec(token);
  if (ordinal) return ordinal[1]!;
  return trimEndMatching(token.replace(/^\D+/, ""), /\D/).replace(/,/g, "");
}

function endsSentence(raw: string): boolean {
  return /[.!?]["')\]]?$/.test(raw);
}

function spanProbes(text: string): SpanProbes {
  const facts = new Map<string, TokenProbe>();
  const words = new Map<string, TokenProbe>();
  // A capital after a sentence break is grammar, not a name.
  let atSentenceStart = true;
  for (const raw of text.split(/\s+/)) {
    const token = trimPunctuation(raw);
    const startsSentence = atSentenceStart;
    if (raw) atSentenceStart = endsSentence(raw);
    if (!token) continue;
    const lower = token.toLowerCase();
    if (/\d/.test(token)) {
      facts.set(token, { display: token, needle: numberNeedle(lower), numeric: true });
      continue;
    }
    // A name is a specific, so it is matched as written rather than stemmed.
    if (!startsSentence && /\p{Lu}/u.test(token)) {
      facts.set(token, { display: token, needle: lower, numeric: false });
      continue;
    }
    if (token.length >= MIN_WORD && !COMMON_WORDS.has(lower)) {
      words.set(token, { display: token, needle: stem(lower), numeric: false });
    }
  }
  return { facts: [...facts.values()], words: [...words.values()] };
}

/** One coordinate space for the audit: windows are offsets into it, 1,200 reads as 1200. */
function canonicalize(body: string): string {
  return body.replace(/\s+/g, " ").toLowerCase().replace(/(\d),(\d)/g, "$1$2");
}

function isDigit(char: string | undefined): boolean {
  return char !== undefined && char >= "0" && char <= "9";
}

function findNeedle(body: string, probe: TokenProbe, from: number): number {
  if (!probe.numeric) return body.indexOf(probe.needle, from);
  // A number must not match inside a longer one: 12 is not evidence for 120.
  for (let at = body.indexOf(probe.needle, from); at >= 0; at = body.indexOf(probe.needle, at + 1)) {
    if (!isDigit(body[at - 1]) && !isDigit(body[at + probe.needle.length])) return at;
  }
  return -1;
}

/** Occurrences recorded per token; past this it is too frequent to localize anything. */
const MAX_OFFSETS = 64;
/** Windows tested per span, so a frequent anchor cannot make the audit superlinear. */
const MAX_WINDOWS = 24;
/** Half-width in characters of the window a short span gets. */
const MIN_RADIUS = 100;

interface ProbeHits {
  probe: TokenProbe;
  /** Ascending and capped; empty means the body does not hold the token at all. */
  offsets: number[];
  /** Over the cap, so every window is credited with it rather than scanned again. */
  frequent: boolean;
}

function probeHits(body: string, probe: TokenProbe): ProbeHits {
  const offsets: number[] = [];
  for (let at = findNeedle(body, probe, 0); at >= 0; at = findNeedle(body, probe, at + 1)) {
    offsets.push(at);
    if (offsets.length === MAX_OFFSETS) return { probe, offsets, frequent: true };
  }
  return { probe, offsets, frequent: false };
}

function anywhere(hits: ProbeHits): boolean {
  return hits.offsets.length > 0;
}

interface Extent {
  start: number;
  end: number;
}

/** The occurrence nearest `near`, so a repeated word is read where the claim sits. */
function nearestIn(hits: ProbeHits, window: Extent, near: number): Extent | undefined {
  let best: Extent | undefined;
  for (const at of hits.offsets) {
    const end = at + hits.probe.needle.length;
    if (at < window.start || end > window.end) continue;
    if (!best || Math.abs(at - near) < Math.abs(best.start - near)) best = { start: at, end };
  }
  return best;
}

/**
 * How far past the specifics a matched word may sit. A content word further out than this
 * belongs to another clause, and crediting it would stretch the passage over sentences the
 * claim never touched — which is how a lone shared word imports a negation.
 */
const WORD_REACH = 48;

/**
 * The stretch a window's matched tokens actually occupy. Tokens too frequent to have
 * recorded offsets count as present without widening it.
 */
function matchedExtent(
  facts: readonly ProbeHits[],
  words: readonly ProbeHits[],
  window: Extent,
  seed: Extent,
): Extent | undefined {
  const near = (seed.start + seed.end) / 2;
  let { start, end } = seed;
  for (const hits of facts) {
    const at = nearestIn(hits, window, near);
    if (!at) {
      if (!hits.frequent) return undefined;
      continue;
    }
    start = Math.min(start, at.start);
    end = Math.max(end, at.end);
  }
  // Specifics localize the claim, so wording is looked for beside them rather than
  // anywhere in the window, and one word cannot widen the reach of the next.
  const beside = {
    start: Math.max(window.start, start - WORD_REACH),
    end: Math.min(window.end, end + WORD_REACH),
  };
  let missing = 0;
  for (const hits of words) {
    const at = nearestIn(hits, beside, near);
    if (!at) {
      if (!hits.frequent) missing += 1;
      continue;
    }
    start = Math.min(start, at.start);
    end = Math.max(end, at.end);
  }
  return missing * 2 <= words.length ? { start, end } : undefined;
}

/**
 * Specifics are absolute; wording is not, because a draft rewords its source — requiring
 * every content word makes real drafts uniformly non-green.
 */
function heldSomewhere(facts: readonly ProbeHits[], words: readonly ProbeHits[]): boolean {
  return (
    facts.every(anywhere) && words.filter((h) => !anywhere(h)).length * 2 <= words.length
  );
}

/** The token with the fewest occurrences localizes best; absent ones cannot anchor. */
function anchor(hits: readonly ProbeHits[]): ProbeHits | undefined {
  let best: ProbeHits | undefined;
  for (const candidate of hits) {
    if (!anywhere(candidate)) continue;
    if (!best || candidate.offsets.length < best.offsets.length) best = candidate;
  }
  return best;
}

/**
 * Cues that flip a claim. An incidental hit costs a green badge, which is the cheaper
 * error: scope is undecidable here, so matched words sitting beside one are not trusted.
 */
const NEGATION_CUE =
  /(?:^|[^\p{L}\p{N}])(?:no|not|never|cannot|without|denied|declines?|declined|unable|ineligible|refused|expired|revoked|voided?)(?:[^\p{L}\p{N}]|$)/u;

/** Expects lowercase text. */
function isNegated(text: string): boolean {
  return NEGATION_CUE.test(text) || text.includes("n't") || text.includes("n’t");
}

/**
 * Characters of reach a cue is read at. A cue only bears on words it sits beside, and a
 * record that says "not" once elsewhere says nothing about the rest of its own contents.
 */
const CUE_REACH = 12;

function auditSpan(text: string, body: string): GroundingGap | undefined {
  const { facts, words } = spanProbes(text);
  // Nothing rare enough to look for means nothing was proven either way.
  if (facts.length === 0 && words.length === 0) return { reason: "tokens", tokens: [] };
  const factHits = facts.map((probe) => probeHits(body, probe));
  const wordHits = words.map((probe) => probeHits(body, probe));
  if (!heldSomewhere(factHits, wordHits)) {
    return {
      reason: "tokens",
      tokens: [...factHits, ...wordHits].filter((h) => !anywhere(h)).map((h) => h.probe.display),
    };
  }
  const rarest = anchor([...factHits, ...wordHits]);
  if (!rarest) return { reason: "scattered" };
  const radius = Math.max(text.length, MIN_RADIUS);
  const negated = isNegated(text.toLowerCase());
  let localized = false;
  for (const at of rarest.offsets.slice(0, MAX_WINDOWS)) {
    const seed = { start: at, end: at + rarest.probe.needle.length };
    const window = {
      start: Math.max(0, seed.start - radius),
      end: seed.end + radius,
    };
    const extent = matchedExtent(factHits, wordHits, window, seed);
    if (!extent) continue;
    const claim = body.slice(Math.max(0, extent.start - CUE_REACH), extent.end + CUE_REACH);
    if (isNegated(claim) === negated) return undefined;
    localized = true;
  }
  return localized ? { reason: "polarity" } : { reason: "scattered" };
}

/**
 * A gap that rests on the span's words being absent, which a source stored only in part
 * cannot establish. Finding a contradiction is not absence, so `polarity` still stands.
 */
function restsOnAbsence(gap: GroundingGap): boolean {
  return gap.reason === "scattered" || (gap.reason === "tokens" && gap.tokens.length > 0);
}

/** Canonicalizes each cited body once, since several spans usually cite the same entry. */
function spanAuditor(
  sources: ReadonlyMap<string, CitedSource>,
): (span: GroundingSpan) => GroundingGap | undefined {
  const canonical = new Map<string, string>();
  return (span) => {
    const source = sources.get(span.evidenceId);
    if (source === undefined) return { reason: "no-entry" };
    let body = canonical.get(span.evidenceId);
    if (body === undefined) {
      body = canonicalize(source.text);
      canonical.set(span.evidenceId, body);
    }
    const gap = auditSpan(span.text, body);
    // Accusing a draft of inventing what the ledger simply did not keep would be a
    // fabrication of its own: the words may sit in the part that was cut.
    if (gap && source.truncated && restsOnAbsence(gap)) return { reason: "clipped" };
    return gap;
  };
}

/** Trailing punctuation belongs to the sentence, not to the figure it follows. */
function trimTrailing(token: string): string {
  return trimEndMatching(token, /[^\p{L}\p{N}%]/u);
}

/**
 * A number specific enough that a source either holds it or does not: an amount, a rate, a
 * year, an identifier. A small bare integer ("2 business days", "Section 1") is left alone,
 * because marking every one of them spends the reviewer's attention where nothing hides.
 */
function isFigure(token: string): boolean {
  return /[\p{Sc}%]/u.test(token) || /[.,:/-]\d/.test(token) || /\d{3}/.test(token);
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
    if (!/\d/.test(figure) || !isFigure(figure)) continue;
    const start = match.index;
    if (start > cursor) segments.push({ text: text.slice(cursor, start), tier: "uncited" });
    segments.push({ text: figure, tier: "uncited", unbacked: true });
    cursor = start + figure.length;
  }
  if (cursor < text.length) segments.push({ text: text.slice(cursor), tier: "uncited" });
  return segments;
}

function segmentByTier<T extends GroundingSpan>(
  text: string,
  spans: readonly T[],
  tierOf: (span: T) => { tier: GroundingTier; gap?: GroundingGap },
): GroundingSegment[] {
  const segments: GroundingSegment[] = [];
  let cursor = 0;
  for (const { span, start, end } of resolveSpans(text, spans)) {
    if (start > cursor) segments.push(...uncitedSegments(text.slice(cursor, start)));
    segments.push({
      text: text.slice(start, end),
      evidenceId: span.evidenceId,
      ...tierOf(span),
    });
    cursor = end;
  }
  if (cursor < text.length) segments.push(...uncitedSegments(text.slice(cursor)));
  return segments;
}

/**
 * Splits one argument's text into consecutive segments, each carrying the tier the
 * reviewer should read it at. Concatenating the segments reproduces the text exactly.
 */
export function segmentGroundedText(
  text: string,
  spans: readonly GroundingSpan[],
  sources: ReadonlyMap<string, CitedSource>,
): GroundingSegment[] {
  const audit = spanAuditor(sources);
  return segmentByTier(text, spans, (span) => {
    const gap = audit(span);
    return { tier: tierOfGap(gap), ...(gap ? { gap } : {}) };
  });
}

/**
 * The same split, replaying tiers a prior audit reached instead of grading again. A
 * reviewer must be able to read what the audit said when the action went out, even once
 * the cited source has changed or gone.
 */
export function segmentAuditedText(
  text: string,
  spans: readonly AuditedSpan[],
): GroundingSegment[] {
  return segmentByTier(text, spans, (span) => ({
    tier: span.tier,
    ...(span.gap ? { gap: span.gap } : {}),
  }));
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

export interface AuditedSpan {
  arg: string;
  text: string;
  evidenceId: string;
  tier: GroundingTier;
  gap?: GroundingGap;
}

/**
 * Audits every span the model declared, in declaration order, against the arguments
 * actually being dispatched. The reviewer's screen and the durable approval record
 * both run this, so neither can report a tier the other would not.
 *
 * A span recorded `unresolved` failed to address a unique position in those arguments.
 * Under an `edit` decision that is the reviewer rewriting the quoted text; under `approve`,
 * where nothing changed, it means the model mis-quoted its own draft.
 */
export function auditGroundingSpans(
  args: unknown,
  sources: ReadonlyMap<string, CitedSource>,
): AuditedSpan[] {
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
  const audit = spanAuditor(sources);
  return spans.map((span) => {
    const identity = { arg: span.arg, text: span.text, evidenceId: span.evidenceId };
    if (!resolved.has(span)) return { ...identity, tier: "unresolved" };
    const gap = audit(span);
    return {
      ...identity,
      tier: tierOfGap(gap),
      ...(gap ? { gap } : {}),
    };
  });
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
