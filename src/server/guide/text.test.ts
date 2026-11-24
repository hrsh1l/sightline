import { describe, expect, it } from 'vitest';
import type { GuideSection } from '../../shared/guide.js';
import { clip, isAffirmativeCompletion, matchSectionChoice, numbersIn, pickSectionsForGoal, speakableTitle, stepList, stepTextMatches } from './text.js';

describe('isAffirmativeCompletion', () => {
  it.each([
    'done',
    'Done.',
    'Done!',
    "I've done it",
    'I’ve done it.',
    'finished',
    "I've finished this step",
    "ok that's done",
    'OK, that’s done.',
    'completed',
    'Yes, done.',
    'Done. What is next?',
    "I'm done",
    'all done',
    'Finished that one',
  ])('accepts %j', (u) => {
    expect(isAffirmativeCompletion(u)).toBe(true);
  });

  it.each([
    "I'm not done",
    'I’m not done',
    'not done yet',
    'do I say done?',
    'what does done mean',
    "when it says 'done'",
    'when it says “done”',
    'the word "finished"',
    "I haven't finished",
    'I havent finished',
    'almost done',
    'nearly finished',
    'done?',
    'Is it done?',
    'Am I done?',
    'done yet',
    'not quite done',
    "I'll say done when I'm finished",
    'tell me when it is done',
    'how do I know when it is done',
    'done but the film is still on',
    'wait',
    'next',
    "what's next",
    'go on',
    'okay',
    'yes',
    '',
    'no, not finished',
    'I will be done in a minute',
    "I'm going to finish it",
    'about to finish',
  ])('rejects %j', (u) => {
    expect(isAffirmativeCompletion(u)).toBe(false);
  });

  it('rejects null and very long input', () => {
    expect(isAffirmativeCompletion(null)).toBe(false);
    expect(isAffirmativeCompletion(undefined)).toBe(false);
    expect(isAffirmativeCompletion(`done ${'x'.repeat(300)}`)).toBe(false);
  });
});

describe('step text matching', () => {
  it('exact after normalisation; near needs identical numbers and >= 0.9 token overlap', () => {
    expect(stepTextMatches('Heat on FULL power for 4 minutes.', 'heat on full power for 4 minutes')).toBe('exact');
    expect(stepTextMatches('Pierce the film lid several times with a fork', 'Pierce the film lid several times with a fork.')).toBe('exact');
    expect(stepTextMatches('Remove the sleeve and pierce the film lid several times before heating it', 'Remove the sleeve and pierce the film lid several times before heating')).toBe('near');
    expect(stepTextMatches('Heat for 4 minutes.', 'Heat for 5 minutes.')).toBeNull();
    expect(stepTextMatches('Heat for 1.5 minutes.', 'Heat for 1,5 minutes.')).toBe('exact');
    expect(stepTextMatches('Stir well.', 'Leave to stand.')).toBeNull();
    expect(numbersIn('Preheat to 190°C, Fan 170°C, Gas 5. Cook 25-30 mins')).toEqual(['190', '170', '5', '25', '30']);
  });
});

const sec = (id: string, title: string, kind: GuideSection['kind']): GuideSection => ({
  id,
  title,
  kind,
  steps: [{ id: `${id}-s1`, n: 1, sourceText: 'FIXTURE step', spoken: 'FIXTURE step', quantities: [], warnings: [] }],
  complete: true,
  missing: [],
});

describe('sections for a goal', () => {
  const micro = sec('microwave', 'MICROWAVE (800W)', 'method');
  const oven = sec('oven', 'OVEN', 'method');
  const storage = sec('storage', 'Storage', 'storage');

  it('singles out a section named by the goal; otherwise offers the candidates (never merged)', () => {
    expect(pickSectionsForGoal('microwave instructions', [micro, oven, storage]).single).toBe(micro);
    expect(pickSectionsForGoal('storage instructions', [micro, oven, storage]).single).toBe(storage);
    expect(pickSectionsForGoal('how to store it', [micro, oven, storage]).single).toBe(storage);
    const cooking = pickSectionsForGoal('cooking instructions', [micro, oven, storage]);
    expect(cooking.single).toBeNull();
    expect(cooking.candidates).toEqual([micro, oven]);
    const generic = pickSectionsForGoal('these instructions', [micro, oven, storage]);
    expect(generic.single).toBeNull();
    expect(generic.candidates).toEqual([micro, oven, storage]);
    expect(pickSectionsForGoal('cooking instructions', [oven, storage]).single).toBe(oven);
    expect(pickSectionsForGoal(null, [oven]).single).toBe(oven);
  });

  it('matches a spoken choice by id, title, kind word or ordinal', () => {
    const offered = [micro, oven];
    expect(matchSectionChoice('microwave', offered)).toBe(micro);
    expect(matchSectionChoice('the oven one', offered)).toBe(oven);
    expect(matchSectionChoice('MICROWAVE (800W)', offered)).toBe(micro);
    expect(matchSectionChoice('the first one', offered)).toBe(micro);
    expect(matchSectionChoice('second', offered)).toBe(oven);
    expect(matchSectionChoice('grill', offered)).toBeNull();
    expect(matchSectionChoice('', offered)).toBeNull();
  });
});

describe('phrasing', () => {
  it('speakable titles keep units; lists and clipping', () => {
    expect(speakableTitle('MICROWAVE (800W)')).toBe('microwave (800W)');
    expect(speakableTitle('Oven Cook')).toBe('Oven Cook');
    expect(stepList([3])).toBe('step 3');
    expect(stepList([1, 2, 4])).toBe('steps 1, 2 and 4');
    expect(clip('one two three four', 10)).toBe('one two…');
    expect(clip('short', 10)).toBe('short');
  });
});
