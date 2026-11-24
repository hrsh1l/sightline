/**
 * Gap-free playback of Gemini Live PCM16 LE mono 24 kHz chunks with instant flush.
 *
 * - unlock(): creates/resumes the AudioContext synchronously inside the user gesture (resume() is called
 *   before any await).
 * - enqueue(): decodes into AudioBuffer(1, n, 24000) and schedules at a running `nextStartTime` cursor;
 *   if the cursor fell behind currentTime, it restarts ~50 ms ahead.
 * - Total scheduled-ahead audio is bounded (~60 s); excess chunks are dropped and counted.
 * - flush(turnId?): stops all scheduled sources at once; later chunks of turns <= turnId are rejected.
 * - onTurnAudible: once per turn, performance.now()-based time of that turn's first scheduled sample
 *   (start time converted from the AudioContext clock, plus outputLatency when the browser reports it).
 */
import type { AudioPlayer, PlayerState, Unsubscribe } from '../contracts.js';
import { OUTPUT_SAMPLE_RATE } from '../../shared/protocol.js';
import { decodePcm16Base64 } from './pcm.js';

export interface AudioPlayerOptions {
  createContext?: () => AudioContext;
  /** Seconds of lead when (re)starting the schedule. Default 0.05. */
  leadSec?: number;
  /** Max seconds of audio scheduled ahead of currentTime. Default 60. */
  maxScheduledSec?: number;
  perfNow?: () => number;
}

export interface AudioPlayerDiagnostics {
  readonly overflowDropped: number;
  readonly rejectedChunks: number;
  readonly scheduledSources: number;
}

type ScheduledSource = { src: AudioBufferSourceNode; turnId: number; endsAt: number };

const mapContextState = (s: string | undefined): PlayerState['contextState'] =>
  s === 'running' ? 'running' : s === 'closed' ? 'closed' : s === undefined ? 'uninitialized' : 'suspended';

export function createAudioPlayer(opts: AudioPlayerOptions = {}): AudioPlayer & AudioPlayerDiagnostics {
  const leadSec = opts.leadSec ?? 0.05;
  const maxScheduledSec = opts.maxScheduledSec ?? 60;
  const perfNow = opts.perfNow ?? (() => performance.now());
  const createContext = opts.createContext ?? (() => new AudioContext({ latencyHint: 'interactive' }));

  let ctx: AudioContext | null = null;
  let state: PlayerState = { playing: false, turnId: null, contextState: 'uninitialized' };
  const listeners = new Set<() => void>();
  const audibleListeners = new Set<(turnId: number, at: number) => void>();
  const sources = new Set<ScheduledSource>();
  const audibleNotified = new Set<number>();
  let nextStartTime = 0;
  let flushedThrough = -1;
  let overflowDropped = 0;
  let rejectedChunks = 0;

  const set = (patch: Partial<PlayerState>) => {
    const next = { ...state, ...patch };
    if (next.playing === state.playing && next.turnId === state.turnId && next.contextState === state.contextState) return;
    state = next;
    for (const l of [...listeners]) l();
  };

  const refreshPlaying = () => {
    let first: ScheduledSource | null = null;
    for (const s of sources) if (!first || s.endsAt < first.endsAt) first = s;
    set({ playing: sources.size > 0, turnId: first ? first.turnId : null });
  };

  const onStateChange = () => set({ contextState: mapContextState(ctx?.state) });

  function stopAll() {
    for (const s of sources) {
      s.src.onended = null;
      try {
        s.src.stop();
      } catch {
        /* not started / already stopped */
      }
      try {
        s.src.disconnect();
      } catch {
        /* ignore */
      }
    }
    sources.clear();
    nextStartTime = 0;
  }

  return {
    getState: () => state,
    subscribe(l) {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    unlock() {
      if (!ctx || ctx.state === 'closed') {
        ctx = createContext();
        ctx.addEventListener?.('statechange', onStateChange);
      }
      // resume() must be invoked synchronously within the gesture, before any await.
      const p = ctx.state === 'running' ? Promise.resolve() : ctx.resume();
      onStateChange();
      return Promise.resolve(p)
        .catch(() => undefined)
        .then(() => onStateChange());
    },
    enqueue(turnId: number, base64Pcm16: string) {
      if (!ctx || ctx.state === 'closed' || turnId <= flushedThrough) {
        rejectedChunks++;
        return;
      }
      let samples: Float32Array;
      try {
        samples = decodePcm16Base64(base64Pcm16);
      } catch {
        rejectedChunks++;
        return;
      }
      if (samples.length === 0) return;
      const now = ctx.currentTime;
      const duration = samples.length / OUTPUT_SAMPLE_RATE;
      if (nextStartTime < now + 0.005) nextStartTime = now + leadSec; // behind (or first chunk): restart cursor
      if (nextStartTime - now + duration > maxScheduledSec) {
        overflowDropped++;
        return;
      }
      const buffer = ctx.createBuffer(1, samples.length, OUTPUT_SAMPLE_RATE);
      buffer.getChannelData(0).set(samples);
      const src = ctx.createBufferSource();
      src.buffer = buffer;
      src.connect(ctx.destination);
      const startAt = nextStartTime;
      const entry: ScheduledSource = { src, turnId, endsAt: startAt + duration };
      src.onended = () => {
        sources.delete(entry);
        try {
          src.disconnect();
        } catch {
          /* ignore */
        }
        refreshPlaying();
      };
      src.start(startAt);
      sources.add(entry);
      nextStartTime = startAt + duration;
      refreshPlaying();
      if (!audibleNotified.has(turnId)) {
        audibleNotified.add(turnId);
        if (audibleNotified.size > 500) audibleNotified.delete(audibleNotified.values().next().value as number);
        const latency = typeof ctx.outputLatency === 'number' && Number.isFinite(ctx.outputLatency) ? ctx.outputLatency : 0;
        const at = perfNow() + (startAt - now + latency) * 1000;
        for (const l of [...audibleListeners]) l(turnId, at);
      }
    },
    flush(turnId?: number) {
      if (turnId !== undefined) flushedThrough = Math.max(flushedThrough, turnId);
      stopAll();
      refreshPlaying();
    },
    onTurnAudible(cb) {
      audibleListeners.add(cb);
      return (() => audibleListeners.delete(cb)) as Unsubscribe;
    },
    async close() {
      stopAll();
      refreshPlaying();
      const c = ctx;
      ctx = null;
      if (c && c.state !== 'closed') await c.close().catch(() => undefined);
      set({ contextState: 'closed' });
    },
    get overflowDropped() {
      return overflowDropped;
    },
    get rejectedChunks() {
      return rejectedChunks;
    },
    get scheduledSources() {
      return sources.size;
    },
    /** The single output AudioContext; SpatialCues attaches to it (createSpatialCues({ getContext })). */
    get context() {
      return ctx;
    },
  };
}
