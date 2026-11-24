/**
 * Non-speech audio + haptics: the Find-mode STEREO BEACON, the stereo calibration tone and short event earcons.
 * Implements SpatialCueEngine (contract v3).
 *
 * Positions are about the PHONE CAMERA PICTURE only (where the object is in the unmirrored rear-camera frame).
 * Nothing here encodes physical distance, room navigation or head-tracked 3D.
 *
 * Audio graph (all nodes live on ONE AudioContext, normally the AudioPlayer's - see `getContext`):
 *
 *   beacon pulse:  Oscillator(sine, BEACON.freqHz, ~70 ms) -> per-pulse Gain envelope (attack 8 ms, release 40 ms,
 *                  linear ramps from/to 0 so there are no clicks) -> shared StereoPannerNode -> master Gain -> out
 *   calibration:   Oscillator(sine, ~0.6 s) -> Gain envelope -> its own StereoPannerNode (pan -1 / +1 / 0) -> master
 *   earcons:       Oscillator / noise -> Gain envelope -> master (centred)
 *   master Gain    = settings.cueVolume (default 0.5) x (0.3 while ducked)
 *
 * The beacon's StereoPannerNode and the master gain are persistent (created once per context), so pan changes are
 * smoothed with AudioParam.setTargetAtTime (time constant BEACON.panTimeConstantSec) and the smoothing carries
 * across pulses instead of each pulse jumping.
 *
 * Mapping (pure functions below, exported for tests):
 *   - pan   = clamp(2*cx - 1, -1, 1), cx = box centre in the picture (0 = left edge -> left ear).
 *   - rate  = ALIGNMENT, never distance: the pulse interval runs from LIMITS.findPulseFarMs (far from the picture
 *             centre) to LIMITS.findPulseNearMs (near it), from a combined horizontal + vertical alignment error.
 *   - no pitch language in v1: every pulse is the same gentle tone.
 *
 * Silence rules: no pulses when the target is null, when it is `centered` (the controller plays the confirmation
 * chime instead), when its observation is older than LIMITS.findObservationMaxAgeMs (never steer from an old
 * position), while suppressed (assistant / guidance / user speech, calibration) or when the beacon is disabled.
 *
 * Scheduling: a 25 ms timer tops up a ~100 ms look-ahead on the AudioContext clock (so pulse timing does not inherit
 * timer jitter). stopTracking / setTarget(null) / setSuppressed(true) cancel every scheduled pulse at once: pulses
 * that have not started are stopped and disconnected immediately; a pulse already sounding gets a ~15 ms fade and
 * stops (a hard cut would click). Repeated start/stop cycles leave no timers or voices behind (see `timerCount`,
 * `activeVoices`).
 *
 * `audibleUntil` (performance.now() ms) = end of the last scheduled/sounding cue + the context's reported output
 * latency + AUDIBLE_TAIL_MS. The controller blanks microphone input until then so cues never become user input.
 */
import type { CueTarget, Earcon, SpatialCueEngine } from '../contracts.js';
import { LIMITS, type NormalizedBox } from '../../shared/protocol.js';

// ---------------------------------------------------------------------------
// Constants and pure mappings (exported for tests and documentation)
// ---------------------------------------------------------------------------

export const BEACON = {
  /** Gentle mid tone (D5). Same pitch for every pulse: pitch carries no meaning in v1. */
  freqHz: 587.33,
  type: 'sine' as OscillatorType,
  durSec: 0.07,
  attackSec: 0.008,
  releaseSec: 0.04,
  /** Per-pulse peak before the master (cueVolume) gain. */
  peakGain: 0.4,
  /** StereoPannerNode smoothing time constant (s). */
  panTimeConstantSec: 0.06,
} as const;

export const CALIBRATION_TONE = { freqHz: 523.25, durSec: 0.6, attackSec: 0.03, releaseSec: 0.12, peakGain: 0.45 } as const;

export const DEFAULT_CUE_VOLUME = 0.5;
export const DUCKED_FACTOR = 0.3;
/** Added to audibleUntil after the last cue ends (room echo, Bluetooth jitter). */
export const AUDIBLE_TAIL_MS = 120;
/** Fade applied when cancelling a pulse that is already sounding. */
export const CANCEL_FADE_SEC = 0.015;

const clamp = (v: number, lo: number, hi: number) => (Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : (lo + hi) / 2);

/** Stereo pan for a horizontal picture position (0 = left edge -> -1, 0.5 -> 0, 1 = right edge -> +1). */
export function panForX(cx: number): number {
  return clamp(2 * clamp(cx, 0, 1) - 1, -1, 1);
}

/** Stereo pan for a normalised box in the unmirrored rear-camera frame: pan of its centre. Works for any aspect. */
export function panForBox(box: NormalizedBox): number {
  return panForX(box.x + box.w / 2);
}

/**
 * Alignment error 0..1: 0 with the box centre at the picture centre, 1 at (or beyond) the middle of an edge.
 * Combines horizontal and vertical error (Euclidean, each normalised to its half-width).
 */
export function alignmentError(cx: number, cy: number): number {
  return clamp(Math.hypot((clamp(cx, 0, 1) - 0.5) * 2, (clamp(cy, 0, 1) - 0.5) * 2), 0, 1);
}

/**
 * Beacon pulse interval in ms: LIMITS.findPulseFarMs when far from the picture centre -> LIMITS.findPulseNearMs
 * near it. The rate means ALIGNMENT (how close to the centre of the camera picture), never physical distance.
 */
export function pulseIntervalMs(cx: number, cy: number): number {
  const near = LIMITS.findPulseNearMs;
  const far = LIMITS.findPulseFarMs;
  return Math.round(near + (far - near) * alignmentError(cx, cy));
}

/** True when the observation is recent enough to steer from. */
export function isFreshObservation(observedAt: number, nowMs: number): boolean {
  return Number.isFinite(observedAt) && nowMs - observedAt <= LIMITS.findObservationMaxAgeMs;
}

export const HAPTIC_PATTERNS: Partial<Record<Earcon, number[]>> = {
  capture: [20],
  found: [40, 60, 40],
  error: [80, 40, 80],
};

// ---------------------------------------------------------------------------
// Engine
// ---------------------------------------------------------------------------

export interface SpatialCuesOptions {
  /**
   * The app's shared output AudioContext (main.tsx: `() => player.context`). When given, the engine never creates a
   * context of its own and never closes the shared one. null = not unlocked yet (nothing plays).
   */
  getContext?: () => AudioContext | null;
  /** Only used when getContext is NOT given (e.g. tests, standalone use). Default new AudioContext(). */
  createContext?: () => AudioContext;
  /** Defaults to navigator.vibrate when available; null disables haptics entirely. */
  vibrate?: ((pattern: number[]) => boolean) | null;
  /** Look-ahead window scheduled on each tick (s). Default 0.1. */
  lookaheadSec?: number;
  /** Scheduler top-up period (ms). Default 25. */
  tickMs?: number;
  /** Max simultaneously alive voices. Default 24. */
  maxVoices?: number;
  /** Epoch clock used for observation staleness (same clock as CueTarget.observedAt). Default Date.now. */
  now?: () => number;
  /** Monotonic clock for audibleUntil. Default performance.now. */
  perfNow?: () => number;
}

export interface SpatialCuesDiagnostics {
  /** Voices currently scheduled or sounding (beacon, calibration and earcons). */
  readonly activeVoices: number;
  /** Beacon pulses scheduled or sounding that have not been cancelled. */
  readonly scheduledPulses: number;
  /** Timers owned by the engine (scheduler interval + calibration safety timers). */
  readonly timerCount: number;
  readonly tracking: boolean;
  readonly suppressed: boolean;
  /** Stop any calibration tone now (its promise resolves). Not part of the v3 contract (requested). */
  cancelCalibrationTone(): void;
}

type VoiceKind = 'beacon' | 'calibration' | 'earcon';

interface Voice {
  kind: VoiceKind;
  src: AudioScheduledSourceNode;
  env: GainNode;
  nodes: AudioNode[];
  startAt: number;
  endAt: number;
  endPerf: number;
  cancelled: boolean;
  onDone?: () => void;
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
  attack?: number;
  release?: number;
}

/** Earcon base gain before the master (cueVolume, default 0.5) gain. */
const E = 0.28;
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
  // Confirmation chime: the target is stably centred in the camera picture.
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

function safeDisconnect(n: AudioNode | null | undefined) {
  try {
    n?.disconnect();
  } catch {
    /* already disconnected */
  }
}

/** Hold the param's current value at `t` (no jump), falling back to cancelScheduledValues. */
function holdAt(p: AudioParam, t: number) {
  const anyP = p as AudioParam & { cancelAndHoldAtTime?: (t: number) => AudioParam };
  if (typeof anyP.cancelAndHoldAtTime === 'function') anyP.cancelAndHoldAtTime(t);
  else p.cancelScheduledValues?.(t);
}

export function createSpatialCues(opts: SpatialCuesOptions = {}): SpatialCueEngine & SpatialCuesDiagnostics {
  const getShared = opts.getContext ?? null;
  const createContext = getShared ? null : (opts.createContext ?? defaultContextFactory());
  const vibrate = opts.vibrate === undefined ? defaultVibrate() : opts.vibrate;
  const lookaheadSec = opts.lookaheadSec ?? 0.1;
  const tickMs = opts.tickMs ?? 25;
  const maxVoices = opts.maxVoices ?? 24;
  const nowMs = opts.now ?? (() => Date.now());
  const perfNow = opts.perfNow ?? (() => (typeof performance !== 'undefined' ? performance.now() : Date.now()));

  // Graph (per context)
  let ctx: AudioContext | null = null;
  let master: GainNode | null = null;
  let beaconPanner: StereoPannerNode | null = null;
  let noiseBuffer: AudioBuffer | null = null;

  const voices = new Set<Voice>();
  let config = { earcons: true, beacon: true, haptics: true, volume: DEFAULT_CUE_VOLUME };
  let ducked = false;
  let suppressed = false;
  let tracking = false;
  let target: CueTarget | null = null;
  /** Whether the last tick had the beacon sounding (pan may glide rather than jump). */
  let beaconLive = false;
  let nextPulseAt = 0;
  let lastPulseAt = Number.NEGATIVE_INFINITY;
  let timer: ReturnType<typeof setInterval> | null = null;
  const calibrationTimers = new Set<ReturnType<typeof setTimeout>>();
  let lastVibration: { key: string; at: number } | null = null;
  /** audibleUntil floor kept after voices end or are cancelled. */
  let audibleFloor = Number.NEGATIVE_INFINITY;
  let closed = false;

  const masterLevel = () => clamp(config.volume, 0, 1) * (ducked ? DUCKED_FACTOR : 1);

  function latencyMs(c: AudioContext): number {
    const out = typeof c.outputLatency === 'number' && Number.isFinite(c.outputLatency) ? c.outputLatency : 0;
    const base = typeof c.baseLatency === 'number' && Number.isFinite(c.baseLatency) ? c.baseLatency : 0;
    return (out + base) * 1000;
  }

  function detachGraph() {
    for (const v of [...voices]) hardStop(v);
    safeDisconnect(beaconPanner);
    safeDisconnect(master);
    beaconPanner = null;
    master = null;
    noiseBuffer = null;
    ctx = null;
    beaconLive = false;
  }

  function attachGraph(c: AudioContext) {
    ctx = c;
    master = c.createGain();
    master.gain.value = masterLevel();
    master.connect(c.destination);
    beaconPanner = typeof c.createStereoPanner === 'function' ? c.createStereoPanner() : null;
    if (beaconPanner) {
      beaconPanner.pan.value = 0;
      beaconPanner.connect(master);
    }
    noiseBuffer = null;
    beaconLive = false;
  }

  /** Current usable context (attaching to the shared one if it changed). */
  function ensureCtx(): AudioContext | null {
    if (closed) return null;
    if (getShared) {
      let c: AudioContext | null;
      try {
        c = getShared();
      } catch {
        c = null;
      }
      if (c && c.state === 'closed') c = null;
      if (c !== ctx) {
        detachGraph();
        if (c) attachGraph(c);
      }
    } else if (ctx && ctx.state === 'closed') {
      detachGraph();
    }
    return ctx;
  }

  const running = () => {
    const c = ensureCtx();
    return c !== null && master !== null && c.state === 'running';
  };

  function buzz(pattern: number[] | undefined) {
    if (!pattern || !config.haptics || !vibrate) return;
    const t = nowMs();
    const key = pattern.join(',');
    if (lastVibration && lastVibration.key === key && t - lastVibration.at < HAPTIC_DEDUPE_MS) return;
    lastVibration = { key, at: t };
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
    for (const n of v.nodes) safeDisconnect(n);
    if (!v.cancelled) audibleFloor = Math.max(audibleFloor, v.endPerf);
    const done = v.onDone;
    v.onDone = undefined;
    done?.();
  }

  /** Stop + disconnect now (no fade). */
  function hardStop(v: Voice) {
    v.cancelled = true;
    try {
      v.src.stop();
    } catch {
      /* not started */
    }
    releaseVoice(v);
  }

  /** Cancel a voice: not yet started -> stop + disconnect now; sounding -> short fade, then stop. */
  function cancelVoice(v: Voice) {
    if (v.cancelled) return;
    const c = ctx;
    if (!c || c.state !== 'running' || v.startAt >= c.currentTime) {
      hardStop(v);
      return;
    }
    v.cancelled = true;
    const t = c.currentTime;
    const g = v.env.gain;
    holdAt(g, t);
    g.setTargetAtTime(0, t, CANCEL_FADE_SEC / 4);
    try {
      v.src.stop(t + CANCEL_FADE_SEC);
    } catch {
      hardStop(v);
      return;
    }
    v.endAt = t + CANCEL_FADE_SEC;
    v.endPerf = perfNow() + CANCEL_FADE_SEC * 1000 + latencyMs(c) + AUDIBLE_TAIL_MS;
    audibleFloor = Math.max(audibleFloor, v.endPerf);
  }

  function cancelKind(kind: VoiceKind) {
    for (const v of [...voices]) if (v.kind === kind) cancelVoice(v);
    if (kind === 'beacon') {
      beaconLive = false;
      nextPulseAt = 0;
    }
  }

  /** Schedule one short voice at AudioContext time `at` into `dest` (default master). */
  function voice(kind: VoiceKind, at: number, spec: ToneSpec, dest?: AudioNode, extra: AudioNode[] = []): Voice | null {
    if (!running() || voices.size >= maxVoices) {
      for (const n of extra) safeDisconnect(n);
      return null;
    }
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
    const env = c.createGain();
    const attack = Math.min(spec.attack ?? 0.008, spec.dur / 4);
    const release = Math.min(spec.release ?? spec.dur * 0.6, spec.dur - attack);
    const peak = Math.max(0, spec.gain);
    // Linear ramps from and to exactly 0: no click at either end.
    env.gain.value = 0;
    env.gain.setValueAtTime(0, at);
    env.gain.linearRampToValueAtTime(peak, at + attack);
    env.gain.setValueAtTime(peak, at + spec.dur - release);
    env.gain.linearRampToValueAtTime(0, at + spec.dur);
    src.connect(env);
    env.connect(dest ?? master!);
    const endAt = at + spec.dur;
    const v: Voice = {
      kind,
      src,
      env,
      nodes: [src, env, ...extra],
      startAt: at,
      endAt,
      endPerf: perfNow() + Math.max(0, endAt - c.currentTime) * 1000 + latencyMs(c) + AUDIBLE_TAIL_MS,
      cancelled: false,
    };
    voices.add(v);
    src.onended = () => releaseVoice(v);
    src.start(at);
    src.stop(endAt + 0.005);
    return v;
  }

  // -------------------------------------------------------------------------
  // Beacon
  // -------------------------------------------------------------------------

  function beaconShouldSound(t: CueTarget | null): t is CueTarget {
    return config.beacon && !suppressed && tracking && t !== null && !t.centered && isFreshObservation(t.observedAt, nowMs());
  }

  function schedulePulse(at: number) {
    voice(
      'beacon',
      at,
      { offset: 0, dur: BEACON.durSec, freq: BEACON.freqHz, type: BEACON.type, gain: BEACON.peakGain, attack: BEACON.attackSec, release: BEACON.releaseSec },
      beaconPanner ?? undefined,
    );
  }

  function tick() {
    if (!tracking) return;
    if (!running()) return;
    if (!beaconShouldSound(target)) {
      // Silence now: includes the case where the latest observation has just become stale.
      if (beaconLive || [...voices].some((v) => v.kind === 'beacon' && !v.cancelled)) cancelKind('beacon');
      return;
    }
    const c = ctx!;
    const t = target;
    const now = c.currentTime;
    const interval = pulseIntervalMs(t.cx, t.cy) / 1000;
    if (nextPulseAt < now) nextPulseAt = now + 0.01;
    const horizon = now + lookaheadSec;
    let guard = 0;
    while (nextPulseAt < horizon && guard++ < 4) {
      schedulePulse(nextPulseAt);
      lastPulseAt = nextPulseAt;
      nextPulseAt += interval;
    }
    beaconLive = true;
  }

  function ensureTimer() {
    if (timer || !tracking || closed) return;
    timer = setInterval(tick, tickMs);
  }

  function clearTimer() {
    if (timer) clearInterval(timer);
    timer = null;
  }

  function updatePan(t: CueTarget, glide: boolean) {
    if (!beaconPanner || !ctx) return;
    const p = beaconPanner.pan;
    const pan = panForX(t.cx);
    const now = ctx.currentTime;
    if (glide) {
      holdAt(p, now);
      p.setTargetAtTime(pan, now, BEACON.panTimeConstantSec);
    } else {
      // (Re)acquired: jump to the true position so the first pulse is not heard sliding from an old one.
      p.cancelScheduledValues?.(now);
      p.setValueAtTime(pan, now);
    }
  }

  // -------------------------------------------------------------------------
  // Calibration
  // -------------------------------------------------------------------------

  function cancelCalibrationTone() {
    for (const v of [...voices]) if (v.kind === 'calibration') hardStop(v);
  }

  // -------------------------------------------------------------------------
  // Public
  // -------------------------------------------------------------------------

  const engine: SpatialCueEngine & SpatialCuesDiagnostics = {
    supported: getShared !== null || createContext !== null,

    get activeVoices() {
      return voices.size;
    },
    get scheduledPulses() {
      let n = 0;
      for (const v of voices) if (v.kind === 'beacon' && !v.cancelled) n++;
      return n;
    },
    get timerCount() {
      return (timer ? 1 : 0) + calibrationTimers.size;
    },
    get tracking() {
      return tracking;
    },
    get suppressed() {
      return suppressed;
    },
    get audibleUntil() {
      let until = audibleFloor;
      for (const v of voices) if (v.endPerf > until) until = v.endPerf;
      return until;
    },

    unlock() {
      // Synchronous inside the gesture: attach/create and resume before returning.
      if (closed) return Promise.resolve();
      try {
        if (!getShared && (!ctx || ctx.state === 'closed') && createContext) attachGraph(createContext());
        const c = ensureCtx();
        if (!c) return Promise.resolve();
        const p = c.state === 'running' ? Promise.resolve() : c.resume();
        return Promise.resolve(p).catch(() => undefined);
      } catch {
        return Promise.resolve();
      }
    },

    setTarget(t: CueTarget | null) {
      if (!t) {
        target = null;
        cancelKind('beacon');
        return;
      }
      const wasLive = beaconLive && target !== null;
      target = { cx: clamp(t.cx, 0, 1), cy: clamp(t.cy, 0, 1), area: clamp(t.area, 0, 1), centered: t.centered, observedAt: t.observedAt };
      if (!tracking || !running()) return;
      if (!beaconShouldSound(target)) {
        cancelKind('beacon');
        return;
      }
      updatePan(target, wasLive);
      const now = ctx!.currentTime;
      if (!wasLive) {
        nextPulseAt = now; // re-acquired: pulse straight away
      } else {
        // Moved nearer the centre: do not wait out the old (longer) interval.
        const soonest = Math.max(now, lastPulseAt + pulseIntervalMs(target.cx, target.cy) / 1000);
        if (nextPulseAt > soonest) nextPulseAt = soonest;
      }
      tick();
    },

    startTracking() {
      if (closed) return;
      if (!tracking) {
        tracking = true;
        nextPulseAt = 0;
        lastPulseAt = Number.NEGATIVE_INFINITY;
      }
      ensureTimer();
      tick();
    },

    stopTracking() {
      tracking = false;
      target = null;
      clearTimer();
      cancelKind('beacon');
      cancelCalibrationTone();
    },

    earcon(kind: Earcon) {
      if (closed) return;
      buzz(HAPTIC_PATTERNS[kind]);
      if (!config.earcons || !running()) return;
      const base = ctx!.currentTime + 0.01;
      for (const spec of EARCONS[kind]) voice('earcon', base + spec.offset, spec);
    },

    setDucked(d: boolean) {
      if (ducked === d) return;
      ducked = d;
      if (master && ctx) master.gain.setTargetAtTime(masterLevel(), ctx.currentTime, 0.04);
    },

    setSuppressed(s: boolean) {
      if (suppressed === s) return;
      suppressed = s;
      if (s) cancelKind('beacon');
      else tick();
    },

    calibrationTone(channel: 'left' | 'right' | 'centre') {
      return new Promise<void>((resolve) => {
        if (!running()) return resolve();
        cancelKind('beacon');
        cancelCalibrationTone();
        const c = ctx!;
        const pan = channel === 'left' ? -1 : channel === 'right' ? 1 : 0;
        const at = c.currentTime + 0.02;
        let panner: StereoPannerNode | null = null;
        if (typeof c.createStereoPanner === 'function') {
          panner = c.createStereoPanner();
          panner.pan.value = pan;
          panner.pan.setValueAtTime(pan, at);
          panner.connect(master!);
        }
        let settled = false;
        let safety: ReturnType<typeof setTimeout> | null = null;
        const finish = () => {
          if (settled) return;
          settled = true;
          if (safety) {
            clearTimeout(safety);
            calibrationTimers.delete(safety);
          }
          resolve();
        };
        const v = voice(
          'calibration',
          at,
          {
            offset: 0,
            dur: CALIBRATION_TONE.durSec,
            freq: CALIBRATION_TONE.freqHz,
            gain: CALIBRATION_TONE.peakGain,
            attack: CALIBRATION_TONE.attackSec,
            release: CALIBRATION_TONE.releaseSec,
          },
          panner ?? undefined,
          panner ? [panner] : [],
        );
        if (!v) return finish();
        v.onDone = finish;
        // `ended` may never fire if the context gets suspended; never leave the caller hanging.
        safety = setTimeout(() => {
          if (safety) calibrationTimers.delete(safety);
          safety = null;
          if (voices.has(v)) hardStop(v);
          finish();
        }, CALIBRATION_TONE.durSec * 1000 + 400);
        calibrationTimers.add(safety);
      });
    },

    cancelCalibrationTone,

    configure(o) {
      const volume = Number.isFinite(o.volume) ? clamp(o.volume, 0, 1) : DEFAULT_CUE_VOLUME;
      config = { earcons: o.earcons, beacon: o.beacon, haptics: o.haptics, volume };
      if (master && ctx) master.gain.setTargetAtTime(masterLevel(), ctx.currentTime, 0.03);
      if (!config.beacon) cancelKind('beacon');
    },

    async close() {
      engine.stopTracking();
      closed = true;
      for (const v of [...voices]) hardStop(v);
      for (const t of calibrationTimers) clearTimeout(t);
      calibrationTimers.clear();
      const c = ctx;
      const own = !getShared;
      safeDisconnect(beaconPanner);
      safeDisconnect(master);
      beaconPanner = null;
      master = null;
      ctx = null;
      // A shared context belongs to the AudioPlayer: never close it here.
      if (own && c && c.state !== 'closed') await c.close().catch(() => undefined);
    },
  };
  return engine;
}
