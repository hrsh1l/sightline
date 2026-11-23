/**
 * SpatialCues tests. FIXTURE: a fake AudioContext that records nodes, scheduled params and start/stop times; no
 * real audio is produced.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CUE_MAPPING,
  createSpatialCues,
  gainForArea,
  hrtfPosition,
  intervalForTarget,
  offCenter,
  panForX,
  pitchForY,
} from './SpatialCues.js';

class FakeParam {
  value = 0;
  events: [string, number, number][] = [];
  setValueAtTime(v: number, t: number) {
    this.events.push(['set', v, t]);
    this.value = v;
  }
  exponentialRampToValueAtTime(v: number, t: number) {
    this.events.push(['exp', v, t]);
  }
  linearRampToValueAtTime(v: number, t: number) {
    this.events.push(['lin', v, t]);
  }
  setTargetAtTime(v: number, t: number) {
    this.events.push(['target', v, t]);
    this.value = v;
  }
}

class FakeNode {
  connected = new Set<FakeNode>();
  disconnected = false;
  constructor(
    readonly kind: string,
    readonly ctx: FakeCtx,
  ) {
    ctx.nodes.push(this);
  }
  connect(n: FakeNode) {
    this.connected.add(n);
    return n;
  }
  disconnect() {
    this.disconnected = true;
    this.connected.clear();
  }
}

class FakeSource extends FakeNode {
  type = 'sine';
  frequency = new FakeParam();
  buffer: unknown = null;
  startAt: number | null = null;
  stopAt: number | null = null;
  onended: (() => void) | null = null;
  start(t = 0) {
    this.startAt = t;
  }
  stop(t = 0) {
    this.stopAt = t;
  }
}

class FakeCtx {
  nodes: FakeNode[] = [];
  currentTime = 0;
  sampleRate = 48_000;
  state: 'suspended' | 'running' | 'closed' = 'suspended';
  destination = new FakeNode('destination', this);
  resume = vi.fn(() => {
    this.state = 'running';
    return Promise.resolve();
  });
  close = vi.fn(() => {
    this.state = 'closed';
    return Promise.resolve();
  });
  createGain() {
    const n = new FakeNode('gain', this) as FakeNode & { gain: FakeParam };
    n.gain = new FakeParam();
    return n;
  }
  createOscillator() {
    return new FakeSource('osc', this);
  }
  createBufferSource() {
    return new FakeSource('buffer', this);
  }
  createBuffer(_c: number, len: number) {
    const data = new Float32Array(len);
    return { getChannelData: () => data };
  }
  createStereoPanner() {
    const n = new FakeNode('stereo', this) as FakeNode & { pan: FakeParam };
    n.pan = new FakeParam();
    return n;
  }
  createPanner() {
    const n = new FakeNode('hrtf', this) as FakeNode & Record<string, unknown>;
    n.positionX = new FakeParam();
    n.positionY = new FakeParam();
    n.positionZ = new FakeParam();
    return n;
  }
  /** FIXTURE: advance audio time and fire `ended` for sources whose stop time has passed. */
  advance(sec: number) {
    this.currentTime += sec;
    for (const n of this.nodes) {
      if (n instanceof FakeSource && n.stopAt !== null && n.stopAt <= this.currentTime && n.onended) {
        const cb = n.onended;
        n.onended = null;
        cb();
      }
    }
  }
  oscs() {
    return this.nodes.filter((n): n is FakeSource => n instanceof FakeSource && n.kind === 'osc');
  }
}

function setup(over: { headphones?: boolean } = {}) {
  const ctx = new FakeCtx();
  const vibrate = vi.fn((_p: number[]) => true);
  const createContext = vi.fn(() => ctx as unknown as AudioContext);
  const cues = createSpatialCues({ createContext, vibrate });
  cues.configure({ earcons: true, spatial: true, haptics: true, headphones: over.headphones ?? false });
  return { ctx, cues, vibrate, createContext };
}

/** Run the scheduler for `ms` of wall time with audio time advancing in step. */
function run(ctx: FakeCtx, ms: number) {
  for (let t = 0; t < ms; t += 25) {
    ctx.advance(0.025);
    vi.advanceTimersByTime(25);
  }
}

beforeEach(() => {
  vi.useFakeTimers({ now: new Date('2026-11-23T10:00:00Z') });
});
afterEach(() => {
  vi.useRealTimers();
});

describe('mappings', () => {
  it('pan = clamp((cx - 0.5) * 2.2)', () => {
    expect(panForX(0.5)).toBe(0);
    expect(panForX(0.25)).toBeCloseTo(-0.55);
    expect(panForX(0.75)).toBeCloseTo(0.55);
    expect(panForX(0)).toBe(-1);
    expect(panForX(1)).toBe(1);
    expect(panForX(Number.NaN)).toBe(-1);
  });

  it('pitch: higher in the picture is higher, 440..880 Hz', () => {
    expect(pitchForY(0)).toBeCloseTo(880);
    expect(pitchForY(1)).toBeCloseTo(440);
    expect(pitchForY(0.5)).toBeCloseTo(440 * Math.SQRT2);
    expect(pitchForY(0.2)).toBeGreaterThan(pitchForY(0.8));
  });

  it('interval: ~900 ms off-centre -> ~140 ms at the centre', () => {
    expect(intervalForTarget(0.5, 0.5)).toBe(140);
    expect(intervalForTarget(0, 0.5)).toBe(900);
    expect(intervalForTarget(0, 0)).toBe(900);
    expect(intervalForTarget(0.6, 0.5)).toBeLessThan(intervalForTarget(0.8, 0.5));
    expect(offCenter(0.75, 0.5)).toBeCloseTo(0.5);
  });

  it('gain rises a little with area; HRTF positions are in front', () => {
    expect(gainForArea(0)).toBeCloseTo(0.16);
    expect(gainForArea(1)).toBeCloseTo(0.28);
    expect(gainForArea(0.25)).toBeGreaterThan(gainForArea(0.01));
    const left = hrtfPosition(0, 0.5);
    expect(left.x).toBeLessThan(0);
    expect(left.z).toBeLessThan(0);
    expect(hrtfPosition(0.5, 0).y).toBeGreaterThan(0);
  });
});

describe('engine', () => {
  it('unlock creates and resumes the AudioContext synchronously', () => {
    const { cues, ctx, createContext } = setup();
    void cues.unlock();
    expect(createContext).toHaveBeenCalledTimes(1);
    expect(ctx.resume).toHaveBeenCalledTimes(1);
    expect(ctx.state).toBe('running');
    void cues.unlock();
    expect(createContext).toHaveBeenCalledTimes(1);
    expect(cues.supported).toBe(true);
  });

  it('aiming beeps: pan from x, pitch from y, interval from centredness, scheduled on audio time', async () => {
    const { cues, ctx } = setup();
    await cues.unlock();
    cues.startTracking();
    cues.setTarget({ cx: 0.1, cy: 0.2, area: 0.01, centered: false });
    run(ctx, 3_000);
    const beeps = ctx.oscs();
    expect(beeps.length).toBeGreaterThanOrEqual(3);
    expect(beeps.length).toBeLessThanOrEqual(5); // ~interval 700+ ms over 3 s
    const b = beeps[0]!;
    expect(b.frequency.events[0]![1]).toBeCloseTo(pitchForY(0.2));
    const panner = ctx.nodes.find((n) => n.kind === 'stereo') as unknown as { pan: FakeParam };
    expect(panner.pan.events[0]![1]).toBeCloseTo(panForX(0.1));
    const starts = beeps.map((x) => x.startAt!);
    const gap = (starts[1]! - starts[0]!) * 1000;
    expect(gap).toBeCloseTo(intervalForTarget(0.1, 0.2), 0);
    for (const x of beeps) expect(x.stopAt! - x.startAt!).toBeLessThan(0.1);
  });

  it('beeps speed up near the centre', async () => {
    const { cues, ctx } = setup();
    await cues.unlock();
    cues.startTracking();
    cues.setTarget({ cx: 0.4, cy: 0.5, area: 0.05, centered: false });
    const before = ctx.oscs().length;
    run(ctx, 1_000);
    const near = ctx.oscs().length - before;
    expect(near).toBeGreaterThanOrEqual(3); // interval ~292 ms
  });

  it('centred -> steady two-tone lock + one haptic', async () => {
    const { cues, ctx, vibrate } = setup();
    await cues.unlock();
    cues.startTracking();
    cues.setTarget({ cx: 0.2, cy: 0.5, area: 0.05, centered: false });
    cues.setTarget({ cx: 0.5, cy: 0.5, area: 0.05, centered: true });
    expect(vibrate).toHaveBeenCalledWith([40, 60, 40]);
    const n0 = ctx.oscs().length;
    run(ctx, 1_100);
    const lock = ctx.oscs().slice(n0 - 2);
    const freqs = new Set(lock.map((o) => Math.round(o.frequency.events[0]![1])));
    expect(freqs).toEqual(new Set(CUE_MAPPING.lockHz));
    cues.setTarget({ cx: 0.51, cy: 0.5, area: 0.05, centered: true });
    expect(vibrate).toHaveBeenCalledTimes(1);
  });

  it('setTarget(null) plays one descending lost blip, then silence', async () => {
    const { cues, ctx } = setup();
    await cues.unlock();
    cues.startTracking();
    cues.setTarget({ cx: 0.2, cy: 0.5, area: 0.05, centered: false });
    run(ctx, 200);
    cues.setTarget(null);
    const blip = ctx.oscs().at(-1)!;
    const ramp = blip.frequency.events.find((e) => e[0] === 'exp');
    expect(ramp && ramp[1]).toBeLessThan(blip.frequency.events[0]![1]);
    const n = ctx.oscs().length;
    run(ctx, 2_000);
    expect(ctx.oscs().length).toBe(n);
    cues.setTarget(null);
    expect(ctx.oscs().length).toBe(n); // no second blip
  });

  it('headphones mode uses an HRTF panner', async () => {
    const { cues, ctx } = setup({ headphones: true });
    await cues.unlock();
    cues.startTracking();
    cues.setTarget({ cx: 0.1, cy: 0.5, area: 0.05, centered: false });
    const p = ctx.nodes.find((n) => n.kind === 'hrtf') as unknown as { panningModel: string; positionX: FakeParam };
    expect(p.panningModel).toBe('HRTF');
    expect(p.positionX.events[0]![1]).toBeLessThan(0);
  });

  it('ducking lowers the master gain to ~30%', async () => {
    const { cues, ctx } = setup();
    await cues.unlock();
    const master = ctx.nodes.find((n) => n.kind === 'gain' && n.connected.has(ctx.destination)) as unknown as { gain: FakeParam };
    cues.setDucked(true);
    expect(master.gain.value).toBeCloseTo(0.3);
    cues.setDucked(false);
    expect(master.gain.value).toBe(1);
  });

  it('configure flags: no earcon sound when earcons are off, no beeps when spatial is off, no haptics when off', async () => {
    const { cues, ctx, vibrate } = setup();
    await cues.unlock();
    cues.configure({ earcons: false, spatial: false, haptics: true, headphones: false });
    cues.earcon('found');
    expect(ctx.oscs()).toHaveLength(0);
    expect(vibrate).toHaveBeenCalledWith([40, 60, 40]);
    cues.startTracking();
    cues.setTarget({ cx: 0.2, cy: 0.5, area: 0.05, centered: false });
    run(ctx, 1_000);
    expect(ctx.oscs()).toHaveLength(0);
    cues.configure({ earcons: true, spatial: true, haptics: false, headphones: false });
    cues.earcon('error');
    expect(ctx.oscs().length).toBe(2);
    expect(vibrate).toHaveBeenCalledTimes(1);
  });

  it('earcons are short and haptics follow the patterns', async () => {
    const { cues, ctx, vibrate } = setup();
    await cues.unlock();
    for (const k of ['session_start', 'session_end', 'listening', 'capture', 'working', 'found', 'lost', 'error'] as const) {
      const n0 = ctx.nodes.length;
      cues.earcon(k);
      const srcs = ctx.nodes.slice(n0).filter((n): n is FakeSource => n instanceof FakeSource);
      expect(srcs.length).toBeGreaterThan(0);
      const start = Math.min(...srcs.map((s) => s.startAt!));
      const end = Math.max(...srcs.map((s) => s.stopAt!));
      expect(end - start).toBeLessThan(0.3);
      vi.advanceTimersByTime(400);
    }
    expect(vibrate.mock.calls.map((c) => c[0])).toEqual([[20], [40, 60, 40], [80, 40, 80]]);
  });

  it('does not leak nodes: voices disconnect after they end, and the count is bounded', async () => {
    const { cues, ctx } = setup();
    await cues.unlock();
    cues.startTracking();
    cues.setTarget({ cx: 0.5, cy: 0.45, area: 0.05, centered: false });
    run(ctx, 10_000);
    expect(cues.activeVoices).toBeLessThanOrEqual(4);
    const ended = ctx.nodes.filter((n) => n instanceof FakeSource && n.stopAt !== null && n.stopAt <= ctx.currentTime);
    expect(ended.length).toBeGreaterThan(30);
    for (const n of ended) expect(n.disconnected).toBe(true);
    cues.stopTracking();
    run(ctx, 1_000);
    expect(cues.activeVoices).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('nothing plays before unlock; close frees everything', async () => {
    const { cues, ctx, createContext } = setup();
    cues.earcon('found');
    cues.startTracking();
    cues.setTarget({ cx: 0.2, cy: 0.5, area: 0.05, centered: false });
    expect(createContext).not.toHaveBeenCalled();
    await cues.unlock();
    cues.setTarget({ cx: 0.2, cy: 0.5, area: 0.05, centered: false });
    expect(cues.activeVoices).toBeGreaterThan(0);
    await cues.close();
    expect(cues.activeVoices).toBe(0);
    expect(ctx.close).toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    cues.earcon('found');
    expect(cues.activeVoices).toBe(0);
  });
});
