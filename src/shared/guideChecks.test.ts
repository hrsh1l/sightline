import { describe, expect, it } from 'vitest';
import { GUIDE_LIMITS } from './guide.js';
import { checkSpoken, enforceFaithfulSpoken, numberTokens, spokenIsFaithful, stripLeadingEnumerator, trimToLimit } from './guideChecks.js';

describe('numberTokens', () => {
  it.each([
    ['Heat for 3 minutes', ['3 min']],
    ['Heat for 3 mins', ['3 min']],
    ['1 minute 30 seconds', ['1 min', '30 s']],
    ['Microwave on full power (800W)', ['800 W']],
    ['800 watts', ['800 W']],
    ['Preheat to 190°C', ['190 °C']],
    ['190 ºC', ['190 °C']],
    ['190C', ['190 °C']],
    ['190 degrees Celsius', ['190 °C']],
    ['375°F', ['375 °F']],
    ['Fan 170°', ['170 °']],
    ['Gas 5', ['Gas 5']],
    ['Gas Mark 5', ['Gas 5']],
    ['200°C/180°C Fan/Gas 6', ['200 °C', '180 °C', 'Gas 6']],
    ['½ tsp', ['1/2 tsp']],
    ['1/2 tsp', ['1/2 tsp']],
    ['1½ cups', ['1 1/2 cup']],
    ['2 x M4 screws', ['2 x', 'M4']],
    ['Repeat x2', ['2 x']],
    ['1,5 l water', ['1.5 l']],
    ['1.5 l water', ['1.5 l']],
    ['1,000W', ['1000 W']],
    ['Cook for 20-25 mins', ['20 min', '25 min']],
    ['Cook for 20 to 25 minutes', ['20 min', '25 min']],
    ['three minutes', ['3 min']],
    ['twenty-five minutes', ['25 min']],
    ['half an hour', ['1/2 h']],
    ['Store at -18°C or below', ['-18 °C']],
    ['minus 18 degrees C', ['-18 °C']],
    ['Stand for 1:30', ['1:30']],
    ['Add 250ml boiling water', ['250 ml']],
    ['No numbers here', []],
    ['Batch L2341', []],
  ])('%s -> %j', (text, tokens) => {
    expect(numberTokens(text)).toEqual(tokens);
  });

  it('decimal with comma equals decimal with dot; fraction equals decimal', () => {
    expect(spokenIsFaithful('Add 1.5 litres', 'Add 1,5 l')).toBe(true);
    expect(spokenIsFaithful('Add 0.5 tsp salt', 'Add ½ tsp salt')).toBe(true);
    expect(spokenIsFaithful('Add half a teaspoon of salt', 'Add ½ tsp salt')).toBe(false); // unit dropped from the number
  });
});

describe('stripLeadingEnumerator', () => {
  it.each([
    ['1. Pierce the film', 'Pierce the film'],
    ['2) Stir', 'Stir'],
    ['(3) Stir', 'Stir'],
    ['Step 4: Stir', 'Stir'],
    ['1.5 l of water', '1.5 l of water'],
    ['2 x M4 screws', '2 x M4 screws'],
    ['800W 3 mins', '800W 3 mins'],
  ])('%s', (input, out) => {
    expect(stripLeadingEnumerator(input)).toBe(out);
  });
});

describe('spokenIsFaithful', () => {
  const src = 'Pierce film several times. Heat on full power (800W) for 3 mins.';

  it('accepts a shortened version with every number and unit', () => {
    expect(spokenIsFaithful('Pierce the film, then heat at 800 watts for 3 minutes.', src)).toBe(true);
  });

  it('rejects a changed number', () => {
    expect(checkSpoken('Pierce the film, then heat at 800 watts for 4 minutes.', src)).toEqual({ faithful: false, extra: ['4 min'], dropped: ['3 min'] });
  });

  it('rejects a dropped duration', () => {
    expect(checkSpoken('Pierce the film, then heat at 800 watts.', src)).toEqual({ faithful: false, extra: [], dropped: ['3 min'] });
  });

  it('rejects a changed unit (°C -> °F) and a changed time unit', () => {
    expect(spokenIsFaithful('Preheat the oven to 190°F.', 'Preheat oven to 190°C.')).toBe(false);
    expect(spokenIsFaithful('Bake for 25 seconds.', 'Bake for 25 mins.')).toBe(false);
  });

  it('rejects an added number', () => {
    expect(spokenIsFaithful('Stir and heat for 1 more minute at 800 watts.', 'Stir and heat for 1 minute.')).toBe(false);
  });

  it('accepts reordered numbers (order is out of scope) as long as all numbers match', () => {
    expect(spokenIsFaithful('For 25 minutes at 190°C.', 'Bake at 190°C for 25 minutes.')).toBe(true);
  });

  it('requires every repetition of a printed number', () => {
    const twice = 'Heat for 2 mins, stir, then heat for a further 2 mins.';
    expect(spokenIsFaithful('Heat for 2 minutes, stir, then heat for a further 2 minutes.', twice)).toBe(true);
    expect(spokenIsFaithful('Heat for 2 minutes, stir, then heat for 2 more minutes.', twice)).toBe(false); // unitless "2": conservative fallback
    expect(spokenIsFaithful('Heat for 2 minutes, stir, then heat again.', twice)).toBe(false);
  });

  it('handles fractions, mixed numbers and unicode fractions', () => {
    expect(spokenIsFaithful('Add 1 1/2 cups of water.', 'Add 1½ cups water.')).toBe(true);
    expect(spokenIsFaithful('Add 1/2 a cup of water.', 'Add 1½ cups water.')).toBe(false);
  });

  it('ignores a leading list number in either text', () => {
    expect(spokenIsFaithful('Remove the sleeve.', '1. Remove sleeve.')).toBe(true);
  });

  it('handles oven lines with fan and gas settings', () => {
    const oven = 'Preheat oven to 200°C / Fan 180°C / Gas 6. Cook for 20-25 mins.';
    expect(spokenIsFaithful('Preheat the oven to 200°C, fan 180°C, or gas mark 6, and cook for 20 to 25 minutes.', oven)).toBe(true);
    expect(spokenIsFaithful('Preheat the oven to 200°C and cook for 20 to 25 minutes.', oven)).toBe(false);
  });

  it('handles assembly sizes', () => {
    expect(spokenIsFaithful('Fix the leg with 2 M4 screws.', 'Attach leg (A) using 2 x M4 screws.')).toBe(false); // "x" multiplier dropped
    expect(spokenIsFaithful('Attach leg A using 2 x M4 screws.', 'Attach leg (A) using 2 x M4 screws.')).toBe(true);
    expect(spokenIsFaithful('Attach leg A using 2 x M5 screws.', 'Attach leg (A) using 2 x M4 screws.')).toBe(false);
  });

  it('empty spoken is never faithful', () => {
    expect(spokenIsFaithful('  ', 'Stir well.')).toBe(false);
  });

  it('text without numbers is faithful when spoken adds none', () => {
    expect(spokenIsFaithful('Stir it well.', 'Stir well.')).toBe(true);
  });
});

describe('enforceFaithfulSpoken', () => {
  it('keeps a faithful spoken (trimmed)', () => {
    const r = enforceFaithfulSpoken({ id: 'a-s1', sourceText: 'Heat 800W 3 mins.', spoken: '  Heat at 800 watts for 3 minutes. ' });
    expect(r).toEqual({ step: { id: 'a-s1', sourceText: 'Heat 800W 3 mins.', spoken: 'Heat at 800 watts for 3 minutes.' }, replaced: false, extraCount: 0, droppedCount: 0 });
  });

  it('replaces an unfaithful spoken with the source text (without list marker) and reports counts only', () => {
    const step = { sourceText: '2. Heat 800W 3 mins.', spoken: 'Heat for 4 minutes.' };
    const r = enforceFaithfulSpoken(step);
    expect(r.replaced).toBe(true);
    expect(r.step.spoken).toBe('Heat 800W 3 mins.');
    expect(r.extraCount).toBe(1);
    expect(r.droppedCount).toBe(2);
    expect(step.spoken).toBe('Heat for 4 minutes.'); // input not mutated
  });

  it('trims a long source to the spoken limit at a word boundary', () => {
    const long = `Stir ${'well and '.repeat(80)}serve.`;
    const r = enforceFaithfulSpoken({ sourceText: long, spoken: '' });
    expect(r.replaced).toBe(true);
    expect(r.step.spoken.length).toBeLessThanOrEqual(GUIDE_LIMITS.maxSpokenChars);
    expect(r.step.spoken.endsWith('…')).toBe(true);
    expect(trimToLimit('short')).toBe('short');
  });

  it('replaces a faithful but over-long spoken', () => {
    const src = `Stir ${'gently '.repeat(100)}.`;
    expect(enforceFaithfulSpoken({ sourceText: src, spoken: src }).replaced).toBe(true);
  });
});
