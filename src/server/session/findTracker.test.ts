/** FindMachine / TrackSet tests. FIXTURE detections only (hand-written boxes), deterministic time. */
import { describe, expect, it } from 'vitest';
import { LIMITS, ServerFind, type Detection } from '../../shared/protocol.js';
import { findTargetByCoco } from '../../shared/findTargets.js';
import { FIND_TUNING, FindMachine, TrackSet, terminalFindMessage } from './findTracker.js';

const T0 = 1_800_000_000_000;
const CUP = findTargetByCoco('cup')!;
const BOWL = findTargetByCoco('bowl')!;

const det = (cx: number, cy: number, score = 0.9, label = 'cup', s = 0.1): Detection => ({
  label,
  score,
  box: { x: cx - s / 2, y: cy - s / 2, w: s, h: s },
});

/** Drives a machine with frames every `step` ms; capture time == server time unless `age` is given. */
function driver(target = CUP, query = target.noun) {
  const m = new FindMachine({ target, query, requestId: 'r1', startedAt: T0 });
  let frameId = 0;
  let t = T0;
  const sent: ServerFind[] = [m.start(T0)];
  const keep = (x: ServerFind | null) => {
    if (x) {
      expect(ServerFind.parse(x)).toEqual(x);
      sent.push(x);
    }
    return x;
  };
  return {
    m,
    sent,
    get t() {
      return t;
    },
    /** Next frame `step` ms later. `age` = how old the frame is when its result arrives. */
    frame(dets: Detection[], o: { step?: number; age?: number; frameId?: number } = {}) {
      t += o.step ?? 200;
      const id = o.frameId ?? ++frameId;
      const captured = t - (o.age ?? 0);
      const r = m.observe({ frameId: id, capturedAt: captured, serverCapturedAt: captured, detections: dets }, t);
      keep(r.message);
      return r;
    },
    tick(ms: number) {
      t += ms;
      return keep(m.tick(t));
    },
    prompts: () => sent.filter((s) => s.prompt).map((s) => s.prompt!),
  };
}

describe('TrackSet (association)', () => {
  const f = (frameId: number, t: number) => ({ frameId, capturedAt: t, serverCapturedAt: t });

  it('keeps ids across frames by IoU, then by centre distance; far jumps start a new track', () => {
    const ts = new TrackSet();
    const a = ts.update([det(0.2, 0.5)], f(1, T0));
    const id = [...a.keys()][0]!;
    expect(ts.update([det(0.22, 0.5)], f(2, T0 + 200)).has(id)).toBe(true); // IoU
    expect(ts.update([det(0.31, 0.5)], f(3, T0 + 400)).has(id)).toBe(true); // no IoU, distance 0.09
    const far = ts.update([det(0.6, 0.5)], f(4, T0 + 600));
    expect(far.has(id)).toBe(false);
    expect(ts.tracks).toHaveLength(2);
  });

  it('low-score detections (0.30-0.45) only extend existing tracks; below 0.30 is ignored', () => {
    const ts = new TrackSet();
    expect(ts.update([det(0.5, 0.5, 0.4)], f(1, T0)).size).toBe(0);
    const id = [...ts.update([det(0.5, 0.5, 0.8)], f(2, T0 + 200)).keys()][0]!;
    expect(ts.update([det(0.5, 0.5, 0.35)], f(3, T0 + 400)).get(id)?.score).toBe(0.35);
    expect(ts.update([det(0.5, 0.5, 0.29)], f(4, T0 + 600)).size).toBe(0);
    expect(ts.get(id)!.streak).toBe(0);
  });

  it('greedy best-first: the higher-IoU pair wins; confirmed after 2 consecutive frames', () => {
    const ts = new TrackSet();
    const first = ts.update([det(0.3, 0.5, 0.9), det(0.45, 0.5, 0.8)], f(1, T0));
    const [idA, idB] = [...first.keys()];
    const a = det(0.31, 0.5, 0.7);
    const b = det(0.44, 0.5, 0.95);
    const second = ts.update([b, a], f(2, T0 + 200));
    expect(second.get(idA!)).toBe(a);
    expect(second.get(idB!)).toBe(b);
    expect(ts.get(idA!)!.confirmed).toBe(true);
  });

  it('expires tracks unmatched for more than 1 s', () => {
    const ts = new TrackSet();
    const id = [...ts.update([det(0.5, 0.5)], f(1, T0)).keys()][0]!;
    ts.update([], f(2, T0 + 900));
    expect(ts.update([det(0.5, 0.5)], f(3, T0 + 1_000)).has(id)).toBe(true);
    ts.update([], f(4, T0 + 1_500));
    expect(ts.update([det(0.5, 0.5)], f(5, T0 + 2_100)).has(id)).toBe(false);
  });
});

describe('FindMachine: acquisition and binding', () => {
  it('auto-selects a single cup after 2 consecutive frames, says "Found a cup" once, ignores other classes', () => {
    const d = driver();
    expect(d.sent[0]).toMatchObject({ state: 'searching', target: null, trackId: null, prompt: null, source: 'yolo' });
    expect(d.frame([det(0.2, 0.5), det(0.8, 0.5, 0.95, 'bottle')]).message).toBeNull();
    const r = d.frame([det(0.21, 0.5), det(0.8, 0.5, 0.95, 'bottle')]);
    expect(r.message).toMatchObject({
      state: 'tracking',
      trackId: 1,
      observedAt: d.t,
      target: { label: 'cup', score: 0.9 },
      description: expect.stringContaining('left of the picture'),
      prompt: { kind: 'tracking', text: 'Found a cup. Follow the sound.' },
    });
    expect(r.target?.label).toBe('cup');
    // Every applied observation while tracking produces an update, without repeating the prompt.
    expect(d.frame([det(0.22, 0.5)]).message).toMatchObject({ state: 'tracking', prompt: null });
  });

  it('BINDING: a bigger, more confident second cup never steals the selected target', () => {
    const d = driver();
    d.frame([det(0.2, 0.5, 0.6)]);
    d.frame([det(0.2, 0.5, 0.6)]);
    expect(d.m.selectedTrackId).toBe(1);
    for (let i = 0; i < 5; i++) {
      const r = d.frame([det(0.2, 0.5, 0.6), det(0.6, 0.5, 0.99, 'cup', 0.4)]);
      expect(r.message).toMatchObject({ state: 'tracking', trackId: 1 });
      expect(r.target?.score).toBe(0.6);
    }
    // The selected one disappears: lost, not switched to the big one.
    d.frame([det(0.6, 0.5, 0.99, 'cup', 0.4)]);
    d.frame([det(0.6, 0.5, 0.99, 'cup', 0.4)]);
    d.frame([det(0.6, 0.5, 0.99, 'cup', 0.4)]);
    const last = d.frame([det(0.6, 0.5, 0.99, 'cup', 0.4)]);
    expect(d.m.state).not.toBe('tracking');
    expect(last.target).toBeNull();
    expect(d.sent.filter((s) => s.state === 'tracking' && s.trackId !== 1)).toHaveLength(0);
  });
});

describe('FindMachine: loss and reacquisition', () => {
  const track = (d: ReturnType<typeof driver>, cx = 0.2) => {
    d.frame([det(cx, 0.5)]);
    d.frame([det(cx, 0.5)]);
  };

  it('occlusion -> lost once (after > findObservationMaxAgeMs), no target; reacquires the only cup ever seen even if moved', () => {
    const d = driver();
    track(d);
    d.frame([]);
    expect(d.m.state).toBe('tracking');
    const lost = d.tick(LIMITS.findObservationMaxAgeMs - 200 + 1);
    expect(lost).toMatchObject({ state: 'lost', target: null, observedAt: null, frameId: null, prompt: { kind: 'lost', text: "I've lost the cup. Move the camera back slowly." } });
    for (let i = 0; i < 20; i++) d.tick(100);
    d.frame([]);
    expect(d.prompts().filter((p) => p.kind === 'lost')).toHaveLength(1);
    d.frame([det(0.8, 0.3)]);
    const back = d.frame([det(0.8, 0.3)]);
    expect(back.message).toMatchObject({ state: 'tracking', prompt: null, target: { label: 'cup' } });
  });

  it('after two cups were seen at once: reacquire only near the last position, else ask again', () => {
    const d = driver();
    d.frame([det(0.2, 0.5), det(0.8, 0.5)]);
    d.frame([det(0.2, 0.5), det(0.8, 0.5)]);
    expect(d.m.state).toBe('needs_selection');
    expect(d.m.selectByPosition('left', d.t).ok).toBe(true);
    d.frame([det(0.2, 0.5)]);
    d.tick(800);
    expect(d.m.state).toBe('lost');
    // Near (within 0.2 of the last position): reacquired.
    d.frame([det(0.3, 0.5)], { step: 1_200 });
    expect(d.frame([det(0.3, 0.5)]).message).toMatchObject({ state: 'tracking' });
    // Lose again, then only a FAR cup is visible: ask, never guess.
    d.frame([]);
    d.tick(800);
    expect(d.m.state).toBe('lost');
    d.frame([det(0.85, 0.5)], { step: 1_200 });
    const ask = d.frame([det(0.85, 0.5)]);
    expect(ask.message).toMatchObject({
      state: 'needs_selection',
      target: null,
      candidates: [expect.objectContaining({ position: 'right' })],
      prompt: { kind: 'reselect', text: 'I can see a cup on the right of the picture, but I\'m not sure it\'s the same one. Say "the right one" to follow it.' },
    });
  });

  it('two cups visible while lost -> reselect prompt', () => {
    const d = driver();
    track(d);
    d.frame([]);
    d.tick(800);
    d.frame([det(0.2, 0.5), det(0.7, 0.5)], { step: 1_200 });
    const r = d.frame([det(0.2, 0.5), det(0.7, 0.5)]);
    expect(r.message).toMatchObject({ state: 'needs_selection', trackId: null, prompt: { kind: 'reselect', text: 'I see more than one cup now. The left one or the right one?' } });
  });
});

describe('FindMachine: centring (hysteresis + dwell)', () => {
  /** Two frames at (cx, cy): auto-selected. Motion in these tests stays within the association limits. */
  const acquire = (d: ReturnType<typeof driver>, cx: number, cy = 0.5) => {
    d.frame([det(cx, cy)]);
    d.frame([det(cx, cy)]);
  };
  const at = (d: ReturnType<typeof driver>, cx: number, cy = 0.5, o: { step?: number; age?: number; frameId?: number } = {}) => d.frame([det(cx, cy)], o);

  it('needs consecutive fresh in-zone observations spanning >= findCenteredDwellMs; says it once per episode', () => {
    const d = driver();
    acquire(d, 0.4); // dx 0.1: outside the enter zone
    expect(d.m.state).toBe('tracking');
    expect(at(d, 0.5).message!.state).toBe('tracking'); // dwell starts
    expect(at(d, 0.55, 0.45).message!.state).toBe('tracking'); // +200
    expect(at(d, 0.57, 0.55).message!.state).toBe('tracking'); // +400
    const c = at(d, 0.5).message!; // +600
    expect(c).toMatchObject({ state: 'centered', prompt: { kind: 'centred', text: 'Cup centred in the camera.' }, description: expect.stringContaining('in the centre') });
    expect(at(d, 0.5).message).toMatchObject({ state: 'centered', prompt: null });
    expect(d.prompts().filter((p) => p.kind === 'centred')).toHaveLength(1);
  });

  it('a single frame, a stale frame or an out-of-order frame can never confirm', () => {
    const d = driver();
    acquire(d, 0.4);
    at(d, 0.5);
    // Stale: captured 800 ms before its result arrives -> ignored, and the dwell restarts.
    expect(at(d, 0.5, 0.5, { step: 700, age: 800 }).message).toBeNull();
    expect(d.m.state).toBe('tracking');
    // Out-of-order (older frameId): ignored.
    expect(at(d, 0.5, 0.5, { frameId: 1 }).message).toBeNull();
    at(d, 0.5);
    at(d, 0.5);
    expect(d.m.state).toBe('tracking'); // only 200 ms of fresh dwell since the stale frame
    // A processed frame without the target also breaks the dwell.
    d.frame([]);
    at(d, 0.5);
    at(d, 0.5, 0.5, { step: 590 });
    expect(d.m.state).toBe('tracking');
    at(d, 0.5, 0.5, { step: 10 });
    expect(d.m.state).toBe('centered');
  });

  it('hysteresis: enters within (0.08, 0.10), stays until beyond (0.13, 0.16), on both axes', () => {
    const d = driver();
    acquire(d, 0.59);
    for (let i = 0; i < 5; i++) at(d, 0.59); // dx 0.09: outside the enter zone, never confirms
    expect(d.m.state).toBe('tracking');
    for (let i = 0; i < 4; i++) at(d, 0.58, 0.6); // dx 0.08, dy 0.10: inside
    expect(d.m.state).toBe('centered');
    at(d, 0.62, 0.65); // dx 0.12, dy 0.15: inside the exit zone
    expect(d.m.state).toBe('centered');
    at(d, 0.55, 0.67); // dy 0.17: out
    expect(d.m.state).toBe('tracking');
    for (let i = 0; i < 4; i++) at(d, 0.5, 0.58);
    expect(d.m.state).toBe('centered');
    at(d, 0.6, 0.55); // dx 0.10: still centred
    expect(d.m.state).toBe('centered');
    at(d, 0.64, 0.5); // dx 0.14: out
    expect(d.m.state).toBe('tracking');
  });

  it('re-confirmation after leaving needs a new dwell, and the prompt is suppressed for 5 s', () => {
    const d = driver();
    acquire(d, 0.5);
    for (let i = 0; i < 3; i++) at(d, 0.5);
    expect(d.m.state).toBe('centered');
    const leave = () => {
      at(d, 0.6);
      at(d, 0.65);
      expect(d.m.state).toBe('tracking');
    };
    const ret = () => {
      expect(at(d, 0.57).message!.state).toBe('tracking');
      at(d, 0.5);
      at(d, 0.5);
      return at(d, 0.5).message!;
    };
    leave();
    expect(ret()).toMatchObject({ state: 'centered', prompt: null }); // within 5 s of leaving
    leave();
    for (let i = 0; i < 10; i++) at(d, 0.65, 0.5, { step: 600 }); // 6 s off-centre
    expect(ret()).toMatchObject({ state: 'centered', prompt: { kind: 'centred' } });
    expect(d.prompts().filter((p) => p.kind === 'centred')).toHaveLength(2);
    expect(FIND_TUNING.recentreSuppressMs).toBe(5_000);
  });
});

describe('FindMachine: prompts', () => {
  it('not_seen after 2.5 s searching with nothing, then at most every 10 s', () => {
    const d = driver();
    expect(d.tick(2_499)).toBeNull();
    expect(d.tick(1)).toMatchObject({ state: 'searching', prompt: { kind: 'not_seen', text: "I don't see a cup yet. Slowly scan the camera across the table." } });
    expect(d.tick(9_999)).toBeNull();
    expect(d.tick(1)!.prompt!.kind).toBe('not_seen');
    // Due again 10 s later, but something was seen just now: no not_seen.
    d.tick(9_999);
    d.frame([det(0.5, 0.5, 0.9)], { step: 0 });
    expect(d.tick(1)).toBeNull();
    expect(driver(findTargetByCoco('apple')!).m.tick(T0 + 2_500)!.prompt!.text).toBe("I don't see an apple yet. Slowly scan the camera across the table.");
  });

  it('tilt prompts only while tracking >= 1 s, horizontally near centre and vertically off; throttled per kind', () => {
    const d = driver();
    const at = (cx: number, cy: number, step?: number) => d.frame([det(cx, cy)], step ? { step } : {}).message?.prompt ?? null;
    at(0.5, 0.2);
    expect(at(0.5, 0.2)!.kind).toBe('tracking'); // tracked since here
    for (let i = 0; i < 4; i++) expect(at(0.5, 0.2)).toBeNull(); // < 1 s
    expect(at(0.5, 0.2)).toEqual({ kind: 'tilt_up', text: 'Tilt the phone up slightly.' }); // 1 s
    expect(at(0.5, 0.3)).toBeNull(); // throttled (3 s per kind)
    expect(at(0.5, 0.4)).toBeNull(); // |dy| 0.1: not off enough
    at(0.5, 0.5);
    at(0.5, 0.6);
    expect(at(0.5, 0.7)).toEqual({ kind: 'tilt_down', text: 'Tilt the phone down slightly.' });
    expect(at(0.6, 0.75)).toBeNull(); // throttled
    expect(at(0.7, 0.8)).toBeNull(); // horizontal error 0.2 > 0.13: never tilt
    for (let i = 0; i < 5; i++) at(0.6, 0.8, 600);
    expect(d.prompts().filter((p) => p.kind === 'tilt_down')).toHaveLength(2);
  });
});

describe('FindMachine: selection', () => {
  it('two cups -> needs_selection (left/right), select by position', () => {
    const d = driver();
    d.frame([det(0.75, 0.5, 0.8), det(0.25, 0.5, 0.9)]);
    const r = d.frame([det(0.75, 0.5, 0.8), det(0.25, 0.5, 0.9)]).message!;
    expect(r).toMatchObject({ state: 'needs_selection', target: null, prompt: { kind: 'select', text: 'I see two cups. The left one or the right one?' } });
    expect(r.candidates!.map((c) => [c.position, c.score])).toEqual([
      ['left', 0.9],
      ['right', 0.8],
    ]);
    expect(d.m.select(99, d.t)).toMatchObject({ ok: false, code: 'unknown_candidate' });
    const s = d.m.selectByPosition('right', d.t);
    expect(s).toMatchObject({ ok: true, position: 'right', message: { state: 'tracking', trackId: r.candidates![1]!.id, prompt: { kind: 'tracking', text: 'Okay, the right cup. Follow the sound.' } } });
    expect(d.m.selectByPosition('left', d.t)).toMatchObject({ ok: false, code: 'not_selecting' });
  });

  it('three bowls -> left/middle/right; four -> middle is ambiguous; select by candidate id', () => {
    const d = driver(BOWL);
    const three = [det(0.2, 0.5, 0.9, 'bowl'), det(0.5, 0.5, 0.8, 'bowl'), det(0.8, 0.5, 0.7, 'bowl')];
    d.frame(three);
    const r = d.frame(three).message!;
    expect(r.prompt!.text).toBe('I see three bowls. The left, middle or right one?');
    expect(r.candidates!.map((c) => c.position)).toEqual(['left', 'middle', 'right']);
    expect(d.m.selectByPosition('middle', d.t)).toMatchObject({ ok: true, message: { trackId: r.candidates![1]!.id } });

    const e = driver(BOWL);
    const four = [0.1, 0.35, 0.6, 0.9].map((x) => det(x, 0.5, 0.8, 'bowl'));
    e.frame(four);
    const q = e.frame(four).message!;
    expect(q.prompt!.text).toBe('I see four bowls. The left, middle or right one?');
    expect(q.candidates!.map((c) => c.position)).toEqual(['left', 'middle', 'middle', 'right']);
    expect(e.m.selectByPosition('middle', e.t)).toMatchObject({ ok: false, code: 'ambiguous' });
    expect(e.m.select(q.candidates![2]!.id, e.t)).toMatchObject({ ok: true, message: { state: 'tracking', trackId: q.candidates![2]!.id } });
  });

  it('caps candidates at LIMITS.maxFindCandidates (best scores)', () => {
    const d = driver();
    const six = [0.1, 0.25, 0.4, 0.55, 0.7, 0.85].map((x, i) => det(x, 0.5, 0.5 + i * 0.08));
    d.frame(six);
    const r = d.frame(six).message!;
    expect(r.candidates).toHaveLength(LIMITS.maxFindCandidates);
    expect(Math.min(...r.candidates!.map((c) => c.score))).toBeCloseTo(0.66);
  });
});

describe('FindMachine: read subject, stop', () => {
  it('binds read_label to the centred / freshly tracked target; otherwise unconfirmed', () => {
    const d = driver();
    expect(d.m.readSubject(d.t)).toEqual({ kind: 'none' });
    d.frame([det(0.3, 0.5)]);
    d.frame([det(0.3, 0.5)]);
    expect(d.m.readSubject(d.t)).toEqual({ kind: 'bound', focus: 'the cup on the left of the picture' });
    expect(d.m.readSubject(d.t + 1_001)).toEqual({ kind: 'unconfirmed', noun: 'cup' });
    d.frame([det(0.4, 0.5)]);
    for (let i = 0; i < 4; i++) d.frame([det(0.5, 0.5)]);
    expect(d.m.readSubject(d.t)).toEqual({ kind: 'bound', focus: 'the cup in the centre of the picture' });
    d.tick(800);
    expect(d.m.state).toBe('lost');
    expect(d.m.readSubject(d.t)).toEqual({ kind: 'unconfirmed', noun: 'cup' });
  });

  it('stop is terminal: nothing further from observe or tick', () => {
    const d = driver();
    expect(d.m.stop('stopped', d.t, { kind: 'stopped', text: 'Stopped finding.' })).toMatchObject({ state: 'stopped', prompt: { kind: 'stopped' } });
    expect(d.m.stop('timeout', d.t, null)).toBeNull();
    expect(d.frame([det(0.5, 0.5)]).message).toBeNull();
    expect(d.tick(5_000)).toBeNull();
    expect(d.m.readSubject(d.t)).toEqual({ kind: 'none' });
  });

  it('terminalFindMessage is a valid ServerFind', () => {
    const m = terminalFindMessage({ requestId: 'r1', query: 'keys', state: 'unsupported', prompt: { kind: 'unsupported', text: 'x' }, now: T0 });
    expect(ServerFind.parse(m)).toEqual(m);
  });
});
