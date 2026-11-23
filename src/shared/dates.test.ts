import { describe, expect, it } from 'vitest';
import { DateInterpretation, type DateLabelType } from './protocol.js';
import { formatLongDateInZone, inferDateLabelType, interpretPrintedDate, stripDateLabelWords, todayInZone } from './dates.js';

const LONDON = 'Europe/London';
// Monday 23 November 2026, midday UTC (GMT in London).
const NOW = new Date('2026-11-23T12:00:00Z');

const interp = (text: string, labelType: DateLabelType = 'unknown', now = NOW, tz = LONDON) => {
  const r = interpretPrintedDate(text, labelType, now, tz);
  // Every result must satisfy the shared protocol schema.
  expect(DateInterpretation.parse(r)).toEqual(r);
  return r;
};

describe('todayInZone', () => {
  it('returns the calendar date in the zone, not UTC', () => {
    // 23:30 UTC on 30 June is 00:30 BST on 1 July in London.
    expect(todayInZone(new Date('2026-06-30T23:30:00Z'), LONDON)).toBe('2026-07-01');
    expect(todayInZone(new Date('2026-06-30T23:30:00Z'), 'UTC')).toBe('2026-06-30');
    // In winter London is on GMT (= UTC).
    expect(todayInZone(new Date('2026-12-31T23:30:00Z'), LONDON)).toBe('2026-12-31');
    expect(todayInZone(new Date('2027-01-01T00:30:00Z'), LONDON)).toBe('2027-01-01');
    // West of UTC.
    expect(todayInZone(new Date('2026-11-24T03:00:00Z'), 'America/New_York')).toBe('2026-11-23');
  });

  it('formats a long date for prompts', () => {
    expect(formatLongDateInZone(NOW, LONDON)).toBe('Monday 23 November 2026');
    expect(formatLongDateInZone(new Date('2026-06-30T23:30:00Z'), LONDON)).toBe('Wednesday 1 July 2026');
  });
});

describe('stripDateLabelWords', () => {
  it('removes label words and punctuation', () => {
    expect(stripDateLabelWords('USE BY 24 NOV 2026')).toBe('24 NOV 2026');
    expect(stripDateLabelWords('Best Before End: 03 2027')).toBe('03 2027');
    expect(stripDateLabelWords('B.B.E. 11/2026')).toBe('11/2026');
    expect(stripDateLabelWords('BEST BEFORE: END NOV 2026')).toBe('NOV 2026');
    expect(stripDateLabelWords('Display until 21/11')).toBe('21/11');
    expect(stripDateLabelWords('EXP. 2027-01-31')).toBe('2027-01-31');
    expect(stripDateLabelWords('PACKED ON: 20.11.26')).toBe('20.11.26');
    expect(stripDateLabelWords('BB 24NOV26')).toBe('24NOV26');
  });
});

describe('interpretPrintedDate: unambiguous full dates', () => {
  it.each([
    ['USE BY 24/11/2026', '2026-11-24', 'future'],
    ['24.11.2026', '2026-11-24', 'future'],
    ['24-11-2026', '2026-11-24', 'future'],
    ['2026-11-23', '2026-11-23', 'today'],
    ['2026/11/22', '2026-11-22', 'past'],
    ['24 NOV 2026', '2026-11-24', 'future'],
    ['24 Nov 2026', '2026-11-24', 'future'],
    ['24th November 2026', '2026-11-24', 'future'],
    ['24-NOV-2026', '2026-11-24', 'future'],
    ['November 24, 2026', '2026-11-24', 'future'],
    ['BEST BEFORE 1 JAN 2027', '2027-01-01', 'future'],
    ['SAT 21 NOV 2026', '2026-11-21', 'past'],
    ['13/04/2027', '2027-04-13', 'future'], // first > 12 -> day first
    ['04/13/2027', '2027-04-13', 'future'], // second > 12 -> month first
    ['05/05/2027', '2027-05-05', 'future'], // equal numbers are unambiguous
    ['29/02/2028', '2028-02-29', 'future'], // leap day
    ['USE BY 24/11/26 14:32', '2026-11-24', 'future'], // trailing time ignored after a full date
  ])('%s -> %s (%s)', (text, isoDate, comparison) => {
    const r = interp(text);
    expect(r).toMatchObject({ status: 'parsed', isoDate, comparison });
  });

  it('expands two-digit years to 20yy and says so', () => {
    for (const text of ['24/11/26', '24.11.26', '24 Nov 26', '24NOV26', 'USE BY 24NOV26']) {
      const r = interp(text);
      expect(r.status).toBe('parsed');
      expect(r.isoDate).toBe('2026-11-24');
      expect(r.note).toMatch(/Year printed as 26/);
    }
  });

  it('has an empty note for a plain unambiguous date', () => {
    expect(interp('24 NOV 2026').note).toBe('');
  });
});

describe('interpretPrintedDate: ambiguous day/month order', () => {
  it('reports both readings and does not assume UK order', () => {
    const r = interp('03/04/27', 'use_by');
    expect(r.status).toBe('ambiguous');
    expect(r.isoDate).toBeNull();
    expect(r.comparison).toBe('unknown');
    expect(r.note).toContain('Could be 3 April 2027 or 4 March 2027');
  });

  it('is ambiguous for 4-digit years too', () => {
    const r = interp('BEST BEFORE 01.02.2027');
    expect(r.status).toBe('ambiguous');
    expect(r.note).toContain('1 February 2027');
    expect(r.note).toContain('2 January 2027');
  });
});

describe('interpretPrintedDate: month and year only', () => {
  it.each([
    ['BEST BEFORE END NOV 2026', '2026-11-30', 'future'],
    ['NOVEMBER 2026', '2026-11-30', 'future'],
    ['BBE 11/2026', '2026-11-30', 'future'],
    ['BEST BEFORE END 03 2027', '2027-03-31', 'future'],
    ['02.2028', '2028-02-29', 'future'], // leap-year end of month
    ['OCT 2026', '2026-10-31', 'past'],
  ])('%s -> %s', (text, isoDate, comparison) => {
    const r = interp(text);
    expect(r).toMatchObject({ status: 'parsed', isoDate, comparison });
    expect(r.note).toMatch(/Month and year only/);
  });

  it('treats "03.27" as ambiguous unless the label says best before end', () => {
    const plain = interp('03.27', 'best_before');
    expect(plain.status).toBe('ambiguous');
    expect(plain.note).toContain('March 2027');
    expect(plain.comparison).toBe('unknown');

    const bbe = interp('BEST BEFORE END 03.27', 'best_before_end');
    expect(bbe).toMatchObject({ status: 'parsed', isoDate: '2027-03-31', comparison: 'future' });
    expect(bbe.note).toMatch(/Year printed as 27/);
  });

  it('treats "NOV 26" as ambiguous (26 November or November 2026) unless best before end', () => {
    expect(interp('BEST BEFORE NOV 26', 'best_before').status).toBe('ambiguous');
    expect(interp('BEST BEFORE END NOV 26', 'best_before_end')).toMatchObject({ status: 'parsed', isoDate: '2026-11-30' });
  });

  it('this month counts as future until the month ends', () => {
    expect(interp('NOV 2026').comparison).toBe('future');
    expect(interp('NOV 2026', 'best_before_end', new Date('2026-11-30T12:00:00Z')).comparison).toBe('today');
  });
});

describe('interpretPrintedDate: missing year', () => {
  it.each(['USE BY 24 NOV', 'Display until 21/11', '24th November'])('%s -> incomplete, no invented year', (text) => {
    const r = interp(text);
    expect(r.status).toBe('incomplete');
    expect(r.isoDate).toBeNull();
    expect(r.comparison).toBe('unknown');
    expect(r.note).toMatch(/Year not printed/);
  });

  it('ambiguous order without a year mentions both', () => {
    const r = interp('03/04');
    expect(r.status).toBe('ambiguous');
    expect(r.comparison).toBe('unknown');
  });
});

describe('interpretPrintedDate: invalid and non-dates', () => {
  it.each([
    '31/02/2027', // invalid calendar date
    '29/02/2027', // not a leap year
    '31/04/2026',
    '32 NOV 2026',
    '13/13/2026',
    '2026-13-01',
    'L2341 14:32', // batch code with a time
    '14:32',
    'LOT A12B',
    'L6123',
    'E 500g',
    'BEST BEFORE',
    '',
    '24/11/1850', // implausible year
    '13 2026', // month 13
    'Hello world',
  ])('%s -> unparseable', (text) => {
    const r = interp(text);
    expect(r.status).toBe('unparseable');
    expect(r.isoDate).toBeNull();
    expect(r.comparison).toBe('unknown');
  });

  it('keeps notes neutral (no safety judgement)', () => {
    const texts = ['USE BY 01/01/2020', 'USE BY 24/11/2026', '03/04/27', 'NOV 2026', '24 NOV', 'L2341', '24/11/26'];
    for (const t of texts) {
      const note = interp(t, 'use_by').note.toLowerCase();
      expect(note).not.toMatch(/safe|fresh|expired|throw|discard|eat|spoil|bad|ok\b/);
    }
  });
});

describe('interpretPrintedDate: timezone around midnight', () => {
  it('compares against the London calendar date, not UTC', () => {
    const lateJune = new Date('2026-06-30T23:30:00Z'); // already 1 July 00:30 BST in London
    expect(interp('USE BY 30/06/2026', 'use_by', lateJune).comparison).toBe('past');
    expect(interp('USE BY 1 JUL 2026', 'use_by', lateJune).comparison).toBe('today');
    expect(interp('USE BY 30/06/2026', 'use_by', lateJune, 'UTC').comparison).toBe('today');
  });

  it('GMT in winter: 23:30 UTC on 31 Dec is still 31 Dec in London', () => {
    const nye = new Date('2026-12-31T23:30:00Z');
    expect(interp('31/12/2026', 'use_by', nye).comparison).toBe('today');
    expect(interp('1 JAN 2027', 'use_by', nye).comparison).toBe('future');
  });
});

describe('inferDateLabelType', () => {
  it.each([
    ['USE BY 24 NOV', 'use_by'],
    ['BEST BEFORE END 03 2027', 'best_before_end'],
    ['B.B.E. 11/2026', 'best_before_end'],
    ['BEST BEFORE 24/11/26', 'best_before'],
    ['DISPLAY UNTIL 21/11', 'display_until'],
    ['SELL BY 21/11', 'sell_by'],
    ['PACKED ON 20/11/26', 'packed_on'],
    ['EXP 2027-01', 'expiry_unspecified'],
    ['24/11/26', 'unknown'],
  ] as const)('%s -> %s', (text, type) => {
    expect(inferDateLabelType(text)).toBe(type);
  });
});
