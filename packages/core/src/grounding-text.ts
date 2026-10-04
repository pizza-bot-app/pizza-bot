/**
 * Text primitives the citation audit and the judge contract share. Internal to core: the
 * package index does not re-export them, so they can change with the audit.
 */

/** One coordinate space for matching: 1,200 reads as 1200, and case and spacing never matter. */
export function canonicalize(text: string): string {
  return text
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/\s+/g, " ")
    .toLowerCase()
    .replace(/(\d),(\d)/g, "$1$2")
    .trim();
}

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

/** Trailing punctuation belongs to the sentence, not to the figure it follows. */
export function trimTrailing(token: string): string {
  return trimEndMatching(token, /[^\p{L}\p{N}%]/u);
}

/**
 * A number specific enough that a source either holds it or does not: an amount, a rate, a
 * year, an identifier. A small bare integer ("2 business days", "March 4") is left to the
 * judge, because the source may spell it as a word or inside a date.
 */
export function isFigure(token: string): boolean {
  return /\d/.test(token) && (/[\p{Sc}%]/u.test(token) || /[.,:/-]\d/.test(token) || /\d{3}/.test(token));
}

export interface Figure {
  /** The span's own spelling, for naming what the source does not contain. */
  display: string;
  needle: string;
}

/** "$1,200.00" cites a body that says 1200 or 1,200.00; the sign and grouping are formatting. */
function figureNeedle(token: string): string {
  return trimEndMatching(token.toLowerCase().replace(/^\D+/, ""), /\D/)
    .replace(/,/g, "")
    .replace(/\.0+$/, "");
}

export function figuresOf(text: string): Figure[] {
  const figures = new Map<string, Figure>();
  for (const raw of text.split(/\s+/)) {
    const token = trimTrailing(raw.replace(/^[^\p{L}\p{N}$€£]+/u, ""));
    if (!isFigure(token)) continue;
    const needle = figureNeedle(token);
    if (needle) figures.set(needle, { display: token, needle });
  }
  return [...figures.values()];
}

function isDigit(char: string | undefined): boolean {
  return char !== undefined && char >= "0" && char <= "9";
}

/** Expects canonical text. A number must not match inside a longer one: 12 is not 120. */
export function holdsFigure(canonical: string, figure: Figure): boolean {
  const { needle } = figure;
  for (let at = canonical.indexOf(needle); at >= 0; at = canonical.indexOf(needle, at + 1)) {
    if (!isDigit(canonical[at - 1]) && !isDigit(canonical[at + needle.length])) return true;
  }
  return false;
}

/**
 * The numbers a text states, by value: "March 4th" and "2027-03-04" both state 4, and a
 * zero that only pads a decimal ("$1,200.00") states nothing.
 */
export function numbersOf(text: string): Set<string> {
  const values = new Set<string>();
  for (const run of canonicalize(text).match(/\d+/g) ?? []) {
    const value = run.replace(/^0+/, "");
    if (value) values.add(value);
  }
  return values;
}

/** Words that appear in any prose prove nothing, so they never localize a claim. */
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

/** Suffixes a draft varies its source's wording by, so "renews" reaches "renewal". */
const SUFFIXES = ["ing", "ion", "ed", "es", "al", "s"];

function stem(word: string): string {
  for (const suffix of SUFFIXES) {
    if (word.length - suffix.length >= 4 && word.endsWith(suffix)) {
      return word.slice(0, word.length - suffix.length);
    }
  }
  return word;
}

/** The content words of a claim, stemmed, for finding where a source talks about it. */
export function contentStems(text: string): string[] {
  const stems = new Set<string>();
  for (const raw of canonicalize(text).split(" ")) {
    const word = raw.replace(/^[^\p{L}]+|[^\p{L}]+$/gu, "");
    if (word.length >= 4 && !COMMON_WORDS.has(word)) stems.add(stem(word));
  }
  return [...stems];
}

const CHUNK = 1_500;
const OVERLAP = 300;

/**
 * The part of a cited body a judge reads for one claim. A whole body fits when it is short;
 * a long one is cut into overlapping chunks and the ones that mention the claim's figures
 * and words are kept, in source order. A judge reading 256 KB to find one sentence misses
 * it, and a passage it was never shown is one it cannot quote.
 */
export function localizePassage(body: string, claim: string, maxChars: number): string {
  if (body.length <= maxChars) return body;
  const figures = figuresOf(claim);
  const stems = contentStems(claim);
  const chunks: Array<{ start: number; text: string; score: number }> = [];
  for (let start = 0; start < body.length; start += CHUNK - OVERLAP) {
    const text = body.slice(start, start + CHUNK);
    const canonical = canonicalize(text);
    const score =
      3 * figures.filter((figure) => holdsFigure(canonical, figure)).length +
      stems.filter((s) => canonical.includes(s)).length;
    chunks.push({ start, text, score });
    if (start + CHUNK >= body.length) break;
  }
  const budget = Math.max(1, Math.floor(maxChars / CHUNK));
  const kept = [...chunks]
    .sort((a, b) => b.score - a.score || a.start - b.start)
    .slice(0, budget)
    .sort((a, b) => a.start - b.start);
  return kept.map((chunk) => chunk.text).join("\n…\n");
}
