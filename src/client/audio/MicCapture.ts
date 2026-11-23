/**
 * Microphone capture: getUserMedia -> AudioContext -> AudioWorklet (pcm-capture.worklet.js) -> main thread
 * downsampling to 16 kHz PCM16 LE -> base64 chunks via onChunk.
 *
 * - Chunks are ~64 ms (1024 samples @ 16 kHz) by default.
 * - Bounded: when muted, gated, or with no listeners, nothing is accumulated (the pending chunk is dropped).
 * - The meter level is still updated while gated (not while muted).
 */
import type { MicCapture, MicState, MicStatus, Unsubscribe } from '../contracts.js';
import { INPUT_SAMPLE_RATE } from '../../shared/protocol.js';
import { bytesToBase64, createResampler, floatToInt16, int16ToLeBytes, rms, type Resampler } from './pcm.js';
// Emitted by Vite as a separate same-origin file. `no-inline` matters: the default asset inlining would turn this
// small file into a data: URL, which the production CSP (script-src 'self') blocks for audioWorklet.addModule.
import defaultWorkletUrl from './pcm-capture.worklet.js?url&no-inline';

export interface MicCaptureOptions {
  getUserMedia?: (constraints: MediaStreamConstraints) => Promise<MediaStream>;
  createAudioContext?: () => AudioContext;
  createWorkletNode?: (ctx: AudioContext, name: string, options: AudioWorkletNodeOptions) => AudioWorkletNode;
  workletUrl?: string | URL;
  /** Output chunk length in 16 kHz samples. Default 1024 (64 ms). */
  chunkSamples?: number;
  isSecureContext?: () => boolean;
  /** Minimum interval between meter-level store updates. Default 50 ms. */
  levelIntervalMs?: number;
  now?: () => number;
}

export const MIC_CONSTRAINTS: MediaStreamConstraints = {
  audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
  video: false,
};

export function mapMediaError(err: unknown): { status: MicStatus; message: string } {
  const name = err && typeof err === 'object' && 'name' in err ? String((err as { name: unknown }).name) : '';
  switch (name) {
    case 'NotAllowedError':
    case 'SecurityError':
    case 'PermissionDeniedError':
      return { status: 'denied', message: 'Microphone permission was denied. Allow the microphone in Chrome site settings, then try again.' };
    case 'NotFoundError':
    case 'OverconstrainedError':
    case 'DevicesNotFoundError':
      return { status: 'unavailable', message: 'No microphone was found.' };
    case 'NotReadableError':
    case 'TrackStartError':
    case 'AbortError':
      return { status: 'in_use', message: 'The microphone is in use by another app. Close it and try again.' };
    default:
      return { status: 'error', message: 'The microphone could not be started.' };
  }
}

export function createMicCapture(opts: MicCaptureOptions = {}): MicCapture {
  const chunkSamples = opts.chunkSamples ?? 1024;
  const levelIntervalMs = opts.levelIntervalMs ?? 50;
  const now = opts.now ?? (() => performance.now());
  const isSecure = opts.isSecureContext ?? (() => (typeof window === 'undefined' ? true : window.isSecureContext !== false));
  const gum =
    opts.getUserMedia ??
    ((c: MediaStreamConstraints) => {
      const md = typeof navigator !== 'undefined' ? navigator.mediaDevices : undefined;
      if (!md?.getUserMedia) return Promise.reject(Object.assign(new Error('no mediaDevices'), { name: 'NotFoundError' }));
      return md.getUserMedia(c);
    });
  const createCtx = opts.createAudioContext ?? (() => new AudioContext({ latencyHint: 'interactive' }));
  const createNode = opts.createWorkletNode ?? ((ctx, name, o) => new AudioWorkletNode(ctx, name, o));
  const workletUrl = opts.workletUrl ?? defaultWorkletUrl;

  let state: MicState = { status: 'idle', level: 0, echoCancellation: null, message: null };
  const storeListeners = new Set<() => void>();
  const chunkListeners = new Set<(b64: string) => void>();
  const set = (patch: Partial<MicState>) => {
    const next = { ...state, ...patch };
    if (
      next.status === state.status &&
      next.level === state.level &&
      next.echoCancellation === state.echoCancellation &&
      next.message === state.message
    )
      return;
    state = next;
    for (const l of [...storeListeners]) l();
  };

  let epoch = 0;
  let stream: MediaStream | null = null;
  let ctx: AudioContext | null = null;
  let source: MediaStreamAudioSourceNode | null = null;
  let node: AudioWorkletNode | null = null;
  let sink: GainNode | null = null;
  let resampler: Resampler | null = null;
  let muted = false;
  let gateOpen = true;
  let pending = new Int16Array(chunkSamples);
  let pendingLen = 0;
  let lastLevelAt = Number.NEGATIVE_INFINITY;

  const deliver = () => !muted && gateOpen && chunkListeners.size > 0;

  function onBlock(block: Float32Array) {
    if (muted) return;
    const t = now();
    if (t - lastLevelAt >= levelIntervalMs) {
      lastLevelAt = t;
      set({ level: Math.min(1, rms(block)) });
    }
    if (!resampler) return;
    if (!deliver()) {
      // Never accumulate while nobody consumes the audio; keep the resampler state continuous.
      resampler.process(block);
      pendingLen = 0;
      return;
    }
    const pcm = floatToInt16(resampler.process(block));
    let off = 0;
    while (off < pcm.length) {
      const n = Math.min(pcm.length - off, chunkSamples - pendingLen);
      pending.set(pcm.subarray(off, off + n), pendingLen);
      pendingLen += n;
      off += n;
      if (pendingLen === chunkSamples) {
        const b64 = bytesToBase64(int16ToLeBytes(pending));
        pending = new Int16Array(chunkSamples);
        pendingLen = 0;
        for (const l of [...chunkListeners]) l(b64);
      }
    }
  }

  function teardown() {
    try {
      node?.port.postMessage({ type: 'stop' });
    } catch {
      /* ignore */
    }
    if (node) node.port.onmessage = null;
    try {
      source?.disconnect();
      node?.disconnect();
      sink?.disconnect();
    } catch {
      /* ignore */
    }
    for (const t of stream?.getTracks() ?? []) t.stop();
    if (ctx && ctx.state !== 'closed') void ctx.close().catch(() => undefined);
    stream = null;
    ctx = null;
    source = null;
    node = null;
    sink = null;
    resampler = null;
    pendingLen = 0;
  }

  return {
    getState: () => state,
    subscribe(l) {
      storeListeners.add(l);
      return () => storeListeners.delete(l);
    },
    async start() {
      if (state.status === 'active' || state.status === 'muted' || state.status === 'requesting') return;
      const my = ++epoch;
      if (!isSecure()) {
        set({ status: 'insecure_context', message: 'The microphone needs a secure (HTTPS or localhost) connection.' });
        return;
      }
      set({ status: 'requesting', message: null });
      let s: MediaStream;
      try {
        s = await gum(MIC_CONSTRAINTS);
      } catch (err) {
        if (my !== epoch) return;
        const m = mapMediaError(err);
        set({ status: m.status, message: m.message, level: 0 });
        return;
      }
      if (my !== epoch) {
        for (const t of s.getTracks()) t.stop();
        return;
      }
      stream = s;
      const track = s.getAudioTracks()[0];
      try {
        const c = createCtx();
        ctx = c;
        void c.resume().catch(() => undefined);
        await c.audioWorklet.addModule(workletUrl);
        if (my !== epoch) return;
        const blockSize = Math.max(128, Math.round(c.sampleRate * 0.04 / 128) * 128); // ~40 ms
        resampler = createResampler(c.sampleRate, INPUT_SAMPLE_RATE);
        source = c.createMediaStreamSource(s);
        node = createNode(c, 'pcm-capture', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1], processorOptions: { blockSize } });
        node.port.onmessage = (e: MessageEvent) => {
          if (my === epoch && e.data instanceof Float32Array) onBlock(e.data);
        };
        // Route through a muted gain so the graph is pulled on all browsers without making sound.
        sink = c.createGain();
        sink.gain.value = 0;
        source.connect(node);
        node.connect(sink);
        sink.connect(c.destination);
      } catch {
        if (my !== epoch) return;
        teardown();
        set({ status: 'error', message: 'Audio processing could not start in this browser.', level: 0 });
        return;
      }
      const settings = track?.getSettings?.() ?? {};
      if (track) track.enabled = !muted;
      track?.addEventListener?.('ended', () => {
        if (my === epoch) set({ status: 'error', message: 'The microphone stopped unexpectedly.', level: 0 });
      });
      set({
        status: muted ? 'muted' : 'active',
        echoCancellation: typeof settings.echoCancellation === 'boolean' ? settings.echoCancellation : null,
        message: null,
      });
    },
    stop() {
      epoch++;
      teardown();
      if (state.status !== 'idle') set({ status: 'stopped', level: 0 });
    },
    setMuted(m: boolean) {
      muted = m;
      pendingLen = 0;
      for (const t of stream?.getAudioTracks() ?? []) t.enabled = !m;
      if (state.status === 'active' || state.status === 'muted') set({ status: m ? 'muted' : 'active', level: 0 });
      else if (m) set({ level: 0 });
    },
    setGate(open: boolean) {
      if (gateOpen === open) return;
      gateOpen = open;
      if (!open) pendingLen = 0;
    },
    onChunk(cb) {
      chunkListeners.add(cb);
      return (() => chunkListeners.delete(cb)) as Unsubscribe;
    },
  };
}
