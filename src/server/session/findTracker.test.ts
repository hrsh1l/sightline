import { describe, expect, it } from 'vitest';
import type { Detection } from '../../shared/protocol.js';
import { FIND_TIMINGS, FindTracker } from './findTracker.js';

const at = (cx: number, cy: number, w = 0.1, h = 0.1): Detection => ({ label: 'cup', score: 0.9, box: { x: cx - w / 2, y: cy - h / 2, w, h } });

const tracker = (source: 'yolo' | 'gemini' = 'yolo') => new FindTracker({ query: 'cup', requestId: 'r1', source, startedAt: 0 });

describe('FindTracker', () => {
  it('starts searching, then tracking with an image-relative description', () => {
    const t = tracker();
    expect(t.start(0)).toMatchObject({ type: 'find', state: 'searching', target: null, frameId: null, description: null, requestId: 'r1', source: 'yolo' });
    const m = t.observe(3, at(0.1, 0.1), 100)!;
    expect(m).toMatchObject({ state: 'tracking', frameId: 3, target: { label: 'cup' }, description: 'left of the picture, near the top, small' });
  });

  it('tracking <-> centered with hysteresis', () => {
    const t = tracker();
    t.start(0);
    t.observe(1, at(0.2, 0.5), 0);
    expect(t.observe(2, at(0.5, 0.5), 300)!.state).toBe('centered');
    expect(t.centeredOnce).toBe(true);
    // cx 0.64 is outside the base window (0.12) but within the slack (0.16): stays centred.
    expect(t.observe(3, at(0.64, 0.5), 400)).toBeNull();
    expect(t.state).toBe('centered');
    expect(t.observe(4, at(0.8, 0.5), 500)!.state).toBe('tracking');
  });

  it('rate-limits updates while the state is unchanged (~4/s)', () => {
    const t = tracker();
    t.start(0);
    t.observe(1, at(0.2, 0.5), 0);
    expect(t.observe(2, at(0.21, 0.5), 100)).toBeNull();
    expect(t.observe(3, at(0.22, 0.5), 260)).not.toBeNull();
  });

  it('ignores late results for older frames', () => {
    const t = tracker();
    t.start(0);
    t.observe(5, at(0.2, 0.5), 0);
    expect(t.observe(4, at(0.5, 0.5), 400)).toBeNull();
    expect(t.state).toBe('tracking');
  });

  it('lost after ~1.5 s unseen (yolo), re-acquired when seen again', () => {
    const t = tracker();
    t.start(0);
    t.observe(1, at(0.2, 0.5), 0);
    expect(t.observe(2, null, 1_000)).toBeNull();
    expect(t.tick(1_499)).toBeNull();
    expect(t.tick(1_500)).toMatchObject({ state: 'lost', target: null, description: null });
    expect(t.observe(3, at(0.2, 0.5), 2_000)!.state).toBe('tracking');
  });

  it('gemini allows longer gaps before lost', () => {
    const t = tracker('gemini');
    t.start(0);
    t.observe(1, at(0.2, 0.5), 0);
    expect(t.tick(2_000)).toBeNull();
    expect(t.tick(FIND_TIMINGS.geminiLostAfterMs)!.state).toBe('lost');
  });

  it('not_found after ~10 s searching or ~10 s lost; terminal states stop updates', () => {
    const t = tracker();
    t.start(0);
    expect(t.tick(9_999)).toBeNull();
    expect(t.tick(10_000)!.state).toBe('not_found');
    expect(t.terminal).toBe(true);
    expect(t.observe(9, at(0.5, 0.5), 10_100)).toBeNull();
    expect(t.stop('stopped', 10_200)).toBeNull();

    const u = tracker();
    u.start(0);
    u.observe(1, at(0.2, 0.5), 0);
    u.tick(1_500); // lost
    expect(u.tick(11_499)).toBeNull();
    expect(u.tick(11_500)!.state).toBe('not_found');
  });

  it('stop / timeout', () => {
    const t = tracker();
    t.start(0);
    expect(t.stop('timeout', 5)).toMatchObject({ state: 'timeout', target: null });
    expect(t.terminal).toBe(true);
  });
});
