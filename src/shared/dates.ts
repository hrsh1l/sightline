/**
 * Deterministic interpretation of dates printed on food packaging.
 *
 * OWNER: vision agent. Shared by server and (optionally) client, so it uses only standard JS + Intl
 * (no Node-only APIs).
 *
 * Principles:
 *  - The printed text is evidence; this module only interprets it. Callers keep the original string.
 *  - Never guess: day/month order ambiguity is reported as 'ambiguous'; a missing year is 'incomplete'
 *    and no year is invented.
 *  - Notes are neutral descriptions of what was printed. They never judge safety or freshness.
 */
import type { DateInterpretation, DateLabelType } from './protocol.js';

const MONTH_NAMES = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
] as const;

/** English month words (full and common abbreviations) -> month number 1..12. */
const MONTH_WORDS: Record<string, number> = {
  JAN: 1,
  JANUARY: 1,
  FEB: 2,
  FEBRUARY: 2,
  MAR: 3,
  MARCH: 3,
  APR: 4,
  APRIL: 4,
  MAY: 5,
  JUN: 6,
  JUNE: 6,
  JUL: 7,
  JULY: 7,
  AUG: 8,
  AUGUST: 8,
  SEP: 9,
  SEPT: 9,
  SEPTEMBER: 9,
  OCT: 10,
  OCTOBER: 10,
  NOV: 11,
  NOVEMBER: 11,
  DEC: 12,
  DECEMBER: 12,
};
const MONTH_RE = '(JANUARY|FEBRUARY|MARCH|APRIL|MAY|JUNE|JULY|AUGUST|SEPTEMBER|SEPT|OCTOBER|NOVEMBER|DECEMBER|JAN|FEB|MAR|APR|JUN|JUL|AUG|SEP|OCT|NOV|DEC)';

/**
 * Label phrases removed before parsing, longest first. Matched as whole words, case-insensitively,
 * with optional dots between letters for abbreviations (B.B.E., EXP.).
 */
const LABEL_PHRASES = [
  'BEST BEFORE END',
  'BEST BEFORE',
  'BEST BY',
  'BEST IF USED BY',
  'USE BY DATE',
  'USE BY',
  'USE BEFORE',
  'DISPLAY UNTIL',
  'SELL BY',
  'EXPIRY DATE',
  'EXPIRATION DATE',
  'EXPIRY',
  'EXPIRES',
  'EXPIRATION',
  'EXP',
  'PACKED ON',
  'PACKED',
  'PACK DATE',
  'PKD',
  'PRODUCTION DATE',
  'PRODUCED ON',
  'PRODUCED',
  'PROD DATE',
  'PROD',
  'MANUFACTURED ON',
  'MANUFACTURED',
  'MFG',
  'MFD',
  'BBE',
  'BB',
  'END',
  'DATE',
  'ON',
  // Weekday words sometimes precede a date ("SAT 24 NOV"). Not label words, but carry no date information.
  'MONDAY',
  'TUESDAY',
  'WEDNESDAY',
  'THURSDAY',
  'FRIDAY',
  'SATURDAY',
  'SUNDAY',
  'MON',
  'TUE',
  'TUES',
  'WED',
  'THU',
  'THUR',
  'THURS',
  'FRI',
  'SAT',
  'SUN',
] as const;

function phraseRegex(phrase: string): RegExp {
  const words = phrase.split(' ').map((w) => w.split('').join('\\.?') + '\\.?');
  return new RegExp(`(^|[^A-Z0-9])${words.join('\\s*')}(?=$|[^A-Z0-9])`, 'g');
}
const LABEL_REGEXES = LABEL_PHRASES.map(phraseRegex);

/** Upper-case, remove label words and surrounding punctuation. Exported for tests and diagnostics. */
export function stripDateLabelWords(printedText: string): string {
  let s = printedText.toUpperCase().replace(/[‐-―]/g, '-').replace(/\s+/g, ' ').trim();
  // Repeat until stable: "BEST BEFORE: END NOV 2026" needs two passes.
  for (let i = 0; i < 4; i++) {
    const before = s;
    for (const re of LABEL_REGEXES) s = s.replace(re, '$1 ');
    s = s
      .replace(/\s+/g, ' ')
      .replace(/^[\s:;,.\-/]+|[\s:;,\-/]+$/g, '')
      .trim();
    if (s === before) break;
  }
  return s;
}

/** Today's calendar date ('yyyy-mm-dd') in the given IANA time zone. */
export function todayInZone(now: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(now);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}

/** Human-readable current date in the given time zone, e.g. "Monday 23 November 2026" (for prompts). */
export function formatLongDateInZone(now: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone, weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }).formatToParts(now);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  return `${get('weekday')} ${get('day')} ${get('month')} ${get('year')}`;
}

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function isValidDate(year: number, month: number, day: number): boolean {
  return month >= 1 && month <= 12 && day >= 1 && day <= daysInMonth(year, month);
}

const pad = (n: number) => String(n).padStart(2, '0');
const iso = (y: number, m: number, d: number) => `${y}-${pad(m)}-${pad(d)}`;
const spoken = (d: number, m: number, y?: number) => `${d} ${MONTH_NAMES[m - 1]}${y !== undefined ? ` ${y}` : ''}`;

/** Plausible years for packaging dates. Anything else is treated as not-a-date. */
const MIN_YEAR = 1990;
const MAX_YEAR = 2099;

interface YearInfo {
  year: number;
  note: string | null;
}

function expandYear(raw: string): YearInfo | null {
  if (raw.length === 4) {
    const year = Number(raw);
    return year >= MIN_YEAR && year <= MAX_YEAR ? { year, note: null } : null;
  }
  if (raw.length === 2) return { year: 2000 + Number(raw), note: `Year printed as ${raw}, read as 20${raw}` };
  return null;
}

/** Label types for which month+year conventionally means "end of that month". */
const MONTH_YEAR_LABELS: ReadonlySet<DateLabelType> = new Set(['best_before_end']);

type Reading =
  | { kind: 'full'; year: number; month: number; day: number; notes: string[] }
  | { kind: 'month_year'; year: number; month: number; notes: string[] }
  | { kind: 'no_year'; month: number; day: number; notes: string[] }
  | { kind: 'ambiguous'; note: string }
  | { kind: 'invalid'; note: string }
  | { kind: 'none' };

function compare(isoDate: string, today: string): 'past' | 'today' | 'future' {
  if (isoDate === today) return 'today';
  return isoDate < today ? 'past' : 'future';
}

function joinNotes(notes: string[]): string {
  const text = notes.filter(Boolean).join('. ');
  return (text ? `${text}.` : '').slice(0, 200);
}

const unparseable = (note = 'Could not read this as a date'): DateInterpretation => ({
  status: 'unparseable',
  isoDate: null,
  comparison: 'unknown',
  note: joinNotes([note]),
});

/** Interpret two numbers (a, b) printed as day/month or month/day with an optional year. */
function readNumericDayMonth(a: number, b: number, year: YearInfo | null): Reading {
  const yearNotes = year?.note ? [year.note] : [];
  if (a > 12 && b > 12) return { kind: 'invalid', note: 'Not a valid calendar date' };
  // Equal numbers: both orders give the same date.
  let day: number;
  let month: number;
  if (a === b || a > 12) {
    day = a;
    month = b;
  } else if (b > 12) {
    month = a;
    day = b;
  } else {
    const y = year?.year;
    const r1 = spoken(a, b, y);
    const r2 = spoken(b, a, y);
    const tail = year ? (year.note ? `. ${year.note}` : '') : '. Year not printed';
    return { kind: 'ambiguous', note: `Could be ${r1} or ${r2}; day and month order is unclear${tail}` };
  }
  if (!year) {
    // Validate against a leap year so 29/02 without a year is still a possible date.
    if (!isValidDate(2000, month, day)) return { kind: 'invalid', note: 'Not a valid calendar date' };
    return { kind: 'no_year', month, day, notes: [] };
  }
  if (!isValidDate(year.year, month, day)) return { kind: 'invalid', note: 'Not a valid calendar date' };
  return { kind: 'full', year: year.year, month, day, notes: yearNotes };
}

function readDate(text: string, labelType: DateLabelType): Reading {
  // Allow a trailing hh:mm time after a complete date ("24/11/26 14:32"). Anything else with a time
  // (e.g. a batch code "L2341 14:32") is not a date.
  const timed = text.match(/^(.+?)\s+\d{1,2}:\d{2}$/);
  if (timed) {
    const head = readCoreDate(timed[1]!, labelType);
    return head.kind === 'full' ? head : { kind: 'none' };
  }
  return readCoreDate(text, labelType);
}

function readCoreDate(s: string, labelType: DateLabelType): Reading {
  let m: RegExpMatchArray | null;

  // yyyy-mm-dd (also / or .)
  if ((m = s.match(/^(\d{4})([-/.])(\d{1,2})\2(\d{1,2})$/))) {
    const year = expandYear(m[1]!);
    const month = Number(m[3]);
    const day = Number(m[4]);
    if (!year || !isValidDate(year.year, month, day)) return { kind: 'invalid', note: 'Not a valid calendar date' };
    return { kind: 'full', year: year.year, month, day, notes: [] };
  }

  // d/m/yyyy, d.m.yy, d-m-yyyy, "24 11 26" (same separator twice)
  if ((m = s.match(/^(\d{1,2})([-/. ])(\d{1,2})\2(\d{2}|\d{4})$/))) {
    const year = expandYear(m[4]!);
    if (!year) return { kind: 'invalid', note: 'Year is not plausible' };
    return readNumericDayMonth(Number(m[1]), Number(m[3]), year);
  }

  // 24 NOV 2026, 24 Nov 26, 24NOV26, 24th November 2026, 24-NOV-2026, 24 NOV (no year)
  if ((m = s.match(new RegExp(`^(\\d{1,2})(?:ST|ND|RD|TH)?[\\s./-]*${MONTH_RE}\\.?(?:[\\s./,-]*(\\d{4}|\\d{2}))?$`)))) {
    const day = Number(m[1]);
    const month = MONTH_WORDS[m[2]!]!;
    if (m[3] === undefined) {
      if (!isValidDate(2000, month, day)) return { kind: 'invalid', note: 'Not a valid calendar date' };
      return { kind: 'no_year', month, day, notes: [] };
    }
    const year = expandYear(m[3]);
    if (!year) return { kind: 'invalid', note: 'Year is not plausible' };
    if (!isValidDate(year.year, month, day)) return { kind: 'invalid', note: 'Not a valid calendar date' };
    return { kind: 'full', year: year.year, month, day, notes: year.note ? [year.note] : [] };
  }

  // NOVEMBER 24, 2026 / NOV 24 2026 (month word first, then day, then 4-digit year)
  if ((m = s.match(new RegExp(`^${MONTH_RE}\\.?[\\s./-]*(\\d{1,2})(?:ST|ND|RD|TH)?,?[\\s./-]+(\\d{4})$`)))) {
    const month = MONTH_WORDS[m[1]!]!;
    const day = Number(m[2]);
    const year = expandYear(m[3]!);
    if (!year) return { kind: 'invalid', note: 'Year is not plausible' };
    if (!isValidDate(year.year, month, day)) return { kind: 'invalid', note: 'Not a valid calendar date' };
    return { kind: 'full', year: year.year, month, day, notes: [] };
  }

  // NOV 2026, NOV-2026, NOVEMBER 2026
  if ((m = s.match(new RegExp(`^${MONTH_RE}\\.?[\\s./,-]*(\\d{4})$`)))) {
    const year = expandYear(m[2]!);
    if (!year) return { kind: 'invalid', note: 'Year is not plausible' };
    return { kind: 'month_year', year: year.year, month: MONTH_WORDS[m[1]!]!, notes: [] };
  }

  // NOV 26: month word + two digits. Could be "26 November" (no year) or "November 2026".
  if ((m = s.match(new RegExp(`^${MONTH_RE}\\.?[\\s./,-]*(\\d{2})$`)))) {
    const month = MONTH_WORDS[m[1]!]!;
    const n = m[2]!;
    const asYear = expandYear(n)!;
    if (MONTH_YEAR_LABELS.has(labelType)) {
      return { kind: 'month_year', year: asYear.year, month, notes: [`${asYear.note}`, 'Read as month and year because it is a best before end date'] };
    }
    if (!isValidDate(2000, month, Number(n))) return { kind: 'month_year', year: asYear.year, month, notes: [`${asYear.note}`] };
    return { kind: 'ambiguous', note: `Could be ${spoken(Number(n), month)} with no year printed, or ${MONTH_NAMES[month - 1]} ${asYear.year}` };
  }

  // 11/2026, 11 2026, 11.2026 (month + 4-digit year)
  if ((m = s.match(/^(\d{1,2})[-/. ](\d{4})$/))) {
    const month = Number(m[1]);
    const year = expandYear(m[2]!);
    if (!year || month < 1 || month > 12) return { kind: 'invalid', note: 'Not a valid month and year' };
    return { kind: 'month_year', year: year.year, month, notes: [] };
  }

  // Two numbers only: "03.27", "24/11", "03/04". Month-year (2-digit year) or day/month without a year.
  if ((m = s.match(/^(\d{1,2})([-/. ])(\d{2}|\d)$/))) {
    const a = Number(m[1]);
    const b = Number(m[3]);
    const twoDigitSecond = m[3]!.length === 2;
    const monthYearPossible = a >= 1 && a <= 12 && twoDigitSecond;
    if (monthYearPossible && MONTH_YEAR_LABELS.has(labelType)) {
      const year = expandYear(m[3]!)!;
      return { kind: 'month_year', year: year.year, month: a, notes: [`${year.note}`, 'Read as month and year because it is a best before end date'] };
    }
    const dayMonth = readNumericDayMonth(a, b, null);
    if (!monthYearPossible) return dayMonth;
    const year = expandYear(m[3]!)!;
    const monthYearText = `${MONTH_NAMES[a - 1]} ${year.year}`;
    if (dayMonth.kind === 'invalid') {
      // e.g. 03.27: 27 can't be a month, but "27 March" (month/day) or "March 2027" are both possible.
      if (isValidDate(2000, a, b)) return { kind: 'ambiguous', note: `Could be ${monthYearText}, or ${spoken(b, a)} with no year printed` };
      return { kind: 'month_year', year: year.year, month: a, notes: [`${year.note}`] };
    }
    if (dayMonth.kind === 'no_year') {
      return { kind: 'ambiguous', note: `Could be ${spoken(dayMonth.day, dayMonth.month)} with no year printed, or ${monthYearText}` };
    }
    if (dayMonth.kind === 'ambiguous') {
      return { kind: 'ambiguous', note: `Could be ${spoken(a, b)}, ${spoken(b, a)}, or ${monthYearText}; no full date printed` };
    }
    return dayMonth;
  }

  return { kind: 'none' };
}

/**
 * Interpret a printed packaging date. `printedText` may include label words ("USE BY 24 NOV 2026");
 * they are removed before parsing but the caller must keep the original text untouched as evidence.
 * Comparison is against today's date in `timeZone` (calendar dates, not instants).
 */
export function interpretPrintedDate(printedText: string, labelType: DateLabelType, now: Date, timeZone: string): DateInterpretation {
  const core = stripDateLabelWords(printedText ?? '');
  if (!core) return unparseable('No date found in the printed text');
  if (core.length > 40) return unparseable();
  const reading = readDate(core, labelType);
  const today = todayInZone(now, timeZone);
  switch (reading.kind) {
    case 'full': {
      const isoDate = iso(reading.year, reading.month, reading.day);
      return { status: 'parsed', isoDate, comparison: compare(isoDate, today), note: joinNotes(reading.notes) };
    }
    case 'month_year': {
      const isoDate = iso(reading.year, reading.month, daysInMonth(reading.year, reading.month));
      return {
        status: 'parsed',
        isoDate,
        comparison: compare(isoDate, today),
        note: joinNotes(['Month and year only; read as the end of the month', ...reading.notes]),
      };
    }
    case 'no_year':
      return { status: 'incomplete', isoDate: null, comparison: 'unknown', note: joinNotes([`${spoken(reading.day, reading.month)}. Year not printed`]) };
    case 'ambiguous':
      return { status: 'ambiguous', isoDate: null, comparison: 'unknown', note: joinNotes([reading.note]) };
    case 'invalid':
      return unparseable(reading.note);
    case 'none':
      return unparseable();
  }
}

/**
 * Infer a label type from the printed words, used only when the model reported 'unknown'.
 * Returns 'unknown' when no label phrase is recognised.
 */
export function inferDateLabelType(printedText: string): DateLabelType {
  const s = ` ${printedText.toUpperCase().replace(/\./g, '').replace(/\s+/g, ' ')} `;
  if (/\bBEST BEFORE END\b|\bBBE\b/.test(s)) return 'best_before_end';
  if (/\bBEST BEFORE\b|\bBEST BY\b|\bBB\b|\bBEST IF USED BY\b/.test(s)) return 'best_before';
  if (/\bUSE BY\b|\bUSE BEFORE\b/.test(s)) return 'use_by';
  if (/\bDISPLAY UNTIL\b/.test(s)) return 'display_until';
  if (/\bSELL BY\b/.test(s)) return 'sell_by';
  if (/\bPACKED\b|\bPKD\b|\bPACK DATE\b/.test(s)) return 'packed_on';
  if (/\bPRODUCED\b|\bPRODUCTION DATE\b|\bPROD\b|\bMFG\b|\bMFD\b|\bMANUFACTURED\b/.test(s)) return 'production_date';
  if (/\bEXP\b|\bEXPIRY\b|\bEXPIRES\b|\bEXPIRATION\b/.test(s)) return 'expiry_unspecified';
  return 'unknown';
}
