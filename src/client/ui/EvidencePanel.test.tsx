// @vitest-environment jsdom
import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { makeEvidence } from './__fixtures__/fakeController.js';
import { EvidencePanel } from './EvidencePanel.js';

afterEach(cleanup);

describe('EvidencePanel', () => {
  it('separates exact label text from interpretation', () => {
    render(<EvidencePanel evidence={makeEvidence()} />);
    const exact = screen.getByRole('region', { name: 'Exact text read from the label' });
    const interp = screen.getByRole('region', { name: 'Interpretation' });

    expect(within(exact).getByText('Tomato Soup')).toBeTruthy();
    expect(within(exact).getByText('Microwave 800W: 2 mins, stir, 1 min')).toBeTruthy();
    expect(within(exact).getByRole('heading', { name: 'Product name' })).toBeTruthy();
    expect(within(exact).getByRole('heading', { name: 'Cooking instructions' })).toBeTruthy();
    expect(within(exact).getByText('Heat on full power for 2 minutes')).toBeTruthy();
    expect(exact.textContent).not.toContain('A carton of soup');

    expect(interp.textContent).toContain('A carton of soup');
    expect(interp.textContent).not.toContain('Tomato Soup');
  });

  it('shows dates verbatim with label type in words and a neutral comparison', () => {
    render(<EvidencePanel evidence={makeEvidence()} />);
    const dates = screen.getByRole('region', { name: 'Dates' });
    expect(within(dates).getByText('BEST BEFORE END 03 2027')).toBeTruthy();
    expect(dates.textContent).toContain('Best before end');
    expect(dates.textContent).toContain('Read as 31 March 2027.');
    expect(dates.textContent).toContain('Month and year only');
    expect(dates.textContent).toContain('Printed date is in the future relative to today in London.');
    const all = screen.getByTestId('evidence').textContent?.toLowerCase() ?? '';
    expect(all).not.toMatch(/\bsafe\b|throw away|expired/);
  });

  it('lists batch codes separately, not as dates', () => {
    render(<EvidencePanel evidence={makeEvidence()} />);
    const batch = screen.getByRole('region', { name: 'Batch/lot codes (not dates)' });
    expect(within(batch).getByText('L2417A')).toBeTruthy();
    expect(screen.getByRole('region', { name: 'Dates' }).textContent).not.toContain('L2417A');
  });

  it('shows readability, issues and suggestion', () => {
    render(<EvidencePanel evidence={makeEvidence()} />);
    const panel = screen.getByTestId('evidence');
    expect(panel.textContent).toContain('Readability: Partly readable (glare)');
    expect(panel.textContent).toContain('Tilt the pack away from the light.');
  });

  it('handles past/today/ambiguous dates and no guess', () => {
    render(
      <EvidencePanel
        evidence={makeEvidence({
          itemGuess: null,
          batchCodes: [],
          dates: [
            {
              printedText: 'USE BY 20 NOV',
              labelType: 'use_by',
              interpretation: { status: 'incomplete', isoDate: null, comparison: 'past', note: 'Year not printed' },
            },
            {
              printedText: '03/04/27',
              labelType: 'unknown',
              interpretation: { status: 'ambiguous', isoDate: null, comparison: 'unknown', note: '' },
            },
            {
              printedText: 'DISPLAY UNTIL 23 NOV 2026',
              labelType: 'display_until',
              interpretation: { status: 'parsed', isoDate: '2026-11-23', comparison: 'today', note: '' },
            },
          ],
        })}
      />,
    );
    const dates = screen.getByRole('region', { name: 'Dates' }).textContent ?? '';
    expect(dates).toContain('Use by');
    expect(dates).toContain('Incomplete. Year not printed');
    expect(dates).toContain('Printed date is in the past relative to today in London.');
    expect(dates).toContain('Ambiguous');
    expect(dates).toContain('Could not compare the printed date with today.');
    expect(dates).toContain('Printed date is today in London.');
    expect(screen.queryByRole('region', { name: 'Batch/lot codes (not dates)' })).toBeNull();
    expect(screen.getByRole('region', { name: 'Interpretation' }).textContent).toContain('No guess');
  });
});
