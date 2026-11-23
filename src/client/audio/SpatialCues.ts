/**
 * Non-speech audio + haptics: find-mode aiming cues and short event earcons. Implements SpatialCueEngine.
 *
 * Aiming cue (startTracking + setTarget): short soft beeps whose
 *   - pan follows the target's horizontal position in the PICTURE: pan = clamp((cx - 0.5) * 2.2, -1, 1)
 *     (StereoPannerNode; with configure({ headphones: true }) an HRTF PannerNode positioned from (cx, cy));
 *   - pitch follows its vertical position: higher in the picture = higher pitch, 440 Hz (bottom) .. 880 Hz (top),
 *     exponential so equal moves sound like equal steps;
 *   - repetition interval follows how far it is from the picture centre: ~900 ms far off-centre -> ~140 ms near it;
 *   - volume rises a little with how much of the picture it fills (never a distance claim).
 * When the target is centred the beeps become a steady two-tone "lock" (plus a haptic on entry). setTarget(null)
 * plays one soft descending "lost" blip, then silence.
 *
 * Scheduling uses AudioContext time with a small look-ahead (a 25 ms timer only tops up the schedule), so beep
 * timing does not inherit setInterval jitter. Every voice is a few short-lived nodes that disconnect on `ended`;
 * the number of live voices is capped.
 *
 * Earcons are quiet one-shots under 300 ms. Haptics use navigator.vibrate when present and enabled.
 * Positions are image-relative aiming help only, never physical distance or walking directions.
 */
import type { CueTarget, Earcon, SpatialCueEngine } from '../contracts.js';

// ---------------------------------------------------------------------------
// Pure mappings (exported for tests and for documentation)
// ---------------------------------------------------------------------------

export const CUE_MAPPING = {
  panScale: 2.2,
  lowHz: 440,
  highHz: 880,
  minIntervalMs: 140,
  maxIntervalMs: 900,
  lockIntervalMs: 520,
  lockHz: [660, 990] as const,
  baseGain: 0.16,
  areaGain: 0.12,
  duckedGain: 0.3,
  beepSec: 0.05,
} as const;

const clamp = (v: number, lo: number, hi: number) => (Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : lo);

/** Stereo pan for a horizontal picture position (0 = left edge, 1 = right edge). */
export function panForX(cx: number): number {
  return clamp((clamp(cx, 0, 1) - 0.5) * CUE_MAPPING.panScale, -1, 1);
}

/** Beep pitch for a vertical picture position (0 = top -> 880 Hz, 1 = bottom -> 440 Hz). */
export function pitchForY(cy: number): number {
  return CUE_MAPPING.lowHz * 2 ** (1 - clamp(cy, 0, 1));
}

/** 0 at the picture centre, 1 at the middle of an edge (and beyond, clamped). */
export function offCenter(cx: number, cy: number): number {
  return clamp(Math.hypot((clamp(cx, 0, 1) - 0.5) * 2, (clamp(cy, 0, 1) - 0.5) * 2), 0, 1);
}

/** Beep repetition interval (ms): ~900 far off-centre -> ~140 near the centre. */
export function intervalForTarget(cx: number, cy: number): number {
  const { minIntervalMs: lo, maxIntervalMs: hi } = CUE_MAPPING;
  return Math.round(lo + (hi - lo) * offCenter(cx, cy));
}

/** Beep gain: a little louder the more of the picture the item fills (0.16 .. 0.28). */
export function gainForArea(area: number): number {
  return CUE_MAPPING.baseGain + CUE_MAPPING.areaGain * Math.sqrt(clamp(area, 0, 1));
}

/** HRTF source position: azimuth +-54 deg from picture x, elevation +-30 deg from picture y, 1 unit in front. */
export function hrtfPosition(cx: number, cy: number): { x: number; y: number; z: number } {
  const az = (clamp(cx, 0, 1) - 0.5) * (Math.PI * 0.6);
  const el = (0.5 - clamp(cy, 0, 1)) * (Math.PI / 3);
  return { x: Math.sin(az) * Math.cos(el), y: Math.sin(el), z: -Math.cos(az) * Math.cos(el) };
}

export const HAPTIC_PATTERNS: Partial<Record<Earcon | 'lock', number[]>> = {
  capture: [20],
  found: [40, 60, 40],
  lock: [40, 60, 40],
  error: [80, 40, 80],
};

// ---------------------------------------------------------------------------
// Engine
// ---------------------------------------------------------------------------

export interface SpatialCuesOptions {
  /** Defaults to new AudioContext({ latencyHint: 'interactive' }). */
  createContext?: () => AudioContext;
  /** Defaults to navigator.vibrate when available; null disables haptics entirely. */
  vibrate?: ((pattern: number[]) => boolean) | null;
  /** Look-ahead window scheduled on each tick (s). Default 0.1. */
  lookaheadSec?: number;
  /** Scheduler top-up period (ms). Default 25. */
  tickMs?: number;
  /** Max simultaneously alive voices. Default 24. */
  maxVoices?: number;
}

export interface SpatialCuesDiagnostics {
  /** Voices currently scheduled or sounding (each a few nodes). */
  readonly activeVoices: number;
  readonly tracking: boolean;
}

interface Voice {
  src: AudioScheduledSourceNode;
  nodes: AudioNode[];
}

interface ToneSpec {
  /** Seconds after "now". */
  offset: number;
  dur: number;
  freq: number;
  freqEnd?: number;
  type?: OscillatorType;
  gain: number;
  noise?: boolean;
}

const E = 0.14; // earcon base gain (quiet)
const EARCONS: Record<Earcon, ToneSpec[]> = {
  session_start: [
    { offset: 0, dur: 0.09, freq: 523.25, gain: E },
    { offset: 0.1, dur: 0.13, freq: 783.99, gain: E },
  ],
  session_end: [
    { offset: 0, dur: 0.09, freq: 783.99, gain: E },
    { offset: 0.1, dur: 0.15, freq: 523.25, gain: E },
  ],
  listening: [{ offset: 0, dur: 0.03, freq: 1320, type: 'triangle', gain: E * 0.6 }],
  capture: [
    { offset: 0, dur: 0.025, freq: 0, gain: E * 1.4, noise: true },
    { offset: 0.07, dur: 0.035, freq: 0, gain: E, noise: true },
  ],
  working: [{ offset: 0, dur: 0.035, freq: 880, gain: E * 0.4 }],
  found: [
    { offset: 0, dur: 0.12, freq: 1046.5, gain: E },
    { offset: 0.06, dur: 0.2, freq: 1567.98, gain: E * 0.9 },
  ],
  lost: [{ offset: 0, dur: 0.14, freq: 520, freqEnd: 330, type: 'triangle', gain: E * 0.8 }],
  error: [
    { offset: 0, dur: 0.09, freq: 160, type: 'square', gain: E * 0.5 },
    { offset: 0.14, dur: 0.09, freq: 160, type: 'square', gain: E * 0.5 },
  ],
};

const HAPTIC_DEDUPE_MS = 300;

function defaultVibrate(): ((pattern: number[]) => boolean) | null {
  if (typeof navigator === 'undefined' || typeof navigator.vibrate !== 'function') return null;
  return (p) => {
    try {
      return navigator.vibrate(p);
    } catch {
      return false;
    }
  };
}

function defaultContextFactory(): (() => AudioContext) | null {
  const g = globalThis as unknown as { AudioContext?: typeof AudioContext; webkitAudioContext?: typeof AudioContext };
  const Ctor = g.AudioContext ?? g.webkitAudioContext;
  return Ctor ? () => new Ctor({ latencyHint: 'interactive' }) : null;
}

export function createSpatialCues(opts: SpatialCuesOptions = {}): SpatialCueEngine & SpatialCuesDiagnostics {
  const createContext = opts.createContext ?? defaultContextFactory();
  const vibrate = opts.vibrate === undefined ? defaultVibrate() : opts.vibrate;
  const lookaheadSec = opts.lookaheadSec ?? 0.1;
  const tickMs = opts.tickMs ?? 25;
  const maxVoices = opts.maxVoices ?? 24;

  let ctx: AudioContext | null = null;
  let master: GainNode | null = null;
  let noiseBuffer: AudioBuffer | null = null;
  const voices = new Set<Voice>();
  let config = { earcons: true, spatial: true, haptics: true, headphones: false };
  let ducked = false;
  let tracking = false;
  let target: CueTarget | null = null;
  let nextCueAt = 0;
  let timer: ReturnType<typeof setInterval> | null = null;
  let lastVibration: { key: string; at: number } | null = null;
  let closed = false;

  const running = () => ctx !== null && master !== null && ctx.state === 'running';

  function buzz(pattern: number[] | undefined) {
    if (!pattern || !config.haptics || !vibrate) return;
    const now = Date.now();
    const key = pattern.join(',');
    if (lastVibration && lastVibration.key === key && now - lastVibration.at < HAPTIC_DEDUPE_MS) return;
    lastVibration = { key, at: now };
    vibrate(pattern);
  }

  function getNoise(c: AudioContext): AudioBuffer {
    if (noiseBuffer) return noiseBuffer;
    const len = Math.max(1, Math.round(c.sampleRate * 0.04));
    const buf = c.createBuffer(1, len, c.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / len) ** 2;
    noiseBuffer = buf;
    return buf;
  }

  function releaseVoice(v: Voice) {
    if (!voices.delete(v)) return;
    v.src.onended = null;
    for (const n of v.nodes) {
      try {
        n.disconnect();
      } catch {
        /* already disconnected */
      }
    }
  }

  /** Schedule one short voice at AudioContext time `at`. Returns false when capped or not running. */
  function voice(at: number, spec: ToneSpec, spatial: { pan: number } | { pos: { x: number; y: number; z: number } } | null): boolean {
    if (!running() || voices.size >= maxVoices) return false;
    const c = ctx!;
    let src: AudioScheduledSourceNode;
    if (spec.noise) {
      const b = c.createBufferSource();
      b.buffer = getNoise(c);
      src = b;
    } else {
      const o = c.createOscillator();
      o.type = spec.type ?? 'sine';
      o.frequency.setValueAtTime(spec.freq, at);
      if (spec.freqEnd) o.frequency.exponentialRampToValueAtTime(spec.freqEnd, at + spec.dur);
      src = o;
    }
    const g = c.createGain();
    const attack = Math.min(0.008, spec.dur / 4);
    g.gain.setValueAtTime(0.0001, at);
    g.gain.exponentialRampToValueAtTime(Math.max(0.0002, spec.gain), at + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, at + spec.dur);
    const nodes: AudioNode[] = [src, g];
    src.connect(g);
    let out: AudioNode = g;
    if (spatial && 'pos' in spatial && typeof c.createPanner === 'function') {
      const p = c.createPanner();
      p.panningModel = 'HRTF';
      p.distanceModel = 'inverse';
      p.refDistance = 1;
      if (p.positionX) {
        p.positionX.setValueAtTime(spatial.pos.x, at);
        p.positionY.setValueAtTime(spatial.pos.y, at);
        p.positionZ.setValueAtTime(spatial.pos.z, at);
      } else {
        (p as unknown as { setPosition(x: number, y: number, z: number): void }).setPosition(spatial.pos.x, spatial.pos.y, spatial.pos.z);
      }
      out.connect(p);
      out = p;
      nodes.push(p);
    } else if (spatial && 'pan' in spatial && typeof c.createStereoPanner === 'function') {
      const p = c.createStereoPanner();
      p.pan.setValueAtTime(spatial.pan, at);
      out.connect(p);
      out = p;
      nodes.push(p);
    }
    out.connect(master!);
    const v: Voice = { src, nodes };
    voices.add(v);
    src.onended = () => releaseVoice(v);
    src.start(at);
    src.stop(at + spec.dur + 0.02);
    return true;
  }

  const spatialFor = (t: CueTarget) => (config.headphones ? { pos: hrtfPosition(t.cx, t.cy) } : { pan: panForX(t.cx) });

  function scheduleAimCue(at: number, t: CueTarget): number {
    if (t.centered) {
      const [a, b] = CUE_MAPPING.lockHz;
      const g = gainForArea(t.area) * 0.9;
      voice(at, { offset: 0, dur: 0.07, freq: a, type: 'triangle', gain: g }, { pan: 0 });
      voice(at + 0.09, { offset: 0, dur: 0.09, freq: b, type: 'triangle', gain: g }, { pan: 0 });
      return CUE_MAPPING.lockIntervalMs;
    }
    voice(at, { offset: 0, dur: CUE_MAPPING.beepSec, freq: pitchForY(t.cy), type: 'sine', gain: gainForArea(t.area) }, spatialFor(t));
    return intervalForTarget(t.cx, t.cy);
  }

  function tick() {
    if (!tracking || !target || !config.spatial || !running()) return;
    const now = ctx!.currentTime;
    if (nextCueAt < now) nextCueAt = now + 0.01;
    const horizon = now + lookaheadSec;
    let guard = 0;
    while (nextCueAt < horizon && guard++ < 8) {
      nextCueAt += scheduleAimCue(nextCueAt, target) / 1000;
    }
  }

  function ensureTimer() {
    if (timer || !tracking) return;
    timer = setInterval(tick, tickMs);
  }

  function clearTimer() {
    if (timer) clearInterval(timer);
    timer = null;
  }

  function playEarcon(kind: Earcon) {
    if (!config.earcons || !running()) return;
    const base = ctx!.currentTime + 0.01;
    for (const spec of EARCONS[kind]) voice(base + spec.offset, spec, null);
  }

  const engine: SpatialCueEngine & SpatialCuesDiagnostics = {
    supported: createContext !== null,

    get activeVoices() {
      return voices.size;
    },
    get tracking() {
      return tracking;
    },

    unlock() {
      // Synchronous inside the gesture: create and resume before returning.
      if (closed || !createContext) return Promise.resolve();
      try {
        if (!ctx || ctx.state === 'closed') {
          ctx = createContext();
          master = ctx.createGain();
          master.gain.value = ducked ? CUE_MAPPING.duckedGain : 1;
          master.connect(ctx.destination);
          noiseBuffer = null;
        }
        const p = ctx.state === 'running' ? Promise.resolve() : ctx.resume();
        return Promise.resolve(p).catch(() => undefined);
      } catch {
        return Promise.resolve();
      }
    },

    setTarget(t: CueTarget | null) {
      const prev = target;
      if (!t) {
        target = null;
        if (prev && tracking && config.spatial && running()) {
          voice(ctx!.currentTime + 0.01, EARCONS.lost[0]!, spatialFor(prev));
        }
        return;
      }
      target = { cx: clamp(t.cx, 0, 1), cy: clamp(t.cy, 0, 1), area: clamp(t.area, 0, 1), centered: t.centered };
      if (!tracking) return;
      if (t.centered && !prev?.centered) buzz(HAPTIC_PATTERNS.lock);
      if (!running()) return;
      const now = ctx!.currentTime;
      // Re-acquired, newly centred, or moved nearer the centre: do not wait out the old (longer) interval.
      const soonest = now + (t.centered ? (prev?.centered ? CUE_MAPPING.lockIntervalMs : 0) : intervalForTarget(t.cx, t.cy)) / 1000;
      if (!prev || (t.centered && !prev.centered) || (!t.centered && prev.centered)) nextCueAt = now;
      else if (nextCueAt > soonest) nextCueAt = soonest;
      tick();
    },

    startTracking() {
      if (closed) return;
      if (!tracking) {
        tracking = true;
        nextCueAt = 0;
      }
      ensureTimer();
      tick();
    },

    stopTracking() {
      tracking = false;
      target = null;
      clearTimer();
    },

    earcon(kind: Earcon) {
      if (closed) return;
      buzz(HAPTIC_PATTERNS[kind]);
      playEarcon(kind);
    },

    setDucked(d: boolean) {
      if (ducked === d) return;
      ducked = d;
      if (master && ctx) master.gain.setTargetAtTime(d ? CUE_MAPPING.duckedGain : 1, ctx.currentTime, 0.04);
    },

    configure(o) {
      config = { ...o };
    },

    async close() {
      closed = true;
      engine.stopTracking();
      for (const v of [...voices]) {
        try {
          v.src.stop();
        } catch {
          /* not started */
        }
        releaseVoice(v);
      }
      const c = ctx;
      ctx = null;
      try {
        master?.disconnect();
      } catch {
        /* ignore */
      }
      master = null;
      if (c && c.state !== 'closed') await c.close().catch(() => undefined);
    },
  };
  return engine;
}
