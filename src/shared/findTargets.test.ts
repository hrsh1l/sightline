import { describe, expect, it } from 'vitest';
import { FIND_TARGETS, resolveFindTarget, findTargetByCoco } from './findTargets.js';

describe('supported find targets', () => {
  it('maps mug to cup and accepts plain, article and command forms', () => {
    expect(resolveFindTarget('mug')?.coco).toBe('cup');
    expect(resolveFindTarget('Find a mug')?.coco).toBe('cup');
    expect(resolveFindTarget('the bottle')?.coco).toBe('bottle');
    expect(resolveFindTarget('Bananas')?.coco).toBe('banana');
    expect(resolveFindTarget('white mug')?.coco).toBe('cup');
    expect(resolveFindTarget("where's the bowl?")?.coco).toBe('bowl');
  });
  it('rejects unsupported or ambiguous requests honestly', () => {
    for (const q of ['keys', 'salt', 'knife', 'phone', 'tin of tomatoes', '', 'cup and bottle']) expect(resolveFindTarget(q)).toBeNull();
  });
  it('covers exactly the five verified COCO classes', () => {
    expect(FIND_TARGETS.map((t) => t.coco)).toEqual(['cup', 'bottle', 'bowl', 'apple', 'banana']);
    expect(findTargetByCoco('bottle')?.noun).toBe('bottle');
    expect(findTargetByCoco('person')).toBeNull();
  });
});
