import { describe, expect, it } from 'vitest';
import type { Detection } from './protocol.js';
import {
  COCO_CLASSES,
  cocoLabelFor,
  cocoMatch,
  describePosition,
  iou,
  isCentered,
  isSharpQuery,
  normalizeQuery,
  pickTarget,
  toCueTarget,
} from './find.js';

const det = (label: string, score: number, x: number, y: number, w = 0.1, h = 0.1): Detection => ({ label, score, box: { x, y, w, h } });

describe('COCO mapping', () => {
  it('has the 80 COCO classes', () => {
    expect(COCO_CLASSES).toHaveLength(80);
    expect(new Set(COCO_CLASSES).size).toBe(80);
  });

  it.each([
    ['cup', 'cup'],
    ['the cup', 'cup'],
    ['a mug', 'cup'],
    ['my coffee mug', 'cup'],
    ['the blue coffee mug', 'cup'],
    ['phone', 'cell phone'],
    ['my mobile phone', 'cell phone'],
    ['glass', 'cup'],
    ['a glass of water', 'cup'],
    ['wine glasses', 'wine glass'],
    ['bottle of milk', 'bottle'],
    ['Bottles', 'bottle'],
    ['TV remote', 'remote'],
    ['the fridge', 'refrigerator'],
    ['scissors', 'scissors'],
    ['knives', 'knife'],
    ['laptop', 'laptop'],
    ['hair-dryer', 'hair drier'],
  ])('%s -> %s', (q, label) => {
    expect(cocoLabelFor(q)).toBe(label);
  });

  it.each(['plate', 'the salt', 'my keys', 'reading glasses', 'the label text', 'tin of beans', '', 'the'])('%s -> null', (q) => {
    expect(cocoLabelFor(q)).toBeNull();
  });

  it('reports whether the query is exactly the class (no modifiers)', () => {
    expect(cocoMatch('the mug')).toEqual({ labels: ['cup'], exact: true });
    expect(cocoMatch('the red mug')?.exact).toBe(false);
    expect(cocoMatch('glass')?.labels).toEqual(['cup', 'wine glass']);
  });

  it('normalises determiners, punctuation and "please"', () => {
    expect(normalizeQuery('  The Cup, please! ')).toBe('cup');
  });

  it('flags sharp items', () => {
    expect(isSharpQuery('the bread knife')).toBe(true);
    expect(isSharpQuery('scissors')).toBe(true);
    expect(isSharpQuery('the salt')).toBe(false);
  });
});

describe('geometry', () => {
  it('iou', () => {
    const a = { x: 0, y: 0, w: 0.5, h: 0.5 };
    expect(iou(a, a)).toBeCloseTo(1);
    expect(iou(a, { x: 0.5, y: 0.5, w: 0.5, h: 0.5 })).toBe(0);
    expect(iou(a, { x: 0.25, y: 0, w: 0.5, h: 0.5 })).toBeCloseTo(1 / 3);
  });

  it('isCentered uses +-0.12 x / +-0.15 y around the centre, with optional slack', () => {
    expect(isCentered({ x: 0.45, y: 0.45, w: 0.1, h: 0.1 })).toBe(true);
    expect(isCentered({ x: 0.56, y: 0.45, w: 0.1, h: 0.1 })).toBe(true); // cx 0.61
    expect(isCentered({ x: 0.58, y: 0.45, w: 0.1, h: 0.1 })).toBe(false); // cx 0.63
    expect(isCentered({ x: 0.45, y: 0.59, w: 0.1, h: 0.1 })).toBe(true); // cy 0.64
    expect(isCentered({ x: 0.45, y: 0.62, w: 0.1, h: 0.1 })).toBe(false); // cy 0.67
    expect(isCentered({ x: 0.58, y: 0.45, w: 0.1, h: 0.1 }, 0.03)).toBe(true);
  });

  it('describes image-relative positions only', () => {
    expect(describePosition({ x: 0.05, y: 0.05, w: 0.1, h: 0.1 })).toBe('left of the picture, near the top, small');
    expect(describePosition({ x: 0.7, y: 0.7, w: 0.25, h: 0.25 })).toBe('right of the picture, near the bottom, medium');
    expect(describePosition({ x: 0.45, y: 0.05, w: 0.1, h: 0.1 })).toBe('middle of the picture, near the top, small');
    expect(describePosition({ x: 0.2, y: 0.2, w: 0.6, h: 0.6 })).toBe('in the centre of the picture, large');
    for (const b of [{ x: 0, y: 0, w: 1, h: 1 }, { x: 0.9, y: 0.9, w: 0.05, h: 0.05 }]) {
      expect(describePosition(b)).not.toMatch(/metre|meter|feet|step|walk|close|far|near you|away/);
    }
  });

  it('toCueTarget', () => {
    expect(toCueTarget({ x: 0.4, y: 0.4, w: 0.2, h: 0.2 })).toEqual({ cx: 0.5, cy: 0.5, area: expect.closeTo(0.04) as unknown as number, centered: true });
    expect(toCueTarget({ x: 0, y: 0, w: 0.2, h: 0.2 }).centered).toBe(false);
    expect(toCueTarget({ x: 0, y: 0, w: 0.2, h: 0.2 }, true).centered).toBe(true);
  });
});

describe('pickTarget', () => {
  it('matches labels (incl. synonyms) and prefers higher scores', () => {
    const ds = [det('bottle', 0.9, 0.1, 0.1), det('cup', 0.6, 0.5, 0.5), det('cup', 0.8, 0.2, 0.7)];
    expect(pickTarget(ds, 'mug')).toBe(ds[2]);
    expect(pickTarget(ds, 'salt')).toBeNull();
    expect(pickTarget([], 'cup')).toBeNull();
  });

  it('prefers continuity with the previous target box', () => {
    const ds = [det('cup', 0.7, 0.5, 0.5), det('cup', 0.8, 0.1, 0.1)];
    expect(pickTarget(ds, 'cup', { x: 0.51, y: 0.5, w: 0.1, h: 0.1 })).toBe(ds[0]);
    expect(pickTarget(ds, 'cup', null)).toBe(ds[1]);
  });

  it('anyLabel accepts Gemini labels; low scores are ignored', () => {
    const ds = [det('salt shaker', 0.9, 0.1, 0.1), det('pepper', 0.1, 0.5, 0.5)];
    expect(pickTarget(ds, 'salt', null, { anyLabel: true })).toBe(ds[0]);
    expect(pickTarget([ds[1]!], 'pepper', null, { anyLabel: true })).toBeNull();
  });
});
