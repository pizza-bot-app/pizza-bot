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
