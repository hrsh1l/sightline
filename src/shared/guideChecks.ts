/**
 * Instruction companion: deterministic faithfulness checks for spoken step text. Pure (no I/O); usable by the server
 * and the UI. OWNER: vision agent.
 *
 * The vision model writes a short `spoken` version of each printed step. Numbers and units are what matter most in
 * printed instructions (times, temperatures, power levels, amounts, screw sizes), so the server checks that every
 * number/unit in `spoken` appears in `sourceText` and that no number in `sourceText` is dropped. Any mismatch replaces
 * `spoken` with the verbatim source text. The check is deliberately conservative: anything it cannot match counts as a
 * mismatch, and a mismatch only ever falls back to the printed text.
 *
 * Out of scope (not checked): word order, conditions ("if frozen"), and non-numeric wording.
 */
import { GUIDE_LIMITS } from './guide.js';

export interface NumberToken {
  /** Normalised display form, e.g. "3 min", "190 °C", "800 W", "Gas 5", "M4", "1/2", "2 x", "1:30". */
  token: string;
  /** Comparison key: kind + numeric value + canonical unit (so "0.5" equals "1/2", "3 mins" equals "3 minutes"). */
  key: string;
}

// ---------------------------------------------------------------------------
// Normalisation
// ---------------------------------------------------------------------------

const UNICODE_FRACTIONS: Record<string, string> = {
  '½': '1/2',
  '⅓': '1/3',
  '⅔': '2/3',
  '¼': '1/4',
  '¾': '3/4',
  '⅕': '1/5',
  '⅖': '2/5',
  '⅗': '3/5',
  '⅘': '4/5',
  '⅙': '1/6',
  '⅚': '5/6',
  '⅛': '1/8',
  '⅜': '3/8',
  '⅝': '5/8',
  '⅞': '7/8',
};

const SMALL_NUMBERS = [
  'zero',
  'one',
  'two',
  'three',
  'four',
  'five',
  'six',
  'seven',
  'eight',
  'nine',
  'ten',
  'eleven',
  'twelve',
  'thirteen',
  'fourteen',
  'fifteen',
  'sixteen',
  'seventeen',
  'eighteen',
  'nineteen',
];
const TENS: Record<string, number> = { twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90 };
const UNITS_1_9 = SMALL_NUMBERS.slice(1, 10);

const WORD_NUMBER_RE = new RegExp(
  String.raw`\b(?:(${Object.keys(TENS).join('|')})(?:[- ](${UNITS_1_9.join('|')}))?|(${SMALL_NUMBERS.join('|')}))\b`,
  'gi',
);

function wordsToDigits(text: string): string {
  return text
    .replace(WORD_NUMBER_RE, (_m, tens: string | undefined, unit: string | undefined, small: string | undefined) => {
      if (tens) return String(TENS[tens.toLowerCase()]! + (unit ? SMALL_NUMBERS.indexOf(unit.toLowerCase()) : 0));
      return String(SMALL_NUMBERS.indexOf(small!.toLowerCase()));
    })
    .replace(/\bminus\s+(?=\d)/gi, '-')
    .replace(/\bhalf\b/gi, '1/2')
    .replace(/\b(\d+)\s+and\s+an?\s+1\/2\b/gi, '$1 1/2') // "one and a half" -> "1 1/2"
    .replace(/\b1\/2\s+an?\s+(hour|minute)\b/gi, '1/2 $1'); // "half an hour" -> "1/2 hour"
}

function normalise(text: string): string {
  let s = text
    .replace(/[\u00a0\u2000-\u200b\u202f]/g, ' ')
    .replace(/[\u2010-\u2015\u2212]/g, '-')
    .replace(/\u2044/g, '/')
    .replace(/×/g, 'x')
    .replace(/[º˚]/g, '°');
  s = s.replace(/(\d)?\s?([½⅓⅔¼¾⅕⅖⅗⅘⅙⅚⅛⅜⅝⅞])/g, (_m, whole: string | undefined, f: string) => `${whole ? `${whole} ` : ' '}${UNICODE_FRACTIONS[f]}`);
  // Thousands separators ("1,000W") then decimal commas ("1,5 l").
  for (let i = 0; i < 3; i++) s = s.replace(/(\d),(\d{3})(?!\d)/g, '$1$2');
  s = s.replace(/(\d),(\d{1,2})(?!\d)/g, '$1.$2');
  return wordsToDigits(s);
}

// ---------------------------------------------------------------------------
// Tokenising
// ---------------------------------------------------------------------------

/** Alias -> canonical unit. Matching is case-insensitive except bare C/F (see below). */
const UNIT_ALIASES: Record<string, string> = {
  minutes: 'min',
  minute: 'min',
  mins: 'min',
  min: 'min',
  seconds: 's',
  second: 's',
  secs: 's',
  sec: 's',
  s: 's',
  hours: 'h',
  hour: 'h',
  hrs: 'h',
  hr: 'h',
  h: 'h',
  watts: 'W',
  watt: 'W',
  w: 'W',
  kw: 'kW',
  '%': '%',
  millilitres: 'ml',
  millilitre: 'ml',
  milliliters: 'ml',
  milliliter: 'ml',
  ml: 'ml',
  cl: 'cl',
  litres: 'l',
  litre: 'l',
  liters: 'l',
  liter: 'l',
  ltr: 'l',
  l: 'l',
  grams: 'g',
  gram: 'g',
  g: 'g',
  kilograms: 'kg',
  kilogram: 'kg',
  kg: 'kg',
  mg: 'mg',
  oz: 'oz',
  lbs: 'lb',
  lb: 'lb',
  tablespoons: 'tbsp',
  tablespoon: 'tbsp',
  tbsp: 'tbsp',
  tbs: 'tbsp',
  teaspoons: 'tsp',
  teaspoon: 'tsp',
  tsp: 'tsp',
  cups: 'cup',
  cup: 'cup',
  pints: 'pint',
  pint: 'pint',
  millimetres: 'mm',
  millimeters: 'mm',
  mm: 'mm',
  centimetres: 'cm',
  centimeters: 'cm',
  cm: 'cm',
  metres: 'm',
  meters: 'm',
  m: 'm',
  x: 'x',
  // Bare scale letter directly after a number ("190C"); only uppercase counts (checked after matching).
  c: '°C',
  f: '°F',
};

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const UNIT_ALT = Object.keys(UNIT_ALIASES)
  .sort((a, b) => b.length - a.length)
  .map(escapeRe)
  .join('|');
const SCALE = String.raw`(?:celsius|centigrade|fahrenheit|c|f)`;

/**
 * sign:   a "-" attached to the number and not preceded by a digit ("-18°C"; "4-5" is a range).
 * number: time "1:30" | mixed "1 1/2" | fraction "1/2" | decimal "1.5" | integer.
 * unit:   "°" or "degrees" with an optional scale | a known unit alias. Units must not run into further letters.
 */
const NUM_RE = new RegExp(
  String.raw`(?<![A-Za-z0-9.])(-(?=\d))?(\d{1,2}:\d{2}(?!\d)|\d+\s+\d+/\d+|\d+/\d+|\d+(?:\.\d+)?)(?:\s*(°(?:\s*${SCALE}(?![a-z]))?|deg(?:ree)?s?(?![a-z])(?:\s*${SCALE}(?![a-z]))?|(?:${UNIT_ALT})(?![a-z])))?`,
  'gi',
);
const GAS_RE = /\bgas(?:\s+mark)?\s*(\d+(?:\.\d+)?)(?:\s*(?:-|to|or)\s*(\d+(?:\.\d+)?))?/gi;
/** Metric screw/bolt sizes ("M4"); uppercase only so "4m" / "m" (metres) are not confused. */
const SCREW_RE = /\bM(\d+(?:\.\d+)?)\b/g;
/** "x2" style multipliers. */
const TIMES_PREFIX_RE = /(?<![A-Za-z0-9])x(\d+)\b/gi;

interface RawToken extends NumberToken {
  start: number;
  end: number;
  unit: string | null;
  kind: 'n' | 'gas' | 'screw';
  numKey: string;
  display: string;
}

function numberValue(raw: string): { display: string; numKey: string } {
  const t = raw.replace(/\s+/g, ' ').trim();
  if (t.startsWith('-')) {
    const v = numberValue(t.slice(1));
    return { display: `-${v.display}`, numKey: `-${v.numKey}` };
  }
  const s = t;
  if (/^\d{1,2}:\d{2}$/.test(s)) {
    const [h, m] = s.split(':');
    return { display: `${Number(h)}:${m}`, numKey: `t${Number(h)}:${m}` };
  }
  const mixed = /^(\d+) (\d+)\/(\d+)$/.exec(s);
  if (mixed) {
    const [, w, a, b] = mixed;
    const v = Number(w) + Number(a) / Number(b);
    return { display: `${Number(w)} ${Number(a)}/${Number(b)}`, numKey: keyOf(v) };
  }
  const frac = /^(\d+)\/(\d+)$/.exec(s);
  if (frac) {
    const [, a, b] = frac;
    return { display: `${Number(a)}/${Number(b)}`, numKey: Number(b) === 0 ? `f${a}/${b}` : keyOf(Number(a) / Number(b)) };
  }
  const v = Number(s);
  return { display: String(v), numKey: keyOf(v) };
}

const keyOf = (v: number) => String(Math.round(v * 1e6) / 1e6);

function canonicalUnit(raw: string | undefined): string | null {
  if (!raw) return null;
  const r = raw.replace(/\s+/g, '').toLowerCase();
  if (r.startsWith('°') || r.startsWith('deg')) {
    const scale = r.replace(/^°|^deg(?:ree)?s?/, '');
    if (!scale) return '°';
    return scale.startsWith('f') ? '°F' : '°C';
  }
  // Bare "c"/"f" only counts when printed uppercase ("190C"); lowercase is too ambiguous.
  if (r === 'c' || r === 'f') return raw.trim() === raw.trim().toUpperCase() ? UNIT_ALIASES[r]! : null;
  return UNIT_ALIASES[r] ?? null;
}

function displayOf(kind: RawToken['kind'], display: string, unit: string | null): string {
  if (kind === 'gas') return `Gas ${display}`;
  if (kind === 'screw') return `M${display}`;
  return unit ? `${display} ${unit}` : display;
}

function makeToken(kind: RawToken['kind'], rawNumber: string, unit: string | null, start: number, end: number): RawToken {
  const { display, numKey } = numberValue(rawNumber);
  return { kind, unit, start, end, display, numKey, token: displayOf(kind, display, unit), key: `${kind}|${numKey}|${unit ?? ''}` };
}

function rawTokens(text: string): RawToken[] {
  let s = normalise(text);
  const out: RawToken[] = [];
  const blank = (m: RegExpExecArray) => {
    s = s.slice(0, m.index) + ' '.repeat(m[0].length) + s.slice(m.index + m[0].length);
  };
  for (const m of [...s.matchAll(GAS_RE)]) {
    out.push(makeToken('gas', m[1]!, null, m.index, m.index + m[0].length));
    if (m[2]) out.push(makeToken('gas', m[2], null, m.index, m.index + m[0].length));
    blank(m);
  }
  for (const m of [...s.matchAll(SCREW_RE)]) {
    out.push(makeToken('screw', m[1]!, null, m.index, m.index + m[0].length));
    blank(m);
  }
  for (const m of [...s.matchAll(TIMES_PREFIX_RE)]) {
    out.push(makeToken('n', m[1]!, 'x', m.index, m.index + m[0].length));
    blank(m);
  }
  const numeric: RawToken[] = [];
  for (const m of s.matchAll(NUM_RE)) numeric.push(makeToken('n', `${m[1] ?? ''}${m[2]!}`, canonicalUnit(m[3]), m.index, m.index + m[0].length));
  // Ranges share the unit printed after the last number: "4-5 minutes", "4 to 5 minutes" -> 4 min, 5 min.
  for (let i = numeric.length - 2; i >= 0; i--) {
    const a = numeric[i]!;
    const b = numeric[i + 1]!;
    if (a.unit === null && b.unit && b.unit !== 'x' && /^\s*(?:-|to|or|\/)\s*$/i.test(s.slice(a.end, b.start))) {
      numeric[i] = { ...a, unit: b.unit, token: displayOf(a.kind, a.display, b.unit), key: `${a.kind}|${a.numKey}|${b.unit}` };
    }
  }
  out.push(...numeric);
  return out.sort((a, b) => a.start - b.start);
}

/** Normalised number/unit tokens in reading order, e.g. "Heat for 1 minute 30 seconds at 800W" -> ["1 min", "30 s", "800 W"]. */
export function numberTokens(text: string): string[] {
  return rawTokens(text).map((t) => t.token);
}

/** Tokens with comparison keys (for callers that compare texts). */
export function numberTokenDetails(text: string): NumberToken[] {
  return rawTokens(text).map(({ token, key }) => ({ token, key }));
}

/** Remove a leading list marker ("1.", "2)", "(3)", "Step 4:") which is layout, not content. */
export function stripLeadingEnumerator(text: string): string {
  return text.replace(/^\s*(?:(?:step\s*)?\(?\d{1,2}[.)]\s+(?=\S)|\(\d{1,2}\)\s*|step\s+\d{1,2}\s*[:.-]\s*)/i, '');
}

// ---------------------------------------------------------------------------
// Faithfulness
// ---------------------------------------------------------------------------

export interface SpokenCheck {
  faithful: boolean;
  /** Tokens in spoken that are not in the source (changed/added numbers or units). */
  extra: string[];
  /** Source tokens missing from spoken (dropped numbers, or fewer repetitions than printed). */
  dropped: string[];
}

export function checkSpoken(spoken: string, sourceText: string): SpokenCheck {
  if (!spoken.trim()) return { faithful: false, extra: [], dropped: numberTokens(stripLeadingEnumerator(sourceText)) };
  const said = numberTokenDetails(stripLeadingEnumerator(spoken));
  const printed = numberTokenDetails(stripLeadingEnumerator(sourceText));
  const printedKeys = new Set(printed.map((t) => t.key));
  const extra = said.filter((t) => !printedKeys.has(t.key)).map((t) => t.token);
  const counts = new Map<string, number>();
  for (const t of said) counts.set(t.key, (counts.get(t.key) ?? 0) + 1);
  const dropped: string[] = [];
  for (const t of printed) {
    const n = counts.get(t.key) ?? 0;
    if (n > 0) counts.set(t.key, n - 1);
    else dropped.push(t.token);
  }
  return { faithful: extra.length === 0 && dropped.length === 0, extra, dropped };
}

/** Every number/unit token in spoken appears in sourceText, and no number in sourceText is dropped from spoken. */
export function spokenIsFaithful(spoken: string, sourceText: string): boolean {
  return checkSpoken(spoken, sourceText).faithful;
}

/** Trim to `max` chars at a word boundary, adding an ellipsis when cut. */
export function trimToLimit(text: string, max: number = GUIDE_LIMITS.maxSpokenChars): string {
  const s = text.replace(/\s+/g, ' ').trim();
  if (s.length <= max) return s;
  const cut = s.slice(0, max - 1);
  const space = cut.lastIndexOf(' ');
  return `${(space > max / 2 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

export interface EnforcedSpoken<T> {
  step: T;
  /** True when spoken was replaced by the (trimmed) source text. */
  replaced: boolean;
  /** Counts only, for metadata logging (never the text itself). */
  extraCount: number;
  droppedCount: number;
}

/**
 * If `spoken` is not faithful to `sourceText`, replace it with the source text (without a leading list marker,
 * trimmed to GUIDE_LIMITS.maxSpokenChars). Returns a new object; the input is not mutated.
 */
export function enforceFaithfulSpoken<T extends { spoken: string; sourceText: string }>(step: T): EnforcedSpoken<T> {
  const check = checkSpoken(step.spoken, step.sourceText);
  if (check.faithful && step.spoken.trim().length <= GUIDE_LIMITS.maxSpokenChars) {
    return { step: { ...step, spoken: step.spoken.trim() }, replaced: false, extraCount: 0, droppedCount: 0 };
  }
  const plain = stripLeadingEnumerator(step.sourceText).trim() || step.sourceText.trim();
  return { step: { ...step, spoken: trimToLimit(plain) }, replaced: true, extraCount: check.extra.length, droppedCount: check.dropped.length };
}
