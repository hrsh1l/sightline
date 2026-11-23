// @vitest-environment jsdom
/**
 * AssistantController tests. Every collaborator here is a FIXTURE fake (camera, sampler, mic, player,
 * speech, socket); nothing touches real media devices or a real server.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  AudioPlayer,
  CameraController,
  CameraState,
  CaptureOptions,
  CapturedFrame,
  CueTarget,
  Earcon,
  FrameSampler,
  MicCapture,
  MicState,
  PlayerState,
  SpatialCueEngine,
  SpeechOutput,
} from '../contracts.js';
import { LIMITS, type ClientMessage, type ServerDetections, type ServerMessage, type ServerMessageOf } from '../../shared/protocol.js';
import { encodePcm16Base64 } from '../audio/pcm.js';
import { createAssistantController, type AssistantDeps } from './AssistantController.js';
import type { SessionSocketLike } from './SessionSocket.js';

const calls: string[] = [];

function store<S>(initial: S) {
  let state = initial;
  const ls = new Set<() => void>();
  return {
    getState: () => state,
    subscribe: (l: () => void) => {
      ls.add(l);
      return () => ls.delete(l);
    },
    set: (patch: Partial<S>) => {
      state = { ...state, ...patch };
      for (const l of [...ls]) l();
    },
  };
}

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

let nextFrameId = 1;
const frame = (): CapturedFrame => ({
  frameId: nextFrameId++,
  capturedAt: Date.now(),
  width: 640,
  height: 480,
  mimeType: 'image/jpeg',
  data: 'AAAA',
});

function fakeCamera() {
  const s = store<CameraState>({
    status: 'idle',
    facing: 'environment',
    deviceLabel: '',
    videoWidth: 0,
    videoHeight: 0,
    canSwitch: false,
    torch: { supported: true, on: false },
    stillCapture: true,
    message: null,
  });
  let captureImpl: (o: CaptureOptions) => Promise<CapturedFrame | null> = () => Promise.resolve(frame());
  let stillImpl: (o: CaptureOptions & { bestOf?: number }) => Promise<CapturedFrame | null> = () => Promise.resolve(frame());
  const cam = {
    ...s,
    attachVideo: vi.fn(),
    start: vi.fn(async () => {
      calls.push('camera.start');
      s.set({ status: 'active' });
    }),
    stop: vi.fn(() => s.set({ status: 'stopped' })),
    switchCamera: vi.fn(async () => undefined),
    pause: vi.fn(() => s.set({ status: 'paused' })),
    resume: vi.fn(async () => s.set({ status: 'active' })),
    capture: vi.fn((o: CaptureOptions) => captureImpl(o)),
    captureStill: vi.fn((o: CaptureOptions & { bestOf?: number }) => stillImpl(o)),
    setTorch: vi.fn(async (on: boolean) => {
      if (!s.getState().torch.supported) return false;
      s.set({ torch: { supported: true, on } });
      return true;
    }),
    setCapture: (fn: typeof captureImpl) => (captureImpl = fn),
    setStill: (fn: typeof stillImpl) => (stillImpl = fn),
  };
  return cam satisfies CameraController;
}

function fakeSampler() {
  let cb: ((f: CapturedFrame) => void) | null = null;
  const sampler = {
    start: vi.fn((onFrame: (f: CapturedFrame) => void) => {
      cb = onFrame;
    }),
    stop: vi.fn(() => {
      cb = null;
    }),
    latest: () => null,
    droppedCount: 0,
    emit: (f: CapturedFrame) => cb?.(f),
    get running() {
      return cb !== null;
    },
  };
  return sampler satisfies FrameSampler;
}

function fakeMic() {
  const s = store<MicState>({ status: 'idle', level: 0, echoCancellation: null, message: null });
  const chunkLs = new Set<(b: string) => void>();
  const mic = {
    ...s,
    gate: true,
    start: vi.fn(async () => {
      calls.push('mic.start');
      s.set({ status: 'active', echoCancellation: true });
    }),
    stop: vi.fn(() => s.set({ status: 'stopped' })),
    setMuted: vi.fn((m: boolean) => s.set({ status: m ? 'muted' : 'active' })),
    setGate: vi.fn((open: boolean) => {
      mic.gate = open;
    }),
    onChunk: (cb: (b: string) => void) => {
      chunkLs.add(cb);
      return () => chunkLs.delete(cb);
    },
    /** Deliver a chunk regardless of the gate so the controller's own gating is tested. */
    emit: (b64: string) => {
      for (const l of chunkLs) l(b64);
    },
  };
  return mic satisfies MicCapture;
}

function fakePlayer() {
  const s = store<PlayerState>({ playing: false, turnId: null, contextState: 'uninitialized' });
  const audibleLs = new Set<(t: number, at: number) => void>();
  const player = {
    ...s,
    enqueued: [] as [number, string][],
    unlock: vi.fn(() => {
      calls.push('player.unlock');
      s.set({ contextState: 'running' });
      return Promise.resolve();
    }),
    enqueue: vi.fn((turnId: number, data: string) => {
      player.enqueued.push([turnId, data]);
      s.set({ playing: true, turnId });
    }),
    flush: vi.fn((_turnId?: number) => s.set({ playing: false, turnId: null })),
    onTurnAudible: (cb: (t: number, at: number) => void) => {
      audibleLs.add(cb);
      return () => audibleLs.delete(cb);
    },
    close: vi.fn(async () => undefined),
    setState: s.set,
    audible: (t: number, at: number) => {
      for (const l of audibleLs) l(t, at);
    },
  };
  return player satisfies AudioPlayer;
}

function fakeSpeech() {
  return { supported: true, speaking: false, speak: vi.fn(), cancel: vi.fn() } satisfies SpeechOutput;
}

function fakeSocket() {
  const openLs = new Set<() => void>();
  const closeLs = new Set<(i: { code: number; reason: string; wasClean: boolean }) => void>();
  const msgLs = new Set<(m: ServerMessage) => void>();
  const sock = {
    sent: [] as ClientMessage[],
    isOpen: false,
    bufferedAmount: 0,
    send: vi.fn((m: ClientMessage) => {
      if (!sock.isOpen) return false;
      sock.sent.push(m);
      return true;
    }),
    close: vi.fn(() => {
      sock.isOpen = false;
    }),
    onOpen: (cb: () => void) => {
      openLs.add(cb);
      return () => openLs.delete(cb);
    },
    onClose: (cb: (i: { code: number; reason: string; wasClean: boolean }) => void) => {
      closeLs.add(cb);
      return () => closeLs.delete(cb);
    },
    onMessage: (cb: (m: ServerMessage) => void) => {
      msgLs.add(cb);
      return () => msgLs.delete(cb);
    },
    open: () => {
      sock.isOpen = true;
      for (const l of [...openLs]) l();
    },
    receive: (m: ServerMessage) => {
      for (const l of [...msgLs]) l(m);
    },
    serverClose: () => {
      sock.isOpen = false;
      for (const l of [...closeLs]) l({ code: 1006, reason: '', wasClean: false });
    },
    types: () => sock.sent.map((m) => m.type),
  };
  return sock satisfies SessionSocketLike;
}

const readyMsg = (mode: 'live' | 'snapshot' = 'live'): ServerMessageOf<'ready'> => ({
  type: 'ready',
  sessionId: 's1',
  mode,
  models: { live: mode === 'live' ? 'gemini-3.8-live' : null, vision: 'v' },
  features: { live: mode === 'live', snapshot: true, detections: false },
  serverTime: Date.now(),
  maxSessionMs: 1_200_000,
});

const loud = encodePcm16Base64(new Float32Array(1024).fill(0.3));
const quiet = encodePcm16Base64(new Float32Array(1024));

function setup(over: Partial<AssistantDeps> = {}) {
  const camera = fakeCamera();
  const sampler = fakeSampler();
  const mic = fakeMic();
  const player = fakePlayer();
  const speech = fakeSpeech();
  const sockets: ReturnType<typeof fakeSocket>[] = [];
  const createSocket = vi.fn(() => {
    calls.push('createSocket');
    const s = fakeSocket();
    sockets.push(s);
    return s;
  });
  let perf = 0;
  const controller = createAssistantController({
    camera,
    createSampler: () => sampler,
    mic,
    player,
    speech,
    createSocket,
    document,
    perfNow: () => perf,
    reconnectDelayMs: () => 100,
    ...over,
  });
  return {
    controller,
    camera,
    sampler,
    mic,
    player,
    speech,
    sockets,
    createSocket,
    get socket() {
      return sockets[sockets.length - 1]!;
    },
    setPerf: (p: number) => (perf = p),
  };
}

async function started(mode: 'live' | 'snapshot' = 'live', over: Partial<AssistantDeps> = {}) {
  const h = setup(over);
  const p = h.controller.start();
  h.socket.open();
  h.socket.receive(readyMsg(mode));
  await p;
  return h;
}

const setVisibility = (v: 'hidden' | 'visible') => {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => v });
  document.dispatchEvent(new Event('visibilitychange'));
};

beforeEach(() => {
  calls.length = 0;
  nextFrameId = 1;
  vi.useFakeTimers({ now: new Date('2026-11-23T10:00:00Z') });
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
});
afterEach(() => {
  vi.useRealTimers();
});

describe('start', () => {
  it('unlocks audio synchronously before anything else (inside the gesture)', async () => {
    const h = setup();
    const p = h.controller.start();
    // Synchronous part of start(): unlock first, then media + socket started in parallel.
    expect(calls[0]).toBe('player.unlock');
    expect(calls).toEqual(expect.arrayContaining(['camera.start', 'mic.start', 'createSocket']));
    expect(h.controller.getState().connection).toBe('connecting');
    h.socket.open();
    const hello = h.socket.sent[0]!;
    expect(hello).toMatchObject({ type: 'hello', protocolVersion: 1, mode: 'live', settings: { pushToTalk: false, detections: false } });
    expect(hello.type === 'hello' && hello.clientTime).toBe(Date.now());
    h.socket.receive(readyMsg());
    await p;
    const st = h.controller.getState();
    expect(st.connection).toBe('live');
    expect(st.server).toMatchObject({ configured: true, liveModel: 'gemini-3.8-live', sessionId: 's1' });
    expect(h.sampler.start).toHaveBeenCalled();
  });

  it('camera failure does not block voice', async () => {
    const h = setup();
    h.camera.start.mockImplementationOnce(async () => {
      h.camera.set({ status: 'denied', message: 'Camera permission denied.' });
      throw new Error('denied');
    });
    const p = h.controller.start();
    h.socket.open();
    h.socket.receive(readyMsg());
    await p;
    const st = h.controller.getState();
    expect(st.connection).toBe('live');
    expect(st.error).toMatchObject({ code: 'camera', action: 'open_settings' });
    h.mic.emit(loud);
    expect(h.socket.types()).toContain('audio');
  });

  it('getState returns a stable reference until something changes', async () => {
    const h = await started();
    const a = h.controller.getState();
    expect(h.controller.getState()).toBe(a);
    h.controller.updateSettings({ showDiagnostics: true });
    expect(h.controller.getState()).not.toBe(a);
  });

  it('missing credentials -> error state, no fabricated content', async () => {
    const h = setup();
    const p = h.controller.start();
    h.socket.open();
    h.socket.receive({ ...readyMsg('snapshot'), features: { live: false, snapshot: false, detections: false }, models: { live: null, vision: null } });
    h.socket.receive({ type: 'error', code: 'missing_credentials', message: 'The server has no Gemini API key configured.', recoverable: false });
    await p;
    const st = h.controller.getState();
    expect(st.connection).toBe('error');
    expect(st.server?.configured).toBe(false);
    expect(st.error).toMatchObject({ code: 'missing_credentials', recoverable: false });
    expect(st.transcript).toEqual([]);
  });
});

describe('playback', () => {
  it('interrupted flushes the player immediately and rejects later audio of that turn', async () => {
    const h = await started();
    h.socket.receive({ type: 'turn', turnId: 1, event: 'start', at: 0 });
    h.socket.receive({ type: 'audio', turnId: 1, seq: 0, data: 'AAAA' });
    expect(h.player.enqueued).toEqual([[1, 'AAAA']]);
    h.socket.receive({ type: 'turn', turnId: 1, event: 'interrupted', at: 0 });
    expect(h.player.flush).toHaveBeenLastCalledWith(1);
    h.socket.receive({ type: 'audio', turnId: 1, seq: 1, data: 'LATE' });
    expect(h.player.enqueued).toHaveLength(1);
    h.socket.receive({ type: 'turn', turnId: 2, event: 'start', at: 0 });
    h.socket.receive({ type: 'audio', turnId: 2, seq: 0, data: 'NEXT' });
    expect(h.player.enqueued.at(-1)).toEqual([2, 'NEXT']);
  });

  it('stopSpeaking flushes locally first, then sends playback.stop', async () => {
    const h = await started();
    h.socket.receive({ type: 'turn', turnId: 1, event: 'start', at: 0 });
    h.socket.receive({ type: 'audio', turnId: 1, seq: 0, data: 'AAAA' });
    h.controller.stopSpeaking();
    expect(h.player.flush).toHaveBeenLastCalledWith(1);
    expect(h.speech.cancel).toHaveBeenCalled();
    expect(h.socket.sent.at(-1)).toEqual({ type: 'playback.stop', turnId: 1 });
    h.socket.receive({ type: 'audio', turnId: 1, seq: 1, data: 'LATE' });
    h.socket.receive({ type: 'transcript', role: 'assistant', turnId: 1, text: 'late text', final: false });
    expect(h.player.enqueued).toHaveLength(1);
    expect(JSON.stringify(h.controller.getState().transcript)).not.toContain('late text');
  });

  it('stopSpeaking still silences locally when the socket is closed', async () => {
    const h = await started();
    h.socket.receive({ type: 'turn', turnId: 1, event: 'start', at: 0 });
    h.socket.receive({ type: 'audio', turnId: 1, seq: 0, data: 'AAAA' });
    h.socket.isOpen = false;
    h.player.flush.mockClear();
    h.speech.cancel.mockClear();
    h.controller.stopSpeaking();
    expect(h.player.flush).toHaveBeenCalledWith(1);
    expect(h.speech.cancel).toHaveBeenCalled();
  });

  it('suspended AudioContext surfaces a tap_to_resume error; resume() unlocks', async () => {
    const h = await started();
    h.player.setState({ contextState: 'suspended' });
    expect(h.controller.getState().error).toMatchObject({ code: 'audio_output', action: 'tap_to_resume' });
    await h.controller.resume();
    expect(h.player.unlock).toHaveBeenCalledTimes(2);
    expect(h.controller.getState().error).toBeNull();
  });
});

describe('transcripts and answers', () => {
  it('appends live fragments per (role, turn), finalises on complete, and measures latency', async () => {
    const h = await started();
    h.sampler.emit(frame()); // frame sent at t0
    vi.advanceTimersByTime(300);
    h.mic.emit(loud); // speech at t0+300
    vi.advanceTimersByTime(700);
    h.mic.emit(quiet);
    h.socket.receive({ type: 'turn', turnId: 1, event: 'start', at: 0 });
    h.socket.receive({ type: 'transcript', role: 'user', turnId: 1, text: 'What am I', final: false });
    h.socket.receive({ type: 'transcript', role: 'user', turnId: 1, text: ' holding?', final: false });
    vi.advanceTimersByTime(200);
    h.socket.receive({ type: 'transcript', role: 'assistant', turnId: 1, text: 'A tin', final: false });
    h.setPerf(1_000);
    h.player.audible(1, 1_100); // audible 100 ms in the future
    h.socket.receive({ type: 'transcript', role: 'assistant', turnId: 1, text: ' of beans.', final: false });
    h.socket.receive({ type: 'turn', turnId: 1, event: 'complete', at: 0 });
    const st = h.controller.getState();
    expect(st.transcript.map((e) => [e.role, e.text, e.final, e.source])).toEqual([
      ['user', 'What am I holding?', true, 'live_transcription'],
      ['assistant', 'A tin of beans.', true, 'live_transcription'],
    ]);
    expect(st.metrics.frameAgeAtQuestionMs).toBe(300);
    expect(st.metrics.questionToFirstTextMs).toBe(900);
    expect(st.metrics.questionToFirstAudioMs).toBe(1_000);
    expect(st.metrics.framesSent).toBe(1);
  });

  it('snapshot mode: typed question requires a fresh frame; answer is shown and spoken', async () => {
    const h = await started('snapshot');
    expect(h.controller.getState().connection).toBe('snapshot');
    await h.controller.sendText('What is this?');
    const text = h.socket.sent.find((m) => m.type === 'text')!;
    expect(text).toMatchObject({ type: 'text', text: 'What is this?', frame: { mimeType: 'image/jpeg' } });
    expect(h.camera.capture).toHaveBeenLastCalledWith({ maxDim: 1600, jpegQuality: 0.85 });
    expect(h.controller.getState().busy?.kind).toBe('answering');
    const requestId = text.type === 'text' ? text.requestId : '';
    h.socket.receive({ type: 'answer', requestId, text: 'A tin of tomatoes.', frameId: 1, model: 'v', latencyMs: 5 });
    const st = h.controller.getState();
    expect(st.busy).toBeNull();
    expect(st.transcript.map((e) => [e.role, e.source])).toEqual([
      ['user', 'typed'],
      ['assistant', 'snapshot_answer'],
    ]);
    expect(h.speech.speak).toHaveBeenCalledWith('A tin of tomatoes.');

    h.camera.setCapture(() => Promise.resolve(null));
    await h.controller.sendText('And now?');
    expect(h.socket.sent.filter((m) => m.type === 'text')).toHaveLength(1);
    expect(h.controller.getState().error).toMatchObject({ code: 'camera' });
  });

  it('readLabel captures a fresh high-res frame, sends the action and records evidence', async () => {
    const h = await started();
    await h.controller.readLabel();
    expect(h.camera.captureStill).toHaveBeenLastCalledWith({ maxDim: 4096, jpegQuality: 0.9, bestOf: 3 });
    expect(h.camera.capture).not.toHaveBeenCalled();
    const action = h.socket.sent.find((m) => m.type === 'action')!;
    expect(action).toMatchObject({ action: 'read_label', frame: { frameId: 1 } });
    expect(h.controller.getState().busy?.kind).toBe('reading_label');
    const requestId = action.type === 'action' ? action.requestId : '';
    h.socket.receive({
      type: 'evidence',
      requestId,
      evidence: {
        frameId: 1,
        capturedAt: Date.now(),
        readability: 'clear',
        exactText: [{ section: 'ingredients', text: 'Tomatoes' }],
        instructions: [],
        dates: [],
        batchCodes: [],
        itemGuess: null,
        issues: [],
        suggestion: null,
        model: 'v',
        latencyMs: 1,
      },
    });
    const st = h.controller.getState();
    expect(st.busy).toBeNull();
    expect(st.lastEvidence?.exactText[0]?.text).toBe('Tomatoes');
    expect(st.transcript.at(-1)).toMatchObject({ source: 'evidence', role: 'system' });
  });

  it('answers server snapshot.request with a fresh capture, or unavailable when the camera is off', async () => {
    const h = await started();
    h.socket.receive({ type: 'snapshot.request', requestId: 'snap-1', purpose: 'read_label', maxDim: 1600 });
    await vi.advanceTimersByTimeAsync(0);
    expect(h.socket.sent.at(-1)).toMatchObject({ type: 'snapshot.result', requestId: 'snap-1' });
    h.camera.set({ status: 'stopped' });
    h.socket.receive({ type: 'snapshot.request', requestId: 'snap-2', purpose: 'look_again', maxDim: 1024 });
    await vi.advanceTimersByTimeAsync(0);
    expect(h.socket.sent.at(-1)).toEqual({ type: 'snapshot.unavailable', requestId: 'snap-2', reason: 'camera_off' });
  });

  it('keeps only newer detections and clears them after the TTL', async () => {
    const h = await started();
    h.controller.updateSettings({ detections: true });
    expect(h.socket.sent.at(-1)).toEqual({ type: 'settings', settings: { pushToTalk: false, detections: true } });
    const det = (frameId: number, capturedAt = Date.now()): ServerDetections => ({
        type: 'detections',
        frameId,
        capturedAt,
        sourceWidth: 640,
        sourceHeight: 480,
        detectedAt: Date.now(),
        model: 'd',
        detections: [{ label: 'cup', score: 0.9, box: { x: 0, y: 0, w: 0.5, h: 0.5 } }],
    });
    h.socket.receive(det(5));
    expect(h.controller.getState().detections?.frameId).toBe(5);
    h.socket.receive(det(4));
    expect(h.controller.getState().detections?.frameId).toBe(5);
    vi.advanceTimersByTime(2_600);
    expect(h.controller.getState().detections).toBeNull();
    h.socket.receive(det(6, Date.now() - 5_000)); // already expired
    expect(h.controller.getState().detections).toBeNull();
  });
});

describe('mic gating', () => {
  it('push-to-talk: only streams while held, then sends audio.end once', async () => {
    const h = await started('live', { initialSettings: { pushToTalk: true } });
    h.mic.emit(loud);
    expect(h.socket.types()).not.toContain('audio');
    expect(h.mic.gate).toBe(false);
    h.controller.setTalking(true);
    expect(h.mic.gate).toBe(true);
    h.mic.emit(loud);
    h.mic.emit(loud);
    h.controller.setTalking(false);
    h.controller.setTalking(false);
    h.mic.emit(loud);
    expect(h.socket.types().filter((t) => t === 'audio' || t === 'audio.end')).toEqual(['audio', 'audio', 'audio.end']);
  });

  it('mute stops sending and sends audio.end once', async () => {
    const h = await started();
    h.mic.emit(loud);
    h.controller.setMuted(true);
    h.mic.emit(loud);
    expect(h.mic.setMuted).toHaveBeenLastCalledWith(true);
    expect(h.socket.types().filter((t) => t === 'audio' || t === 'audio.end')).toEqual(['audio', 'audio.end']);
  });

  it("micDuringReplies 'pause' gates the mic while the assistant is playing", async () => {
    const h = await started('live', { initialSettings: { micDuringReplies: 'pause' } });
    h.socket.receive({ type: 'turn', turnId: 1, event: 'start', at: 0 });
    h.socket.receive({ type: 'audio', turnId: 1, seq: 0, data: 'AAAA' });
    h.mic.emit(loud);
    expect(h.socket.types()).not.toContain('audio');
    h.player.setState({ playing: false, turnId: null });
    h.mic.emit(loud);
    expect(h.socket.types()).toContain('audio');
  });
});

describe('reconnect', () => {
  it('on socket loss: flushes, stops TTS, drops mic chunks, reconnects with resume, never replays', async () => {
    const h = await started();
    h.socket.receive({ type: 'turn', turnId: 1, event: 'start', at: 0 });
    h.socket.receive({ type: 'audio', turnId: 1, seq: 0, data: 'AAAA' });
    const first = h.socket;
    first.serverClose();
    expect(h.controller.getState().connection).toBe('reconnecting');
    expect(h.player.flush).toHaveBeenCalled();
    expect(h.speech.cancel).toHaveBeenCalled();
    h.mic.emit(loud); // generated while disconnected -> discarded
    h.sampler.emit(frame());
    vi.advanceTimersByTime(100);
    expect(h.sockets).toHaveLength(2);
    const second = h.socket;
    second.open();
    expect(second.sent[0]).toMatchObject({ type: 'hello', resume: true });
    second.receive(readyMsg());
    expect(h.controller.getState().connection).toBe('live');
    expect(h.controller.getState().metrics.reconnects).toBe(1);
    expect(second.types()).toEqual(['hello']); // nothing replayed
    h.mic.emit(loud);
    expect(second.types()).toEqual(['hello', 'audio']);
    // New server session numbers turns from 1 again; it must still play.
    second.receive({ type: 'turn', turnId: 1, event: 'start', at: 0 });
    second.receive({ type: 'audio', turnId: 1, seq: 0, data: 'NEW' });
    expect(h.player.enqueued.at(-1)![1]).toBe('NEW');
    // Late messages from the old socket are ignored.
    first.receive({ type: 'audio', turnId: 1, seq: 1, data: 'GHOST' });
    expect(h.player.enqueued.map((e) => e[1])).not.toContain('GHOST');
  });

  it('gives up after the bounded attempts with a retry action', async () => {
    const h = await started();
    for (let i = 0; i < 6; i++) {
      h.socket.serverClose();
      vi.advanceTimersByTime(100);
    }
    const st = h.controller.getState();
    expect(h.sockets).toHaveLength(6); // initial + 5 attempts
    expect(st.connection).toBe('error');
    expect(st.error).toMatchObject({ code: 'network', action: 'retry' });

    // Retry (start from a tap) tears down and starts a fresh session.
    calls.length = 0;
    const p = h.controller.start();
    expect(calls[0]).toBe('player.unlock');
    expect(h.sockets).toHaveLength(7);
    h.socket.open();
    expect(h.socket.sent[0]).toMatchObject({ type: 'hello' });
    expect(h.socket.sent[0]).not.toHaveProperty('resume');
    h.socket.receive(readyMsg());
    await p;
    expect(h.controller.getState()).toMatchObject({ connection: 'live', error: null });
  });

  it('start() while live retries a failed camera', async () => {
    const h = setup();
    h.camera.start.mockImplementationOnce(async () => {
      h.camera.set({ status: 'in_use', message: 'In use.' });
    });
    const p = h.controller.start();
    h.socket.open();
    h.socket.receive(readyMsg());
    await p;
    expect(h.controller.getState().error).toMatchObject({ code: 'camera', action: 'retry' });
    await h.controller.start();
    expect(h.camera.start).toHaveBeenCalledTimes(2);
    expect(h.sockets).toHaveLength(1);
    expect(h.controller.getState().error).toBeNull();
  });
});

describe('visibility', () => {
  it('hidden pauses everything; visible stays paused until resume()', async () => {
    const h = await started();
    h.socket.receive({ type: 'turn', turnId: 1, event: 'start', at: 0 });
    h.socket.receive({ type: 'audio', turnId: 1, seq: 0, data: 'AAAA' });
    h.mic.emit(loud);
    setVisibility('hidden');
    const st = h.controller.getState();
    expect(st.connection).toBe('paused');
    expect(h.socket.sent.slice(-2)).toEqual([{ type: 'audio.end' }, { type: 'visibility', state: 'hidden' }]);
    expect(h.sampler.stop).toHaveBeenCalled();
    expect(h.camera.pause).toHaveBeenCalled();
    expect(h.player.flush).toHaveBeenCalled();
    expect(h.speech.cancel).toHaveBeenCalled();
    h.mic.emit(loud);
    h.sampler.emit(frame());
    expect(h.socket.types().filter((t) => t === 'audio')).toHaveLength(1);

    setVisibility('visible');
    expect(h.controller.getState().connection).toBe('paused');
    h.sampler.start.mockClear();
    await h.controller.resume();
    expect(h.player.unlock).toHaveBeenCalledTimes(2);
    expect(h.camera.resume).toHaveBeenCalled();
    expect(h.socket.sent.at(-1)).toEqual({ type: 'visibility', state: 'visible' });
    expect(h.controller.getState().connection).toBe('live');
    expect(h.sampler.start).toHaveBeenCalled();
  });
});

describe('end', () => {
  it('stops camera, mic and sampler synchronously, says bye, and sends nothing afterwards', async () => {
    const h = await started();
    const capture = deferred<CapturedFrame | null>();
    h.camera.setStill(() => capture.promise);
    const reading = h.controller.readLabel(); // capture in flight
    h.socket.receive({ type: 'snapshot.request', requestId: 'snap-9', purpose: 'read_label', maxDim: 1600 }); // also in flight
    h.controller.end();
    expect(h.sampler.stop).toHaveBeenCalled();
    expect(h.camera.stop).toHaveBeenCalled();
    expect(h.mic.stop).toHaveBeenCalled();
    expect(h.player.flush).toHaveBeenCalled();
    expect(h.speech.cancel).toHaveBeenCalled();
    expect(h.socket.sent.at(-1)).toEqual({ type: 'bye' });
    expect(h.socket.close).toHaveBeenCalled();
    expect(h.controller.getState().connection).toBe('ended');
    const sentAtEnd = h.socket.send.mock.calls.length;

    capture.resolve(frame());
    await reading;
    await vi.advanceTimersByTimeAsync(60_000);
    h.mic.emit(loud);
    h.sampler.emit(frame());
    h.controller.repeat();
    await h.controller.sendText('anything');
    h.controller.stopSpeaking();
    h.socket.receive({ type: 'snapshot.request', requestId: 'snap-10', purpose: 'read_label', maxDim: 1600 });
    await vi.advanceTimersByTimeAsync(0);
    expect(h.socket.send.mock.calls.length).toBe(sentAtEnd);
    expect(h.sockets).toHaveLength(1);
    expect(h.camera.captureStill).toHaveBeenCalledTimes(2); // only the two in flight before end
    expect(h.camera.capture).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// v2: spatial cues, detect sampler, find mode, detail stills, torch (FIXTURE fakes)
// ---------------------------------------------------------------------------

function fakeSpatial() {
  const sp = {
    supported: true,
    unlock: vi.fn(() => {
      calls.push('spatial.unlock');
      return Promise.resolve();
    }),
    setTarget: vi.fn((_t: CueTarget | null) => undefined),
    startTracking: vi.fn(),
    stopTracking: vi.fn(),
    earcon: vi.fn((_k: Earcon) => undefined),
    setDucked: vi.fn((_d: boolean) => undefined),
    configure: vi.fn((_o: { earcons: boolean; spatial: boolean; haptics: boolean; headphones: boolean }) => undefined),
    close: vi.fn(async () => undefined),
    earcons: () => sp.earcon.mock.calls.map((c) => c[0]),
  };
  return sp satisfies SpatialCueEngine;
}

const readyWithDetector = (): ServerMessageOf<'ready'> => ({ ...readyMsg(), features: { live: true, snapshot: true, detections: true } });

async function startedV2(opts: { detector?: boolean; initialSettings?: AssistantDeps['initialSettings'] } = {}) {
  const spatial = fakeSpatial();
  const detectSampler = fakeSampler();
  const h = setup({ spatial, createDetectSampler: () => detectSampler, ...(opts.initialSettings ? { initialSettings: opts.initialSettings } : {}) });
  const p = h.controller.start();
  h.socket.open();
  h.socket.receive(opts.detector ? readyWithDetector() : readyMsg());
  await p;
  return { ...h, spatial, detectSampler };
}

const findMsg = (over: Partial<ServerMessageOf<'find'>>): ServerMessageOf<'find'> => ({
  type: 'find',
  requestId: 'find-1',
  query: 'mug',
  state: 'searching',
  source: 'yolo',
  target: null,
  frameId: null,
  description: null,
  at: Date.now(),
  ...over,
});

const boxAt = (cx: number, cy: number, s = 0.1) => ({ x: cx - s / 2, y: cy - s / 2, w: s, h: s });

describe('spatial cues and settings', () => {
  it('unlocks the cue engine synchronously in start(), plays session_start on ready and session_end on end', async () => {
    const spatial = fakeSpatial();
    const h = setup({ spatial });
    const p = h.controller.start();
    expect(calls.slice(0, 2)).toEqual(['player.unlock', 'spatial.unlock']);
    h.socket.open();
    h.socket.receive(readyMsg());
    await p;
    expect(spatial.earcons()).toEqual(['session_start']);
    h.controller.end();
    expect(spatial.earcons()).toEqual(['session_start', 'session_end']);
    expect(spatial.stopTracking).toHaveBeenCalled();
  });

  it('defaults earcons/spatial/haptics on and headphones off, and reconfigures on change', async () => {
    const h = await startedV2();
    expect(h.controller.getState().settings).toMatchObject({ earcons: true, spatialAudio: true, haptics: true, headphones: false });
    expect(h.spatial.configure).toHaveBeenLastCalledWith({ earcons: true, spatial: true, haptics: true, headphones: false });
    h.controller.updateSettings({ headphones: true, haptics: false });
    expect(h.spatial.configure).toHaveBeenLastCalledWith({ earcons: true, spatial: true, haptics: false, headphones: true });
  });

  it('turns detections on after ready when the server has a detector, unless the user chose', async () => {
    const h = await startedV2({ detector: true });
    expect(h.controller.getState().settings.detections).toBe(true);
    expect(h.socket.sent).toContainEqual({ type: 'settings', settings: { pushToTalk: false, detections: true } });
    const off = await startedV2({ detector: true, initialSettings: { detections: false } });
    expect(off.controller.getState().settings.detections).toBe(false);
  });

  it('ducks cues while the assistant speaks', async () => {
    const h = await startedV2();
    h.socket.receive({ type: 'turn', turnId: 1, event: 'start', at: Date.now() });
    h.socket.receive({ type: 'audio', turnId: 1, seq: 0, data: 'AAAA' });
    expect(h.spatial.setDucked).toHaveBeenLastCalledWith(true);
    h.player.setState({ playing: false, turnId: null });
    expect(h.spatial.setDucked).toHaveBeenLastCalledWith(false);
  });

  it('push-to-talk press ticks; server errors buzz', async () => {
    const h = await startedV2();
    h.controller.updateSettings({ pushToTalk: true });
    h.controller.setTalking(true);
    expect(h.spatial.earcons()).toContain('listening');
    h.socket.receive({ type: 'error', code: 'rate_limited', message: 'Slow down.', recoverable: true });
    expect(h.spatial.earcons().at(-1)).toBe('error');
  });

  it("'working' tick after 1.5 s busy, repeating, and stops when busy ends", async () => {
    const h = await startedV2();
    const slow = deferred<CapturedFrame | null>();
    h.camera.setCapture(() => slow.promise);
    void h.controller.lookAgain();
    vi.advanceTimersByTime(1_400);
    expect(h.spatial.earcons()).not.toContain('working');
    vi.advanceTimersByTime(200);
    expect(h.spatial.earcons().filter((k) => k === 'working')).toHaveLength(1);
    vi.advanceTimersByTime(1_200);
    expect(h.spatial.earcons().filter((k) => k === 'working')).toHaveLength(2);
    h.socket.receive({ type: 'turn', turnId: 1, event: 'start', at: Date.now() }); // answer arrives -> not busy
    slow.resolve(null);
    await vi.advanceTimersByTimeAsync(0);
    expect(h.controller.getState().busy).toBeNull();
    const n = h.spatial.earcons().length;
    vi.advanceTimersByTime(5_000);
    expect(h.spatial.earcons().length).toBe(n);
  });
});

describe('detect sampler', () => {
  it('runs while detections are on with a detector, sends detect.frame, drops under backpressure, stops on pause and end', async () => {
    const h = await startedV2({ detector: true });
    expect(h.detectSampler.running).toBe(true);
    h.detectSampler.emit(frame());
    expect(h.socket.sent.at(-1)).toMatchObject({ type: 'detect.frame', frame: { mimeType: 'image/jpeg' } });
    h.socket.bufferedAmount = 1_000_000;
    const n = h.socket.sent.length;
    h.detectSampler.emit(frame());
    expect(h.socket.sent.length).toBe(n);
    h.socket.bufferedAmount = 0;
    h.controller.updateSettings({ detections: false });
    expect(h.detectSampler.running).toBe(false);
    h.controller.updateSettings({ detections: true });
    expect(h.detectSampler.running).toBe(true);
    setVisibility('hidden');
    expect(h.detectSampler.running).toBe(false);
    setVisibility('visible');
    await h.controller.resume();
    expect(h.detectSampler.running).toBe(true);
    h.controller.end();
    expect(h.detectSampler.running).toBe(false);
  });

  it('does not run without a detector unless find is active', async () => {
    const h = await startedV2();
    h.controller.updateSettings({ detections: true });
    expect(h.detectSampler.running).toBe(false);
    await h.controller.find('salt');
    expect(h.detectSampler.running).toBe(true);
    h.controller.stopFind();
    expect(h.detectSampler.running).toBe(false);
  });
});

describe('find mode', () => {
  it('find(): unlocks synchronously, sends find, searching -> tracking -> centered -> lost -> not_found', async () => {
    const h = await startedV2({ detector: true });
    calls.length = 0;
    const p = h.controller.find('  mug ');
    expect(calls[0]).toBe('spatial.unlock');
    await p;
    const sent = h.socket.sent.at(-1)!;
    expect(sent).toMatchObject({ type: 'find', query: 'mug' });
    const requestId = sent.type === 'find' ? sent.requestId : '';
    let st = h.controller.getState();
    expect(st.find).toMatchObject({ query: 'mug', state: 'searching', source: 'yolo', target: null });
    expect(st.busy?.kind).toBe('finding');
    expect(h.spatial.startTracking).toHaveBeenCalled();

    h.socket.receive(findMsg({ requestId }));
    h.socket.receive(
      findMsg({ requestId, state: 'tracking', target: { label: 'cup', score: 0.8, box: boxAt(0.2, 0.3) }, frameId: 4, description: 'left of the picture, near the top, small' }),
    );
    st = h.controller.getState();
    expect(st.busy).toBeNull();
    expect(st.find).toMatchObject({ state: 'tracking', description: 'left of the picture, near the top, small' });
    expect(h.spatial.setTarget).toHaveBeenLastCalledWith({ cx: 0.2, cy: 0.3, area: expect.closeTo(0.01) as unknown as number, centered: false });
    expect(st.announcement?.text).toBe('mug: left of the picture, near the top, small.');

    h.socket.receive(findMsg({ requestId, state: 'centered', target: { label: 'cup', score: 0.8, box: boxAt(0.52, 0.5) }, frameId: 6, description: 'in the centre of the picture, small' }));
    expect(h.spatial.setTarget).toHaveBeenLastCalledWith(expect.objectContaining({ centered: true }));
    expect(h.spatial.earcons().filter((k) => k === 'found')).toHaveLength(1);
    expect(h.controller.getState().announcement?.text).toBe('mug centred.');
    h.socket.receive(findMsg({ requestId, state: 'tracking', target: { label: 'cup', score: 0.8, box: boxAt(0.8, 0.5) }, frameId: 7, description: 'x' }));
    h.socket.receive(findMsg({ requestId, state: 'centered', target: { label: 'cup', score: 0.8, box: boxAt(0.5, 0.5) }, frameId: 8, description: 'y' }));
    expect(h.spatial.earcons().filter((k) => k === 'found')).toHaveLength(1); // first time only

    h.socket.receive(findMsg({ requestId, state: 'lost' }));
    expect(h.spatial.setTarget).toHaveBeenLastCalledWith(null);
    h.socket.receive(findMsg({ requestId, state: 'not_found' }));
    st = h.controller.getState();
    expect(st.find).toBeNull();
    expect(h.spatial.stopTracking).toHaveBeenCalled();
    expect(st.announcement?.text).toBe('Could not find mug in the picture.');
  });

  it('stopFind sends find.stop, clears state, and ignores late updates for that find', async () => {
    const h = await startedV2({ detector: true });
    await h.controller.find('mug');
    const sent = h.socket.sent.at(-1)!;
    const requestId = sent.type === 'find' ? sent.requestId : '';
    h.controller.stopFind();
    expect(h.socket.sent.at(-1)).toEqual({ type: 'find.stop' });
    expect(h.controller.getState().find).toBeNull();
    expect(h.controller.getState().busy).toBeNull();
    h.socket.receive(findMsg({ requestId, state: 'tracking', target: { label: 'cup', score: 0.8, box: boxAt(0.2, 0.3) }, frameId: 4, description: 'd' }));
    h.socket.receive(findMsg({ requestId, state: 'stopped' }));
    expect(h.controller.getState().find).toBeNull();
  });

  it('adopts an assistant-started find (find_object tool) without speaking over the assistant', async () => {
    const h = await startedV2({ detector: true });
    h.socket.receive({ type: 'tool', callId: 'c1', name: 'find_object', state: 'started' });
    expect(h.controller.getState().busy).toBeNull();
    h.socket.receive(findMsg({ requestId: 'tool-find-1', query: 'salt', source: 'gemini' }));
    expect(h.controller.getState().find).toMatchObject({ query: 'salt', source: 'gemini', state: 'searching' });
    expect(h.spatial.startTracking).toHaveBeenCalled();
    h.socket.receive(
      findMsg({ requestId: 'tool-find-1', query: 'salt', source: 'gemini', state: 'centered', target: { label: 'salt', score: 0.7, box: boxAt(0.5, 0.5) }, frameId: 3, description: 'c' }),
    );
    expect(h.spatial.earcons()).toContain('found');
    expect(h.controller.getState().announcement?.text).not.toBe('salt centred.');
  });

  it('a server error for the find request clears it', async () => {
    const h = await startedV2();
    await h.controller.find('salt');
    const sent = h.socket.sent.at(-1)!;
    const requestId = sent.type === 'find' ? sent.requestId : '';
    h.socket.receive({ type: 'error', code: 'detector_unavailable', message: 'Find is not available.', recoverable: true, requestId });
    expect(h.controller.getState().find).toBeNull();
    expect(h.spatial.stopTracking).toHaveBeenCalled();
  });

  it('socket loss and pausing end the find locally', async () => {
    const h = await startedV2({ detector: true });
    await h.controller.find('mug');
    setVisibility('hidden');
    expect(h.controller.getState().find).toBeNull();
    setVisibility('visible');
    await h.controller.resume();
    await h.controller.find('mug');
    h.socket.serverClose();
    expect(h.controller.getState().find).toBeNull();
  });

  it('shows detections while finding even with overlays off; per-source ordering and TTLs', async () => {
    const h = await startedV2({ detector: true, initialSettings: { detections: false } });
    const det = (frameId: number, source: 'yolo' | 'gemini', capturedAt = Date.now()): ServerDetections => ({
      type: 'detections',
      frameId,
      capturedAt,
      sourceWidth: 640,
      sourceHeight: 480,
      detectedAt: Date.now(),
      model: 'd',
      detections: [{ label: 'cup', score: 0.9, box: boxAt(0.5, 0.5), target: true }],
      source,
    });
    h.socket.receive(det(1, 'yolo'));
    expect(h.controller.getState().detections).toBeNull(); // overlays off, no find
    await h.controller.find('salt');
    h.socket.receive(det(9, 'yolo'));
    h.socket.receive(det(5, 'gemini')); // older frame but a different source: shown
    expect(h.controller.getState().detections).toMatchObject({ frameId: 5, source: 'gemini' });
    h.socket.receive(det(4, 'gemini'));
    expect(h.controller.getState().detections?.frameId).toBe(5);
    vi.advanceTimersByTime(LIMITS.detectionTtlMs + 100);
    expect(h.controller.getState().detections).not.toBeNull(); // Gemini boxes live a little longer
    vi.advanceTimersByTime(LIMITS.locateMinIntervalMs);
    expect(h.controller.getState().detections).toBeNull();
  });
});

describe('detail stills and torch', () => {
  it('readLabel: hold-still tick, captureStill at detail resolution, then the shutter cue', async () => {
    const h = await startedV2();
    await h.controller.readLabel();
    expect(h.camera.captureStill).toHaveBeenCalledWith({ maxDim: LIMITS.detailMaxDim, jpegQuality: LIMITS.detailJpegQuality, bestOf: LIMITS.detailBestOf });
    expect(h.spatial.earcons().slice(-2)).toEqual(['listening', 'capture']);
    expect(h.socket.sent.at(-1)).toMatchObject({ type: 'action', action: 'read_label' });
  });

  it('falls back to capture() when captureStill returns null', async () => {
    const h = await startedV2();
    h.camera.setStill(() => Promise.resolve(null));
    await h.controller.readLabel();
    expect(h.camera.capture).toHaveBeenLastCalledWith({ maxDim: LIMITS.snapshotMaxDim, jpegQuality: LIMITS.snapshotJpegQuality });
    expect(h.socket.sent.at(-1)).toMatchObject({ type: 'action', action: 'read_label' });
  });

  it('snapshot.request read_label uses captureStill; look_again and locate use capture()', async () => {
    const h = await startedV2();
    h.socket.receive({ type: 'snapshot.request', requestId: 'snap-1', purpose: 'read_label', maxDim: 1600 });
    await vi.advanceTimersByTimeAsync(0);
    expect(h.camera.captureStill).toHaveBeenCalledTimes(1);
    expect(h.socket.sent.at(-1)).toMatchObject({ type: 'snapshot.result', requestId: 'snap-1' });
    h.socket.receive({ type: 'snapshot.request', requestId: 'snap-2', purpose: 'locate', maxDim: 1024 });
    await vi.advanceTimersByTimeAsync(0);
    expect(h.camera.capture).toHaveBeenLastCalledWith({ maxDim: 1024, jpegQuality: LIMITS.snapshotJpegQuality });
    expect(h.camera.captureStill).toHaveBeenCalledTimes(1);
  });

  it('setTorch drives the camera and the state mirrors camera.torch', async () => {
    const h = await startedV2();
    await h.controller.setTorch(true);
    expect(h.camera.setTorch).toHaveBeenCalledWith(true);
    expect(h.controller.getState().camera.torch).toEqual({ supported: true, on: true });
    expect(h.controller.getState().announcement?.text).toBe('Torch on.');
    h.camera.set({ torch: { supported: false, on: false } });
    await h.controller.setTorch(true);
    expect(h.controller.getState().announcement?.text).toBe('The torch is not available on this camera.');
  });
});
