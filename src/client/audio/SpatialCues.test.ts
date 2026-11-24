/**
 * SpatialCues tests. FIXTURE: a fake AudioContext that records the node graph, AudioParam automation calls and
 * start/stop times; no real audio is produced.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LIMITS } from '../../shared/protocol.js';
import type { CueTarget } from '../contracts.js';
import {
  AUDIBLE_TAIL_MS,
  BEACON,
  CALIBRATION_TONE,
  alignmentError,
  createSpatialCues,
  isFreshObservation,
  panForBox,
  panForX,
  pulseIntervalMs,
} from './SpatialCues.js';

class FakeParam {
  value = 0;
  events: [string, number, number, number?][] = [];
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
  setTargetAtTime(v: number, t: number, tc: number) {
    this.events.push(['target', v, t, tc]);
    this.value = v;
  }
  cancelScheduledValues(t: number) {
    this.events.push(['cancel', 0, t]);
  }
  cancelAndHoldAtTime(t: number) {
    this.events.push(['hold', 0, t]);
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

type GainLike = FakeNode & { gain: FakeParam };
type PanLike = FakeNode & { pan: FakeParam };

class FakeSource extends FakeNode {
  type = 'sine';
  frequency = new FakeParam();
  buffer: unknown = null;
  startAt: number | null = null;
  stopAt: number | null = null;
  stopCalls = 0;
  onended: (() => void) | null = null;
  start(t = 0) {
    this.startAt = t;
  }
  stop(t = 0) {
    this.stopCalls++;
    this.stopAt = t;
  }
}

class FakeCtx {
  nodes: FakeNode[] = [];
  currentTime = 0;
  sampleRate = 48_000;
  outputLatency = 0.05;
  baseLatency = 0.01;
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
    const n = new FakeNode('gain', this) as GainLike;
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
    const n = new FakeNode('stereo', this) as PanLike;
    n.pan = new FakeParam();
    return n;
  }
  /** FIXTURE: advance audio time and fire `ended` for sources whose stop time has passed. */
  advance(sec: number) {
    this.currentTime += sec;
    for (const n of this.nodes) {
      if (n instanceof FakeSource && n.stopAt !== null && n.stopAt <= this.currentTime + 1e-9 && n.onended) {
        const cb = n.onended;
        n.onended = null;
        cb();
      }
    }
  }
  oscs() {
    return this.nodes.filter((n): n is FakeSource => n instanceof FakeSource && n.kind === 'osc');
  }
  /** Beacon pulses: oscillators at the beacon frequency. */
  pulses() {
    return this.oscs().filter((o) => o.frequency.events[0]?.[1] === BEACON.freqHz);
  }
  master() {
    return this.nodes.find((n) => n.kind === 'gain' && n.connected.has(this.destination)) as GainLike;
  }
  beaconPanner() {
    return this.nodes.find((n) => n.kind === 'stereo') as PanLike;
  }
}

let perf = 0;

function setup(o: { shared?: boolean; volume?: number; beacon?: boolean } = {}) {
  const ctx = new FakeCtx();
  const vibrate = vi.fn((_p: number[]) => true);
  const createContext = vi.fn(() => ctx as unknown as AudioContext);
  let shared: FakeCtx | null = o.shared ? ctx : null;
  const cues = createSpatialCues(
    o.shared
      ? { getContext: () => shared as unknown as AudioContext | null, createContext, vibrate, perfNow: () => perf }
      : { createContext, vibrate, perfNow: () => perf },
  );
  cues.configure({ earcons: true, beacon: o.beacon ?? true, haptics: true, volume: o.volume ?? 0.5 });
  return { ctx, cues, vibrate, createContext, setShared: (c: FakeCtx | null) => (shared = c) };
}

/** Run the scheduler for `ms` of wall time with audio time (and perf time) advancing in step. */
function run(ctx: FakeCtx, ms: number) {
  for (let t = 0; t < ms; t += 25) {
    ctx.advance(0.025);
    perf += 25;
    vi.advanceTimersByTime(25);
  }
}

const tgt = (cx: number, cy = 0.5, over: Partial<CueTarget> = {}): CueTarget => ({ cx, cy, area: 0.05, centered: false, observedAt: Date.now(), ...over });

beforeEach(() => {
  perf = 0;
  vi.useFakeTimers({ now: new Date('2026-11-23T10:00:00Z') });
});
afterEach(() => {
  vi.useRealTimers();
});

describe('pure mappings', () => {
  it('pan = clamp(2*cx - 1): left / centre / right', () => {
    expect(panForX(0)).toBe(-1);
    expect(panForX(0.25)).toBeCloseTo(-0.5);
    expect(panForX(0.5)).toBe(0);
    expect(panForX(0.75)).toBeCloseTo(0.5);
    expect(panForX(1)).toBe(1);
    expect(panForX(-0.3)).toBe(-1);
    expect(panForX(1.4)).toBe(1);
    expect(panForX(Number.NaN)).toBe(0);
  });

  it('panForBox uses the box centre for portrait and landscape boxes', () => {
    // Portrait (tall, narrow) box on the left of the picture.
    expect(panForBox({ x: 0.05, y: 0.1, w: 0.1, h: 0.8 })).toBeCloseTo(-0.8);
    // Landscape (wide, short) box on the right.
    expect(panForBox({ x: 0.6, y: 0.45, w: 0.3, h: 0.1 })).toBeCloseTo(0.5);
    // Centred boxes of either shape -> 0.
    expect(panForBox({ x: 0.45, y: 0, w: 0.1, h: 1 })).toBeCloseTo(0);
    expect(panForBox({ x: 0, y: 0.45, w: 1, h: 0.1 })).toBeCloseTo(0);
    // Vertical position never affects pan.
    expect(panForBox({ x: 0.1, y: 0, w: 0.2, h: 0.1 })).toBeCloseTo(panForBox({ x: 0.1, y: 0.8, w: 0.2, h: 0.1 }));
  });

  it('pulse interval = alignment: far -> findPulseFarMs, centre -> findPulseNearMs, combining x and y error', () => {
    expect(pulseIntervalMs(0.5, 0.5)).toBe(LIMITS.findPulseNearMs);
    expect(pulseIntervalMs(0, 0.5)).toBe(LIMITS.findPulseFarMs);
    expect(pulseIntervalMs(0.5, 1)).toBe(LIMITS.findPulseFarMs);
    expect(pulseIntervalMs(0, 0)).toBe(LIMITS.findPulseFarMs);
    expect(pulseIntervalMs(0.6, 0.5)).toBeLessThan(pulseIntervalMs(0.8, 0.5));
    // Vertical error counts too: same x, off vertically -> slower.
    expect(pulseIntervalMs(0.6, 0.8)).toBeGreaterThan(pulseIntervalMs(0.6, 0.5));
    expect(alignmentError(0.75, 0.5)).toBeCloseTo(0.5);
    expect(pulseIntervalMs(0.75, 0.5)).toBe(Math.round((LIMITS.findPulseNearMs + LIMITS.findPulseFarMs) / 2));
  });

  it('freshness uses LIMITS.findObservationMaxAgeMs', () => {
    expect(isFreshObservation(1_000, 1_000 + LIMITS.findObservationMaxAgeMs)).toBe(true);
    expect(isFreshObservation(1_000, 1_001 + LIMITS.findObservationMaxAgeMs)).toBe(false);
  });
});

describe('graph and context', () => {
  it('shared context: no AudioContext is created when getContext is provided; graph is persistent', async () => {
    const { cues, ctx, createContext } = setup({ shared: true });
    ctx.state = 'running';
    await cues.unlock();
    expect(createContext).not.toHaveBeenCalled();
    cues.startTracking();
    const master = ctx.master();
    const panner = ctx.beaconPanner();
    expect(panner.connected.has(master)).toBe(true);
    expect(master.gain.value).toBeCloseTo(0.5); // cueVolume
    for (let i = 0; i < 10; i++) {
      cues.setTarget(tgt(0.2));
      for (const p of ctx.pulses().filter((x) => !x.disconnected)) {
        const env = [...p.connected][0] as GainLike;
        expect(env.connected.has(panner)).toBe(true);
      }
      run(ctx, 200);
    }
    expect(ctx.pulses().length).toBeGreaterThan(2);
    expect(ctx.nodes.filter((n) => n.kind === 'stereo')).toHaveLength(1); // one persistent panner
    await cues.close();
    expect(ctx.close).not.toHaveBeenCalled(); // the shared context belongs to the player
  });

  it('shared context null before unlock: silent, nothing created', async () => {
    const { cues, ctx, setShared, createContext } = setup({ shared: true });
    setShared(null);
    await cues.unlock();
    cues.earcon('found');
    expect(ctx.nodes.length).toBe(1); // destination only
    expect(createContext).not.toHaveBeenCalled();
  });

  it('own context only without getContext; unlock is synchronous', () => {
    const { cues, ctx, createContext } = setup();
    void cues.unlock();
    expect(createContext).toHaveBeenCalledTimes(1);
    expect(ctx.resume).toHaveBeenCalledTimes(1);
    void cues.unlock();
    expect(createContext).toHaveBeenCalledTimes(1);
  });

  it('volume and ducking drive the master gain', async () => {
    const { cues, ctx } = setup({ volume: 0.8 });
    await cues.unlock();
    expect(ctx.master().gain.value).toBeCloseTo(0.8);
    cues.setDucked(true);
    expect(ctx.master().gain.value).toBeCloseTo(0.24);
    cues.setDucked(false);
    cues.configure({ earcons: true, beacon: true, haptics: true, volume: 0.2 });
    expect(ctx.master().gain.value).toBeCloseTo(0.2);
  });
});

describe('beacon', () => {
  it('pulses are short, panned from cx, spaced by the alignment interval on the audio clock', async () => {
    const { cues, ctx } = setup();
    await cues.unlock();
    cues.startTracking();
    cues.setTarget(tgt(0.1, 0.5));
    // Observations arrive ~5/s; keep the target fresh.
    for (let i = 0; i < 15; i++) {
      run(ctx, 200);
      cues.setTarget(tgt(0.1, 0.5));
    }
    const pulses = ctx.pulses();
    const interval = pulseIntervalMs(0.1, 0.5);
    expect(pulses.length).toBeGreaterThanOrEqual(Math.floor(3_000 / interval) - 1);
    expect(pulses.length).toBeLessThanOrEqual(Math.ceil(3_000 / interval) + 1);
    const gap = (pulses[1]!.startAt! - pulses[0]!.startAt!) * 1000;
    expect(gap).toBeCloseTo(interval, 0);
    for (const p of pulses) expect(p.stopAt! - p.startAt!).toBeLessThan(0.08);
    expect(ctx.beaconPanner().pan.value).toBeCloseTo(panForX(0.1));
  });

  it('envelope: linear attack ~8 ms from 0 and release ~40 ms to 0 (no clicks)', async () => {
    const { cues, ctx } = setup();
    await cues.unlock();
    cues.startTracking();
    cues.setTarget(tgt(0.2));
    const p = ctx.pulses()[0]!;
    const env = [...p.connected][0] as GainLike;
    const ev = env.gain.events;
    const at = p.startAt!;
    expect(ev[0]).toEqual(['set', 0, at]);
    expect(ev[1]![0]).toBe('lin');
    expect(ev[1]![1]).toBeCloseTo(BEACON.peakGain);
    expect(ev[1]![2] - at).toBeCloseTo(BEACON.attackSec);
    expect(ev[2]![0]).toBe('set');
    expect(ev[2]![2]).toBeCloseTo(at + BEACON.durSec - BEACON.releaseSec);
    expect(ev[3]).toEqual(['lin', 0, at + BEACON.durSec]);
    expect(p.type).toBe('sine');
  });

  it('pan smoothing: moves use setTargetAtTime (tc 0.05-0.08 s) on the shared panner; reacquire jumps', async () => {
    const { cues, ctx } = setup();
    await cues.unlock();
    cues.startTracking();
    cues.setTarget(tgt(0.2));
    const pan = ctx.beaconPanner().pan;
    expect(pan.events.at(-1)![0]).toBe('set'); // first acquisition: jump
    expect(pan.events.at(-1)![1]).toBeCloseTo(-0.6);
    run(ctx, 100);
    cues.setTarget(tgt(0.8));
    const last = pan.events.at(-1)!;
    expect(last[0]).toBe('target');
    expect(last[1]).toBeCloseTo(0.6);
    expect(last[3]).toBeGreaterThanOrEqual(0.05);
    expect(last[3]).toBeLessThanOrEqual(0.08);
    cues.setTarget(null);
    cues.setTarget(tgt(0.3));
    expect(pan.events.at(-1)![0]).toBe('set');
  });

  it('stale observation -> no pulse, and silence as soon as the observation ages out', async () => {
    const { cues, ctx } = setup();
    await cues.unlock();
    cues.startTracking();
    cues.setTarget(tgt(0.2, 0.5, { observedAt: Date.now() - LIMITS.findObservationMaxAgeMs - 1 }));
    run(ctx, 1_000);
    expect(ctx.pulses()).toHaveLength(0);
    cues.setTarget(tgt(0.2));
    expect(ctx.pulses().length).toBeGreaterThan(0);
    run(ctx, LIMITS.findObservationMaxAgeMs + 50); // no new observation
    const n = ctx.pulses().length;
    expect(cues.scheduledPulses).toBe(0);
    run(ctx, 2_000);
    expect(ctx.pulses().length).toBe(n);
  });

  it('centered -> no pulses (the controller plays the confirmation)', async () => {
    const { cues, ctx } = setup();
    await cues.unlock();
    cues.startTracking();
    cues.setTarget(tgt(0.5, 0.5, { centered: true }));
    run(ctx, 500);
    expect(ctx.pulses()).toHaveLength(0);
    cues.setTarget(tgt(0.3));
    expect(ctx.pulses()).toHaveLength(1);
    cues.setTarget(tgt(0.5, 0.5, { centered: true }));
    expect(cues.scheduledPulses).toBe(0);
  });

  it('null target or no tracking -> no pulses', async () => {
    const { cues, ctx } = setup();
    await cues.unlock();
    cues.setTarget(tgt(0.2));
    run(ctx, 500);
    expect(ctx.pulses()).toHaveLength(0); // not tracking
    cues.setTarget(null);
    cues.startTracking();
    run(ctx, 500);
    expect(ctx.pulses()).toHaveLength(0);
  });

  it('stopTracking cancels scheduled sources immediately; sounding ones fade and stop within ~15 ms', async () => {
    const { cues, ctx } = setup();
    await cues.unlock();
    cues.startTracking();
    cues.setTarget(tgt(0.5, 0.55)); // short interval -> look-ahead holds a future pulse
    run(ctx, 10);
    const all = ctx.pulses();
    expect(all.length).toBeGreaterThan(0);
    cues.stopTracking();
    expect(cues.scheduledPulses).toBe(0);
    for (const p of all) {
      if (p.startAt! > ctx.currentTime) {
        expect(p.disconnected).toBe(true);
        expect(p.stopCalls).toBeGreaterThan(1);
      } else {
        expect(p.stopAt!).toBeLessThanOrEqual(ctx.currentTime + 0.016);
      }
    }
    ctx.advance(0.02);
    expect(cues.activeVoices).toBe(0);
    expect(cues.timerCount).toBe(0);
    for (const p of all) expect(p.disconnected).toBe(true);
  });

  it('setSuppressed(true) silences immediately and resumes on false', async () => {
    const { cues, ctx } = setup();
    await cues.unlock();
    cues.startTracking();
    cues.setTarget(tgt(0.2));
    expect(cues.scheduledPulses).toBe(1);
    cues.setSuppressed(true);
    expect(cues.scheduledPulses).toBe(0);
    const n = ctx.pulses().length;
    for (let i = 0; i < 5; i++) {
      run(ctx, 200);
      cues.setTarget(tgt(0.2));
    }
    expect(ctx.pulses().length).toBe(n);
    cues.setSuppressed(false);
    expect(ctx.pulses().length).toBe(n + 1);
  });

  it('beacon disabled by configure -> no pulses (earcons still play)', async () => {
    const { cues, ctx } = setup({ beacon: false });
    await cues.unlock();
    cues.startTracking();
    cues.setTarget(tgt(0.2));
    run(ctx, 500);
    expect(ctx.pulses()).toHaveLength(0);
    cues.earcon('found');
    expect(ctx.oscs().length).toBe(2);
  });

  it('repeated start/stop cycles leak no timers, voices or nodes', async () => {
    const { cues, ctx } = setup();
    await cues.unlock();
    for (let i = 0; i < 20; i++) {
      cues.startTracking();
      cues.startTracking(); // idempotent
      cues.setTarget(tgt(0.3 + (i % 3) * 0.1));
      run(ctx, 300);
      cues.stopTracking();
      expect(cues.timerCount).toBe(0);
    }
    ctx.advance(0.1);
    expect(cues.activeVoices).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    for (const p of ctx.pulses()) expect(p.disconnected).toBe(true);
  });

  it('audibleUntil covers the scheduled pulse + output latency + tail, and drops after cancel', async () => {
    const { cues, ctx } = setup();
    await cues.unlock();
    expect(cues.audibleUntil).toBe(Number.NEGATIVE_INFINITY);
    cues.startTracking();
    cues.setTarget(tgt(0.2));
    const p = ctx.pulses()[0]!;
    const expected = perf + (p.startAt! + BEACON.durSec - ctx.currentTime) * 1000 + 60 + AUDIBLE_TAIL_MS;
    expect(cues.audibleUntil).toBeCloseTo(expected, 3);
    cues.stopTracking(); // not started yet -> cancelled outright
    expect(cues.audibleUntil).toBeLessThan(expected);
    cues.earcon('found');
    expect(cues.audibleUntil).toBeGreaterThan(perf + 200);
  });
});

describe('calibration tone', () => {
  it('plays ~0.6 s at pan -1 / +1 / 0 and resolves when done', async () => {
    const { cues, ctx } = setup();
    await cues.unlock();
    for (const [ch, pan] of [
      ['left', -1],
      ['right', 1],
      ['centre', 0],
    ] as const) {
      let done = false;
      const p = cues.calibrationTone(ch).then(() => (done = true));
      const osc = ctx.oscs().at(-1)!;
      expect(osc.frequency.events[0]![1]).toBe(CALIBRATION_TONE.freqHz);
      expect(osc.stopAt! - osc.startAt!).toBeCloseTo(CALIBRATION_TONE.durSec, 1);
      const env = [...osc.connected][0] as GainLike;
      const panner = [...env.connected][0] as PanLike;
      expect(panner.kind).toBe('stereo');
      expect(panner.pan.value).toBe(pan);
      expect(panner.connected.has(ctx.master())).toBe(true);
      await Promise.resolve();
      expect(done).toBe(false);
      ctx.advance(0.7);
      await p;
      expect(done).toBe(true);
      expect(panner.disconnected).toBe(true);
    }
    expect(cues.timerCount).toBe(0);
  });

  it('cancelCalibrationTone / stopTracking stop it and resolve; safety timer resolves if ended never fires', async () => {
    const { cues, ctx } = setup();
    await cues.unlock();
    const p1 = cues.calibrationTone('left');
    cues.cancelCalibrationTone();
    await p1;
    expect(cues.activeVoices).toBe(0);
    const p2 = cues.calibrationTone('right');
    cues.stopTracking();
    await p2;
    const p3 = cues.calibrationTone('centre');
    ctx.state = 'suspended'; // ended would never fire
    vi.advanceTimersByTime(1_100);
    await p3;
    expect(cues.timerCount).toBe(0);
  });
});

describe('earcons and haptics', () => {
  it('earcons are short; haptics follow the patterns; found = confirmation chime', async () => {
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

  it('earcons off: haptic only; haptics off: sound only', async () => {
    const { cues, ctx, vibrate } = setup();
    await cues.unlock();
    cues.configure({ earcons: false, beacon: true, haptics: true, volume: 0.5 });
    cues.earcon('found');
    expect(ctx.oscs()).toHaveLength(0);
    expect(vibrate).toHaveBeenCalledTimes(1);
    cues.configure({ earcons: true, beacon: true, haptics: false, volume: 0.5 });
    cues.earcon('error');
    expect(ctx.oscs()).toHaveLength(2);
    expect(vibrate).toHaveBeenCalledTimes(1);
  });

  it('nothing plays before unlock; close frees everything', async () => {
    const { cues, ctx, createContext } = setup();
    cues.earcon('found');
    cues.startTracking();
    cues.setTarget(tgt(0.2));
    expect(createContext).not.toHaveBeenCalled();
    await cues.unlock();
    cues.setTarget(tgt(0.2));
    expect(cues.activeVoices).toBeGreaterThan(0);
    await cues.close();
    expect(cues.activeVoices).toBe(0);
    expect(ctx.close).toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    cues.earcon('found');
    expect(cues.activeVoices).toBe(0);
  });
});
