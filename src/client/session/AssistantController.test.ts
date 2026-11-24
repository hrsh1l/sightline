// @vitest-environment jsdom
/**
 * AssistantController tests. Every collaborator here is a FIXTURE fake (camera, sampler, mic, player,
 * speech, socket); nothing touches real media devices or a real server.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  AssistantSettings,
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
import {
  CALIBRATION_FALLBACK_TEXT,
  CAMERA_STOPPED_FIND_TEXT,
  CENTRED_SPEECH_DELAY_MS,
  GUIDANCE_TTS_TAIL_MS,
  GUIDANCE_WAIT_FOR_ASSISTANT_MS,
  GUIDE_INSPECT_TIMEOUT_MS,
  REAR_CAMERA_PROMPT,
  SPOKEN_DIRECTION_INTERVAL_MS,
  USER_SPEECH_SUPPRESS_MS,
  createAssistantController,
  directionWord,
  type AssistantDeps,
} from './AssistantController.js';
import type { SessionSocketLike } from './SessionSocket.js';
import { IDLE_GUIDE, type GuideSnapshot } from '../../shared/guide.js';
import { GUIDE_LOST_TEXT } from './guideSpeech.js';
import { makeGuide } from '../ui/__fixtures__/fakeController.js';

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
    context: null,
    setState: s.set,
    audible: (t: number, at: number) => {
      for (const l of audibleLs) l(t, at);
    },
  };
  return player satisfies AudioPlayer;
}

/** FIXTURE: browser TTS fake with speaking-change events; finish() simulates the utterance ending. */
function fakeSpeech() {
  const ls = new Set<(s: boolean) => void>();
  const emit = (v: boolean) => {
    if (sp.speaking === v) return;
    sp.speaking = v;
    for (const l of [...ls]) l(v);
  };
  const sp = {
    supported: true,
    speaking: false,
    speak: vi.fn((_t: string) => emit(true)),
    cancel: vi.fn(() => emit(false)),
    onSpeakingChange: (cb: (s: boolean) => void) => {
      ls.add(cb);
      return () => ls.delete(cb);
    },
    finish: () => emit(false),
    spoken: () => sp.speak.mock.calls.map((c) => c[0]),
  };
  return sp satisfies SpeechOutput;
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
    setSuppressed: vi.fn((s: boolean) => {
      sp.suppressed = s;
    }),
    suppressed: false,
    calibrationTone: vi.fn((ch: 'left' | 'right' | 'centre') => {
      calls.push(`tone.${ch}`);
      return Promise.resolve();
    }),
    cancelCalibrationTone: vi.fn(),
    audibleUntil: Number.NEGATIVE_INFINITY,
    configure: vi.fn((_o: { earcons: boolean; beacon: boolean; haptics: boolean; volume: number }) => undefined),
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

  it('v3 defaults (cueVolume 0.5, stereo, keep) and configure({ earcons, beacon, haptics, volume })', async () => {
    const h = await startedV2();
    const s = h.controller.getState().settings;
    expect(s).toMatchObject({ earcons: true, spatialAudio: true, haptics: true, cueVolume: 0.5, guidanceMode: 'stereo', findMicPolicy: 'keep' });
    expect('headphones' in s).toBe(false);
    expect(h.spatial.configure).toHaveBeenLastCalledWith({ earcons: true, beacon: true, haptics: true, volume: 0.5 });
    h.controller.updateSettings({ cueVolume: 0.8, haptics: false });
    expect(h.spatial.configure).toHaveBeenLastCalledWith({ earcons: true, beacon: true, haptics: false, volume: 0.8 });
    h.controller.updateSettings({ guidanceMode: 'spoken' });
    expect(h.spatial.configure).toHaveBeenLastCalledWith({ earcons: true, beacon: false, haptics: false, volume: 0.8 });
    h.controller.updateSettings({ guidanceMode: 'stereo', spatialAudio: false });
    expect(h.spatial.configure).toHaveBeenLastCalledWith({ earcons: true, beacon: false, haptics: false, volume: 0.8 });
    h.controller.updateSettings({ cueVolume: 7 });
    expect(h.controller.getState().settings.cueVolume).toBe(1);
  });

  it('drops a persisted v2 headphones setting', () => {
    const h = setup({ initialSettings: { headphones: true } as unknown as Partial<AssistantSettings> });
    expect('headphones' in h.controller.getState().settings).toBe(false);
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
      findMsg({
        requestId,
        state: 'tracking',
        target: { label: 'cup', score: 0.8, box: boxAt(0.2, 0.3) },
        frameId: 4,
        description: 'left of the picture, near the top, small',
        trackId: 3,
        observedAt: Date.now(),
      }),
    );
    st = h.controller.getState();
    expect(st.busy).toBeNull();
    expect(st.find).toMatchObject({ state: 'tracking', description: 'left of the picture, near the top, small', trackId: 3, observedAt: Date.now() });
    expect(h.spatial.setTarget).toHaveBeenLastCalledWith({ cx: 0.2, cy: 0.3, area: expect.closeTo(0.01) as unknown as number, centered: false, observedAt: Date.now() });

    h.socket.receive(findMsg({ requestId, state: 'centered', target: { label: 'cup', score: 0.8, box: boxAt(0.52, 0.5) }, frameId: 6, trackId: 3, observedAt: Date.now() }));
    expect(h.spatial.setTarget).toHaveBeenLastCalledWith(expect.objectContaining({ centered: true }));
    expect(h.spatial.earcons().filter((k) => k === 'found')).toHaveLength(1);
    h.socket.receive(findMsg({ requestId, state: 'centered', target: { label: 'cup', score: 0.8, box: boxAt(0.5, 0.5) }, frameId: 7, trackId: 3, observedAt: Date.now() }));
    expect(h.spatial.earcons().filter((k) => k === 'found')).toHaveLength(1); // once while it stays centred

    h.socket.receive(findMsg({ requestId, state: 'lost', trackId: 3 }));
    expect(h.spatial.setTarget).toHaveBeenLastCalledWith(null);
    expect(h.spatial.earcons().at(-1)).toBe('lost');
    h.socket.receive(findMsg({ requestId, state: 'not_found' }));
    st = h.controller.getState();
    expect(st.find).toMatchObject({ state: 'not_found' }); // inactive final status for the UI
    expect(h.spatial.stopTracking).toHaveBeenCalled();
    expect(st.announcement?.text).toBe('Could not find mug in the picture.');
    h.controller.stopFind();
    expect(h.controller.getState().find).toBeNull();
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

// ---------------------------------------------------------------------------
// v3: directional Find client audio (FIXTURE fakes: spatial engine, TTS, mic, socket)
// ---------------------------------------------------------------------------

async function finding(opts: { initialSettings?: AssistantDeps['initialSettings'] } = {}) {
  const h = await startedV2({ detector: true, ...opts });
  await h.controller.find('mug');
  const sent = h.socket.sent.at(-1)!;
  const requestId = sent.type === 'find' ? sent.requestId : '';
  return { ...h, requestId };
}

type FindOver = Partial<ServerMessageOf<'find'>>;
const seen = (requestId: string, cx: number, cy: number, over: FindOver = {}): ServerMessageOf<'find'> =>
  findMsg({ requestId, state: 'tracking', target: { label: 'cup', score: 0.8, box: boxAt(cx, cy) }, frameId: 1, trackId: 1, observedAt: Date.now(), ...over });
const prompt = (kind: NonNullable<ServerMessageOf<'find'>['prompt']>['kind'], text: string) => ({ prompt: { kind, text } });

describe('find v3: beacon target', () => {
  it('only a fresh observation of the selected target drives the beacon', async () => {
    const h = await finding();
    h.socket.receive(seen(h.requestId, 0.2, 0.5, { observedAt: Date.now() - LIMITS.findObservationMaxAgeMs - 1 }));
    expect(h.spatial.setTarget).toHaveBeenLastCalledWith(null); // stale -> silence
    h.socket.receive(seen(h.requestId, 0.2, 0.5, { observedAt: null }));
    expect(h.spatial.setTarget).toHaveBeenLastCalledWith(null); // no capture time -> never steer
    h.socket.receive(seen(h.requestId, 0.2, 0.5));
    expect(h.spatial.setTarget).toHaveBeenLastCalledWith(expect.objectContaining({ cx: 0.2, centered: false }));
    h.socket.receive(findMsg({ requestId: h.requestId, state: 'searching' }));
    expect(h.spatial.setTarget).toHaveBeenLastCalledWith(null);
  });

  it('needs_selection: candidates in state, selectTarget sends find.select, no beacon', async () => {
    const h = await finding();
    const candidates = [
      { id: 1, label: 'cup', score: 0.9, box: boxAt(0.2, 0.5), position: 'left' as const },
      { id: 2, label: 'cup', score: 0.8, box: boxAt(0.8, 0.5), position: 'right' as const },
    ];
    h.socket.receive(findMsg({ requestId: h.requestId, state: 'needs_selection', candidates }));
    expect(h.controller.getState().find?.candidates).toEqual(candidates);
    expect(h.controller.getState().busy).toBeNull();
    expect(h.spatial.setTarget).toHaveBeenLastCalledWith(null);
    expect(h.controller.getState().announcement?.text).toBe('2 matches: left cup, right cup. Choose one.');
    h.controller.selectTarget(2);
    expect(h.socket.sent.at(-1)).toEqual({ type: 'find.select', candidateId: 2 });
    h.controller.selectTarget(-1);
    expect(h.socket.sent.at(-1)).toEqual({ type: 'find.select', candidateId: 2 });
  });

  it('a different trackId clears the old target before the new one', async () => {
    const h = await finding();
    h.socket.receive(seen(h.requestId, 0.2, 0.5, { trackId: 1 }));
    h.spatial.setTarget.mockClear();
    h.socket.receive(seen(h.requestId, 0.8, 0.5, { trackId: 2 }));
    expect(h.spatial.setTarget.mock.calls.map((c) => (c[0] ? c[0].cx : null))).toEqual([null, 0.8]);
  });

  it('beacon is suppressed while assistant audio plays', async () => {
    const h = await finding();
    h.socket.receive({ type: 'turn', turnId: 1, event: 'start', at: Date.now() });
    h.socket.receive({ type: 'audio', turnId: 1, seq: 0, data: 'AAAA' });
    expect(h.spatial.setSuppressed).toHaveBeenLastCalledWith(true);
    h.player.setState({ playing: false, turnId: null });
    expect(h.spatial.setSuppressed).toHaveBeenLastCalledWith(false);
  });
});

describe('find v3: spoken prompts', () => {
  it('speaks a prompt once with local TTS and does not also announce it', async () => {
    const h = await finding();
    const tilt = prompt('tilt_up', 'Tilt the phone up slightly.');
    h.socket.receive(seen(h.requestId, 0.5, 0.2, tilt));
    h.socket.receive(seen(h.requestId, 0.5, 0.2, tilt)); // repeated in the next update
    expect(h.speech.spoken()).toEqual(['Tilt the phone up slightly.']);
    expect(h.controller.getState().find?.lastPrompt).toEqual(tilt.prompt);
    expect(h.controller.getState().announcement?.text).not.toBe('Tilt the phone up slightly.');
    expect(h.spatial.setSuppressed).toHaveBeenLastCalledWith(true); // beacon silent under guidance speech
    h.speech.finish();
    expect(h.spatial.setSuppressed).toHaveBeenLastCalledWith(false);
  });

  it('waits while Gemini audio plays, then speaks; gives up waiting after ~4 s', async () => {
    const h = await finding();
    h.socket.receive({ type: 'turn', turnId: 1, event: 'start', at: Date.now() });
    h.socket.receive({ type: 'audio', turnId: 1, seq: 0, data: 'AAAA' });
    h.socket.receive(findMsg({ requestId: h.requestId, state: 'searching', ...prompt('not_seen', "I don't see a mug yet.") }));
    expect(h.speech.speak).not.toHaveBeenCalled();
    h.player.setState({ playing: false, turnId: null });
    expect(h.speech.spoken()).toEqual(["I don't see a mug yet."]);
    h.speech.finish();
    // Still playing after 4 s: speak anyway.
    h.player.setState({ playing: true, turnId: 2 });
    h.socket.receive(seen(h.requestId, 0.2, 0.5, prompt('tracking', 'Mug found.')));
    vi.advanceTimersByTime(GUIDANCE_WAIT_FOR_ASSISTANT_MS - 100);
    expect(h.speech.spoken()).toHaveLength(1);
    vi.advanceTimersByTime(200);
    expect(h.speech.spoken().at(-1)).toBe('Mug found.');
  });

  it('a newer prompt of the same kind replaces an unspoken older one; never cuts off speech', async () => {
    const h = await finding();
    h.socket.receive(seen(h.requestId, 0.2, 0.5, prompt('tracking', 'Mug found.')));
    expect(h.speech.spoken()).toEqual(['Mug found.']);
    h.socket.receive(seen(h.requestId, 0.5, 0.2, prompt('tilt_up', 'Tilt the phone up slightly.')));
    h.socket.receive(seen(h.requestId, 0.5, 0.8, prompt('tilt_down', 'Tilt the phone down slightly.')));
    expect(h.speech.spoken()).toHaveLength(1); // first phrase still speaking
    expect(h.speech.cancel).not.toHaveBeenCalled();
    h.speech.finish();
    expect(h.speech.spoken()).toEqual(['Mug found.', 'Tilt the phone down slightly.']);
  });

  it('drops a queued tilt prompt once the target is centred, then chimes and confirms', async () => {
    const h = await finding();
    h.socket.receive(seen(h.requestId, 0.2, 0.5, prompt('tracking', 'Mug found.')));
    h.socket.receive(seen(h.requestId, 0.5, 0.2, prompt('tilt_up', 'Tilt the phone up slightly.')));
    h.socket.receive(seen(h.requestId, 0.5, 0.5, { state: 'centered', ...prompt('centred', 'Mug centred in the camera.') }));
    expect(h.spatial.earcons().filter((k) => k === 'found')).toHaveLength(1);
    h.speech.finish();
    expect(h.speech.spoken()).toEqual(['Mug found.']); // confirmation waits a moment after the chime
    vi.advanceTimersByTime(CENTRED_SPEECH_DELAY_MS);
    expect(h.speech.spoken()).toEqual(['Mug found.', 'Mug centred in the camera.']);
    const foundAt = h.spatial.earcon.mock.invocationCallOrder[h.spatial.earcons().lastIndexOf('found')]!;
    expect(foundAt).toBeLessThan(h.speech.speak.mock.invocationCallOrder.at(-1)!);
  });

  it('final unsupported prompt is spoken and kept as an inactive status', async () => {
    const h = await finding();
    h.socket.receive(findMsg({ requestId: h.requestId, state: 'unsupported', ...prompt('unsupported', 'I can find cups or mugs, bottles, bowls, apples and bananas.') }));
    expect(h.speech.spoken().at(-1)).toBe('I can find cups or mugs, bottles, bowls, apples and bananas.');
    expect(h.controller.getState().find).toMatchObject({ state: 'unsupported', lastPrompt: { kind: 'unsupported' } });
  });

  it('ignores select_target / stop_finding tool events (no busy state)', async () => {
    const h = await finding();
    h.socket.receive(seen(h.requestId, 0.2, 0.5));
    h.socket.receive({ type: 'tool', callId: 'c', name: 'select_target', state: 'started' });
    h.socket.receive({ type: 'tool', callId: 'd', name: 'stop_finding', state: 'started' });
    expect(h.controller.getState().busy).toBeNull();
  });
});

describe('find v3: spoken-direction mode', () => {
  it('says Left/Right first, then Up/Down, throttled, silent when centred or stale, never over speech', async () => {
    const h = await finding({ initialSettings: { guidanceMode: 'spoken' } });
    expect(h.spatial.configure).toHaveBeenLastCalledWith(expect.objectContaining({ beacon: false }));
    h.socket.receive(seen(h.requestId, 0.2, 0.2));
    expect(h.speech.spoken()).toEqual(['Left']);
    h.speech.finish();
    h.socket.receive(seen(h.requestId, 0.2, 0.2));
    expect(h.speech.spoken()).toHaveLength(1); // throttled
    vi.advanceTimersByTime(SPOKEN_DIRECTION_INTERVAL_MS);
    h.socket.receive(seen(h.requestId, 0.85, 0.5));
    expect(h.speech.spoken().at(-1)).toBe('Right');
    h.speech.finish();
    vi.advanceTimersByTime(SPOKEN_DIRECTION_INTERVAL_MS);
    h.socket.receive(seen(h.requestId, 0.5, 0.8, prompt('tilt_down', 'Tilt the phone down slightly.')));
    expect(h.speech.spoken().at(-1)).toBe('Down'); // server tilt hint skipped in spoken mode
    h.speech.finish();
    vi.advanceTimersByTime(SPOKEN_DIRECTION_INTERVAL_MS);
    h.socket.receive(seen(h.requestId, 0.5, 0.15, { observedAt: Date.now() - 5_000 }));
    h.socket.receive(seen(h.requestId, 0.5, 0.5, { state: 'centered' }));
    expect(h.speech.spoken().at(-1)).toBe('Down'); // stale / centred -> nothing new
    // Not while the assistant talks.
    h.player.setState({ playing: true, turnId: 1 });
    h.socket.receive(seen(h.requestId, 0.1, 0.5));
    expect(h.speech.spoken().at(-1)).toBe('Down');
    expect(directionWord(0.5 + LIMITS.findCenterEnter.x / 2, 0.5)).toBeNull();
    expect(directionWord(0.5, 0.5 - LIMITS.findCenterEnter.y - 0.01)).toBe('Up');
  });
});

describe('find v3: rear camera and lifecycle', () => {
  it('requires the rear camera', async () => {
    const h = await startedV2({ detector: true });
    h.camera.set({ facing: 'user' });
    await h.controller.find('mug');
    expect(h.socket.types()).not.toContain('find');
    expect(h.controller.getState().find).toMatchObject({ state: 'error', lastPrompt: { kind: 'error', text: REAR_CAMERA_PROMPT } });
    expect(h.speech.spoken()).toEqual([REAR_CAMERA_PROMPT]);
    h.controller.stopFind();
    expect(h.controller.getState().find).toBeNull();
  });

  it('switching to the front camera or a camera failure stops the find', async () => {
    const h = await finding();
    h.camera.set({ facing: 'user' });
    expect(h.socket.sent.at(-1)).toEqual({ type: 'find.stop' });
    expect(h.controller.getState().find?.lastPrompt?.text).toBe(REAR_CAMERA_PROMPT);
    h.camera.set({ facing: 'environment' });
    await h.controller.find('mug');
    h.spatial.stopTracking.mockClear();
    h.camera.set({ status: 'disconnected' });
    expect(h.spatial.stopTracking).toHaveBeenCalled();
    expect(h.socket.sent.at(-1)).toEqual({ type: 'find.stop' });
    expect(h.controller.getState().announcement?.text).toBe(CAMERA_STOPPED_FIND_TEXT);
  });

  it('stopFind silences cues and guidance speech before sending find.stop', async () => {
    const h = await finding();
    h.socket.receive(seen(h.requestId, 0.2, 0.5, prompt('tracking', 'Mug found.')));
    expect(h.speech.speaking).toBe(true);
    h.spatial.stopTracking.mockClear();
    h.controller.stopFind();
    const stopAt = h.spatial.stopTracking.mock.invocationCallOrder[0]!;
    const cancelAt = h.speech.cancel.mock.invocationCallOrder[0]!;
    const sendAt = h.socket.send.mock.invocationCallOrder.at(-1)!;
    expect(h.socket.sent.at(-1)).toEqual({ type: 'find.stop' });
    expect(stopAt).toBeLessThan(sendAt);
    expect(cancelAt).toBeLessThan(sendAt);
    expect(h.controller.getState().find).toBeNull();
  });

  it('does not cancel speech that is not guidance', async () => {
    const h = await finding();
    h.speech.speak('An answer.'); // e.g. a snapshot answer
    h.controller.stopFind();
    expect(h.speech.cancel).not.toHaveBeenCalled();
  });

  const lifecycle: [string, (h: Awaited<ReturnType<typeof finding>>) => void | Promise<void>][] = [
    ['end()', (h) => h.controller.end()],
    ['visibility hidden', () => setVisibility('hidden')],
    ['socket disconnect', (h) => h.socket.serverClose()],
    ['mode change', (h) => h.controller.setMode('snapshot')],
    ['new find', async (h) => void (await h.controller.find('bottle'))],
    ['assistant-started replacement', (h) => h.socket.receive(findMsg({ requestId: 'tool-find-9', query: 'bowl' }))],
  ];
  for (const [name, act] of lifecycle) {
    it(`stops cues and guidance speech on ${name}`, async () => {
      const h = await finding();
      h.socket.receive(seen(h.requestId, 0.2, 0.5, prompt('tracking', 'Mug found.')));
      h.socket.receive(seen(h.requestId, 0.5, 0.2, prompt('tilt_up', 'Tilt the phone up slightly.'))); // queued
      h.spatial.stopTracking.mockClear();
      await act(h);
      expect(h.spatial.stopTracking).toHaveBeenCalled();
      expect(h.speech.cancel).toHaveBeenCalled();
      h.speech.finish();
      vi.advanceTimersByTime(10_000);
      expect(h.speech.spoken()).not.toContain('Tilt the phone up slightly.');
      // Late updates of the old find are ignored.
      h.socket.receive(seen(h.requestId, 0.2, 0.5, prompt('tracking', 'Old.')));
      expect(h.speech.spoken()).not.toContain('Old.');
    });
  }

  it('repeated find start/stop cycles keep no timers behind', async () => {
    const h = await finding();
    h.controller.stopFind();
    const base = vi.getTimerCount();
    for (let i = 0; i < 10; i++) {
      await h.controller.find('mug');
      const sent = h.socket.sent.at(-1)!;
      const id = sent.type === 'find' ? sent.requestId : '';
      h.socket.receive(seen(id, 0.2, 0.5, prompt('tracking', `Mug ${i}.`)));
      h.controller.stopFind();
    }
    expect(vi.getTimerCount()).toBeLessThanOrEqual(base);
  });
});

describe('find v3: microphone policy', () => {
  it("'keep': blanks mic chunks during cue windows and guidance speech, keeps the stream continuous", async () => {
    const h = await finding();
    const zero = encodePcm16Base64(new Float32Array(1024));
    h.setPerf(1_000);
    h.spatial.audibleUntil = 1_050; // a pulse is audible until 1050 (perf clock)
    h.mic.emit(loud);
    expect(h.socket.sent.at(-1)).toMatchObject({ type: 'audio', data: zero });
    h.setPerf(1_200); // outside the window
    h.mic.emit(loud);
    expect(h.socket.sent.at(-1)).toMatchObject({ type: 'audio', data: loud });
    // User speech outside cue windows silences the beacon for a moment.
    expect(h.spatial.setSuppressed).toHaveBeenLastCalledWith(true);
    vi.advanceTimersByTime(USER_SPEECH_SUPPRESS_MS + 10);
    expect(h.spatial.setSuppressed).toHaveBeenLastCalledWith(false);
    // Guidance TTS speaking -> blanked.
    h.socket.receive(seen(h.requestId, 0.2, 0.5, prompt('tracking', 'Mug found.')));
    h.mic.emit(loud);
    expect(h.socket.sent.at(-1)).toMatchObject({ type: 'audio', data: zero });
    h.speech.finish();
    h.mic.emit(loud); // within the TTS tail
    expect(h.socket.sent.at(-1)).toMatchObject({ type: 'audio', data: zero });
    h.setPerf(1_200 + GUIDANCE_TTS_TAIL_MS + 1);
    h.mic.emit(loud);
    expect(h.socket.sent.at(-1)).toMatchObject({ type: 'audio', data: loud });
    // Not in find mode: never blanked.
    h.controller.stopFind();
    h.spatial.audibleUntil = 1e12;
    h.mic.emit(loud);
    expect(h.socket.sent.at(-1)).toMatchObject({ type: 'audio', data: loud });
  });

  it("'release': mic released during find, Talk reopens it while held, restored when find ends", async () => {
    const h = await startedV2({ detector: true, initialSettings: { findMicPolicy: 'release' } });
    expect(h.mic.getState().status).toBe('active');
    await h.controller.find('mug');
    expect(h.mic.stop).toHaveBeenCalledTimes(1);
    expect(h.controller.getState().mic.status).toBe('stopped');
    h.mic.emit(loud);
    expect(h.socket.types()).not.toContain('audio');
    h.mic.start.mockClear();
    h.controller.setTalking(true);
    expect(h.mic.start).toHaveBeenCalledTimes(1); // synchronously, inside the tap
    expect(h.spatial.setSuppressed).toHaveBeenLastCalledWith(true);
    await vi.advanceTimersByTimeAsync(0);
    h.mic.emit(loud);
    expect(h.socket.sent.at(-1)).toMatchObject({ type: 'audio', data: loud }); // not blanked: user speech
    h.controller.setTalking(false);
    expect(h.mic.stop).toHaveBeenCalledTimes(2);
    expect(h.socket.sent.at(-1)).toEqual({ type: 'audio.end' });
    h.mic.start.mockClear();
    h.controller.stopFind();
    expect(h.mic.start).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(0);
    expect(h.controller.getState().mic.status).toBe('active');
    h.mic.emit(loud);
    expect(h.socket.sent.at(-1)).toMatchObject({ type: 'audio' });
  });

  it("'release' + hidden: the normal mic is restored on resume()", async () => {
    const h = await startedV2({ detector: true, initialSettings: { findMicPolicy: 'release' } });
    await h.controller.find('mug');
    h.mic.start.mockClear();
    setVisibility('hidden');
    expect(h.mic.start).not.toHaveBeenCalled();
    setVisibility('visible');
    await h.controller.resume();
    expect(h.mic.start).toHaveBeenCalledTimes(1);
  });
});

describe('stereo calibration', () => {
  it('left, right, both: word then tone (word centred, tone panned), then confirm; beacon suppressed', async () => {
    const h = await startedV2();
    calls.length = 0;
    const p = h.controller.startCalibration();
    expect(calls.slice(0, 2)).toEqual(['player.unlock', 'spatial.unlock']);
    expect(h.controller.getState().calibration).toEqual({ step: 'left', heardSeparation: null, micActive: true });
    expect(h.spatial.setSuppressed).toHaveBeenLastCalledWith(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(h.speech.spoken()).toEqual(['Left ear.']);
    h.speech.finish();
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toContain('tone.left');
    expect(h.controller.getState().calibration.step).toBe('right');
    h.speech.finish();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.controller.getState().calibration.step).toBe('centre');
    h.speech.finish();
    await p;
    expect(calls.filter((c) => c.startsWith('tone.'))).toEqual(['tone.left', 'tone.right', 'tone.centre']);
    expect(h.speech.spoken()).toEqual(['Left ear.', 'Right ear.', 'Both ears.']);
    expect(h.controller.getState().calibration.step).toBe('confirm');
    h.controller.answerCalibration(true);
    expect(h.controller.getState().calibration).toMatchObject({ step: 'done', heardSeparation: true });
    expect(h.controller.getState().settings.guidanceMode).toBe('stereo');
    expect(h.spatial.setSuppressed).toHaveBeenLastCalledWith(false);
  });

  it('no separation heard -> spoken directions + polite announcement', async () => {
    const h = await startedV2();
    h.mic.stop();
    const p = h.controller.startCalibration();
    expect(h.controller.getState().calibration.micActive).toBe(false);
    for (let i = 0; i < 3; i++) {
      await vi.advanceTimersByTimeAsync(0);
      h.speech.finish();
    }
    await p;
    h.controller.answerCalibration(false);
    const st = h.controller.getState();
    expect(st.calibration).toMatchObject({ step: 'done', heardSeparation: false });
    expect(st.settings.guidanceMode).toBe('spoken');
    expect(h.spatial.configure).toHaveBeenLastCalledWith(expect.objectContaining({ beacon: false }));
    expect(st.announcement).toMatchObject({ text: CALIBRATION_FALLBACK_TEXT, politeness: 'polite' });
  });

  it('cancelCalibration stops the tone and words immediately', async () => {
    const h = await startedV2();
    calls.length = 0;
    void h.controller.startCalibration();
    await vi.advanceTimersByTimeAsync(0);
    h.controller.cancelCalibration();
    expect(h.speech.cancel).toHaveBeenCalled();
    expect(h.spatial.cancelCalibrationTone).toHaveBeenCalled();
    expect(h.controller.getState().calibration.step).toBe('idle');
    await vi.advanceTimersByTimeAsync(5_000);
    expect(calls.filter((c) => c.startsWith('tone.'))).toEqual([]);
    expect(h.spatial.setSuppressed).toHaveBeenLastCalledWith(false);
  });
});

describe('detection metrics', () => {
  it('detectionAgeMs = arrival - capture; detectionRate = distinct results per second over 5 s', async () => {
    const h = await finding();
    const det = (frameId: number, capturedAt: number): ServerDetections => ({
      type: 'detections',
      frameId,
      capturedAt,
      sourceWidth: 640,
      sourceHeight: 480,
      detectedAt: Date.now(),
      model: 'd',
      detections: [],
      source: 'yolo',
    });
    h.socket.receive(det(10, Date.now() - 80));
    expect(h.controller.getState().metrics.detectionAgeMs).toBe(80);
    for (let i = 11; i < 36; i++) {
      vi.advanceTimersByTime(200);
      h.socket.receive(det(i, Date.now() - 50));
      h.socket.receive(seen(h.requestId, 0.3, 0.5, { frameId: i, observedAt: Date.now() - 60 })); // same frame: not double-counted
    }
    const m = h.controller.getState().metrics;
    expect(m.detectionAgeMs).toBe(60);
    expect(m.detectionRate).toBeCloseTo(5, 0);
  });
});

// ---------------------------------------------------------------------------
// v4: instruction companion (FIXTURE guide snapshots; the server owns progress)
// ---------------------------------------------------------------------------

const guideMsg = (guide: GuideSnapshot, requestId: string | null = null, result: ServerMessageOf<'guide'>['result'] = null): ServerMessageOf<'guide'> => ({
  type: 'guide',
  guide,
  requestId,
  result,
});
const RESUME_KEY = 'resume_key_ABCDEFGHIJ-0123';
const sentOf = <T extends ClientMessage['type']>(h: { socket: ReturnType<typeof fakeSocket> }, type: T) =>
  h.socket.sent.filter((m): m is Extract<ClientMessage, { type: T }> => m.type === type);

describe('guide: snapshots', () => {
  it('starts idle and applies only newer snapshots (version, revision, guideId)', async () => {
    const h = await started();
    expect(h.controller.getState().guide).toEqual(IDLE_GUIDE);
    expect(h.controller.getState().guideLost).toBe(false);
    const v5 = makeGuide({ version: 5 });
    h.socket.receive(guideMsg(v5));
    expect(h.controller.getState().guide).toBe(v5);
    h.socket.receive(guideMsg(makeGuide({ version: 4, currentIndex: 0 }))); // older: ignored
    h.socket.receive(guideMsg(makeGuide({ version: 5, currentIndex: 3 }))); // same version: ignored
    expect(h.controller.getState().guide).toBe(v5);
    const v6 = makeGuide({ version: 6, currentIndex: 2 });
    h.socket.receive(guideMsg(v6));
    expect(h.controller.getState().guide).toBe(v6);
    h.socket.receive(guideMsg(makeGuide({ version: 9, revision: 0 }))); // older revision of the same guide
    expect(h.controller.getState().guide).toBe(v6);
    const rescanned = makeGuide({ version: 2, revision: 2 }); // rescan: newer revision wins
    h.socket.receive(guideMsg(rescanned));
    expect(h.controller.getState().guide).toBe(rescanned);
    const other = makeGuide({ version: 1, guideId: 'g-other', revision: 0 }); // a different guide
    h.socket.receive(guideMsg(other));
    expect(h.controller.getState().guide).toBe(other);
  });

  it('a rejected request shows a short polite reason; stale snapshots never replace newer state', async () => {
    const h = await started();
    h.socket.receive(guideMsg(makeGuide({ version: 7 })));
    h.controller.guideAction('next');
    const req = sentOf(h, 'guide.action').at(-1)!.requestId;
    h.socket.receive(guideMsg(makeGuide({ version: 6, currentIndex: 3 }), req, { ok: false, code: 'stale_revision' }));
    const st = h.controller.getState();
    expect(st.guide.version).toBe(7);
    expect(st.guide.currentIndex).toBe(1);
    expect(st.guide.message).toBe('Ignored: that was for an older view of the instructions.');
    expect(st.announcement).toMatchObject({ text: 'Ignored: that was for an older view of the instructions.', politeness: 'polite' });
    // duplicate: silent
    const before = h.controller.getState().announcement;
    h.socket.receive(guideMsg(makeGuide({ version: 7 }), 'guide-next-99', { ok: false, code: 'duplicate' }));
    expect(h.controller.getState().announcement).toBe(before);
  });
});

describe('guide: Check this view', () => {
  it('captures a FRESH detail still each time with a new requestId; busy until the answer', async () => {
    const h = await startedV2();
    await h.controller.guideInspect('storage instructions');
    expect(h.camera.captureStill).toHaveBeenCalledTimes(1);
    expect(h.camera.captureStill).toHaveBeenLastCalledWith({ maxDim: LIMITS.detailMaxDim, jpegQuality: LIMITS.detailJpegQuality, bestOf: LIMITS.detailBestOf });
    expect(h.spatial.earcons()).toContain('capture');
    const first = sentOf(h, 'guide.inspect').at(-1)!;
    expect(first).toMatchObject({ type: 'guide.inspect', goal: 'storage instructions' });
    expect(h.controller.getState().busy?.kind).toBe('checking_view');
    // A second tap while checking does not send another capture.
    await h.controller.guideInspect();
    expect(sentOf(h, 'guide.inspect')).toHaveLength(1);
    // An intermediate acquiring snapshot keeps busy; the settled answer clears it.
    h.socket.receive(guideMsg({ ...IDLE_GUIDE, phase: 'acquiring_image', goal: 'storage instructions', version: 1 }, first.requestId, { ok: true, code: null }));
    expect(h.controller.getState().busy?.kind).toBe('checking_view');
    h.socket.receive(
      guideMsg(
        { ...IDLE_GUIDE, phase: 'needs_better_view', goal: 'storage instructions', adjustment: 'Move the phone slightly back.', version: 2 },
        first.requestId,
        { ok: true, code: null },
      ),
    );
    expect(h.controller.getState().busy).toBeNull();
    // "How about now?" with no goal: a new still and a new requestId, goal omitted (server keeps it).
    await h.controller.guideInspect();
    expect(h.camera.captureStill).toHaveBeenCalledTimes(2);
    const second = sentOf(h, 'guide.inspect').at(-1)!;
    expect(second.requestId).not.toBe(first.requestId);
    expect(second).not.toHaveProperty('goal');
    expect(second.frame.frameId).not.toBe(first.frame.frameId);
  });

  it('falls back to capture() and times out after ~35 s', async () => {
    const h = await startedV2();
    h.camera.setStill(() => Promise.resolve(null));
    await h.controller.guideInspect();
    expect(h.camera.capture).toHaveBeenLastCalledWith({ maxDim: LIMITS.snapshotMaxDim, jpegQuality: LIMITS.snapshotJpegQuality });
    expect(h.controller.getState().busy?.kind).toBe('checking_view');
    vi.advanceTimersByTime(GUIDE_INSPECT_TIMEOUT_MS - 1);
    expect(h.controller.getState().busy?.kind).toBe('checking_view');
    vi.advanceTimersByTime(1);
    expect(h.controller.getState().busy).toBeNull();
    // A new check is possible again.
    await h.controller.guideInspect();
    expect(sentOf(h, 'guide.inspect')).toHaveLength(2);
  });

  it('a server error for the request clears busy', async () => {
    const h = await started();
    await h.controller.guideInspect();
    const req = sentOf(h, 'guide.inspect').at(-1)!.requestId;
    h.socket.receive({ type: 'error', code: 'provider_error', message: 'Could not read the photo.', recoverable: true, requestId: req });
    expect(h.controller.getState().busy).toBeNull();
  });

  it("snapshot.request purpose 'guide' uses the fresh detail still", async () => {
    const h = await startedV2();
    h.socket.receive({ type: 'snapshot.request', requestId: 'snap-g', purpose: 'guide', maxDim: 4096 });
    await vi.advanceTimersByTimeAsync(0);
    expect(h.camera.captureStill).toHaveBeenCalledTimes(1);
    expect(h.socket.sent.at(-1)).toMatchObject({ type: 'snapshot.result', requestId: 'snap-g' });
  });

  it('voice inspect tools show checking_view until they complete', async () => {
    const h = await started();
    h.socket.receive({ type: 'tool', callId: 'c1', name: 'inspect_current_view', state: 'started' });
    expect(h.controller.getState().busy?.kind).toBe('checking_view');
    h.socket.receive({ type: 'tool', callId: 'c1', name: 'inspect_current_view', state: 'completed' });
    expect(h.controller.getState().busy).toBeNull();
    h.socket.receive({ type: 'tool', callId: 'c2', name: 'navigate_step', state: 'started' });
    expect(h.controller.getState().busy).toBeNull();
  });

  it('refuses while not connected', async () => {
    const h = await started();
    h.socket.serverClose();
    await h.controller.guideInspect();
    expect(h.camera.captureStill).not.toHaveBeenCalled();
    expect(h.controller.getState().announcement?.text).toMatch(/^Not connected/);
  });
});

describe('guide: actions', () => {
  it('bind every action to the current guideId, revision and step; fresh requestId each time', async () => {
    const h = await started();
    h.socket.receive(guideMsg(makeGuide({ guideId: 'g1', revision: 3, version: 10, currentIndex: 1 })));
    h.controller.guideAction('confirm');
    h.controller.guideAction('next');
    h.controller.guideAction('previous');
    h.controller.guideAction('undo');
    h.controller.guideAction('repeat');
    h.controller.guideAction('explain');
    h.controller.guideAction('status');
    const sent = sentOf(h, 'guide.action');
    expect(sent.map((m) => m.action)).toEqual(['confirm', 'next', 'previous', 'undo', 'repeat', 'explain', 'status']);
    for (const m of sent) expect(m).toMatchObject({ guideId: 'g1', revision: 3 });
    expect(sent[0]).toMatchObject({ stepId: 'microwave-s2' });
    expect(sent[1]).toMatchObject({ stepId: 'microwave-s2' });
    expect(sent[2]).toMatchObject({ stepId: 'microwave-s2' });
    expect(sent[3]).not.toHaveProperty('stepId');
    expect(new Set(sent.map((m) => m.requestId)).size).toBe(sent.length);
    // The step follows the newest snapshot.
    h.socket.receive(guideMsg(makeGuide({ guideId: 'g1', revision: 3, version: 11, currentIndex: 2 })));
    h.controller.guideAction('confirm');
    expect(sentOf(h, 'guide.action').at(-1)).toMatchObject({ action: 'confirm', stepId: 'microwave-s3', revision: 3 });
  });

  it('choose_section carries the section id; confirm without a current step sends nothing', async () => {
    const h = await started();
    h.socket.receive(
      guideMsg({
        ...IDLE_GUIDE,
        phase: 'choosing_section',
        guideId: 'g2',
        revision: 1,
        version: 3,
        sectionChoices: [
          { id: 'microwave', title: 'Microwave', stepCount: 4, complete: true },
          { id: 'oven', title: 'Oven', stepCount: 6, complete: false },
        ],
      }),
    );
    h.controller.guideAction('confirm');
    expect(sentOf(h, 'guide.action')).toHaveLength(0);
    h.controller.guideAction('choose_section', { sectionId: 'oven' });
    expect(sentOf(h, 'guide.action').at(-1)).toMatchObject({ action: 'choose_section', sectionId: 'oven', guideId: 'g2', revision: 1 });
  });

  it('never sends or queues actions while disconnected', async () => {
    const h = await started();
    h.socket.receive(guideMsg(makeGuide()));
    const first = h.socket;
    first.serverClose();
    h.controller.guideAction('confirm');
    h.controller.guideAction('next');
    expect(first.sent.filter((m) => m.type === 'guide.action')).toHaveLength(0);
    expect(h.controller.getState().announcement).toMatchObject({ politeness: 'assertive' });
    expect(h.controller.getState().announcement?.text).toMatch(/^Not connected/);
    vi.advanceTimersByTime(100);
    h.socket.open();
    h.socket.receive({ ...readyMsg(), guideRestored: true });
    expect(h.socket.types()).toEqual(['hello']); // nothing replayed
  });

  it('pause and stop silence assistant speech locally before sending', async () => {
    const h = await started();
    h.socket.receive(guideMsg(makeGuide()));
    h.socket.receive({ type: 'turn', turnId: 1, event: 'start', at: 0 });
    h.socket.receive({ type: 'audio', turnId: 1, seq: 0, data: 'AAAA' });
    expect(h.player.getState().playing).toBe(true);
    h.controller.guideAction('pause');
    expect(h.player.getState().playing).toBe(false);
    expect(h.speech.cancel).toHaveBeenCalled();
    const flushOrder = h.player.flush.mock.invocationCallOrder.at(-1)!;
    const sendCalls = h.socket.send.mock.calls.map((c, i) => ({ m: c[0], order: h.socket.send.mock.invocationCallOrder[i]! }));
    const pauseSend = sendCalls.find((c) => c.m.type === 'guide.action')!;
    expect(pauseSend.m).toMatchObject({ action: 'pause' });
    expect(flushOrder).toBeLessThan(pauseSend.order);
    // Late audio of the stopped turn is rejected.
    h.socket.receive({ type: 'audio', turnId: 1, seq: 1, data: 'LATE' });
    expect(h.player.enqueued).toHaveLength(1);
    const cancels = h.speech.cancel.mock.calls.length;
    h.controller.guideAction('stop');
    expect(h.speech.cancel.mock.calls.length).toBeGreaterThan(cancels);
    expect(sentOf(h, 'guide.action').at(-1)).toMatchObject({ action: 'stop' });
  });
});

describe('guide: resume key', () => {
  it('kept in memory only, sent in hello on reconnect; a guide that is not restored is reported lost', async () => {
    const setItem = vi.spyOn(Storage.prototype, 'setItem');
    const h = setup();
    const p = h.controller.start();
    h.socket.open();
    expect(h.socket.sent[0]).not.toHaveProperty('resumeKey'); // fresh page: nothing to restore
    h.socket.receive({ ...readyMsg(), resumeKey: RESUME_KEY });
    await p;
    h.socket.receive(guideMsg(makeGuide()));
    h.socket.serverClose();
    vi.advanceTimersByTime(100);
    h.socket.open();
    expect(h.socket.sent[0]).toMatchObject({ type: 'hello', resume: true, resumeKey: RESUME_KEY });
    h.socket.receive({ ...readyMsg(), resumeKey: RESUME_KEY });
    const st = h.controller.getState();
    expect(st.guideLost).toBe(true);
    expect(st.guide.phase).toBe('idle');
    expect(st.announcement).toMatchObject({ text: GUIDE_LOST_TEXT, politeness: 'assertive' });
    expect(setItem).not.toHaveBeenCalled();
    // Starting again clears the lost banner.
    await h.controller.guideInspect('cooking instructions');
    expect(h.controller.getState().guideLost).toBe(false);
  });

  it('a restored guide stays; the server snapshot then continues it', async () => {
    const h = setup();
    const p = h.controller.start();
    h.socket.open();
    h.socket.receive({ ...readyMsg(), resumeKey: RESUME_KEY });
    await p;
    const g = makeGuide({ version: 5 });
    h.socket.receive(guideMsg(g));
    h.socket.serverClose();
    vi.advanceTimersByTime(100);
    h.socket.open();
    h.socket.receive({ ...readyMsg(), resumeKey: RESUME_KEY, guideRestored: true });
    expect(h.controller.getState()).toMatchObject({ guideLost: false, guide: g });
    h.socket.receive(guideMsg(makeGuide({ version: 6, currentIndex: 2 })));
    expect(h.controller.getState().guide.currentIndex).toBe(2);
  });

  it('no active guide: nothing is reported lost; End forgets the key', async () => {
    const h = setup();
    const p = h.controller.start();
    h.socket.open();
    h.socket.receive({ ...readyMsg(), resumeKey: RESUME_KEY });
    await p;
    h.socket.serverClose();
    vi.advanceTimersByTime(100);
    h.socket.open();
    h.socket.receive(readyMsg());
    expect(h.controller.getState().guideLost).toBe(false);
    h.controller.end();
    const p2 = h.controller.start();
    h.socket.open();
    expect(h.socket.sent[0]).not.toHaveProperty('resumeKey');
    h.socket.receive(readyMsg());
    await p2;
  });
});

describe('guide: speech', () => {
  it('snapshot mode speaks a step change once with local TTS', async () => {
    const h = await started('snapshot');
    h.socket.receive(guideMsg(makeGuide({ version: 1, currentIndex: 0 })));
    expect(h.speech.spoken()).toEqual(['Step 1 of 4: Pierce the film lid several times.']);
    h.speech.finish();
    // Same step, newer version (e.g. presented flag): not spoken again.
    h.socket.receive(guideMsg(makeGuide({ version: 2, currentIndex: 0 })));
    expect(h.speech.spoken()).toHaveLength(1);
    h.controller.guideAction('next');
    const req = sentOf(h, 'guide.action').at(-1)!.requestId;
    h.socket.receive(guideMsg(makeGuide({ version: 3, currentIndex: 1 }), req, { ok: true, code: null }));
    expect(h.speech.spoken().at(-1)).toBe('Step 2 of 4: Heat on full power, 800W, for 3 minutes. Warning: Caution: contents will be hot.');
    h.speech.finish();
    // Repeat re-speaks the same step (the user asked).
    h.controller.guideAction('repeat');
    const rep = sentOf(h, 'guide.action').at(-1)!.requestId;
    h.socket.receive(guideMsg(makeGuide({ version: 4, currentIndex: 1 }), rep, { ok: true, code: null }));
    expect(h.speech.spoken()).toHaveLength(3);
    h.speech.finish();
    // A confirmation without a server message is said briefly.
    h.controller.guideAction('confirm');
    const conf = sentOf(h, 'guide.action').at(-1)!.requestId;
    const after = makeGuide({ version: 5, currentIndex: 1, confirmations: ['microwave-s1', 'microwave-s2'] });
    h.socket.receive(guideMsg(after, conf, { ok: true, code: null }));
    expect(h.speech.spoken().at(-1)).toBe('Step 2 confirmed done.');
  });

  it('snapshot mode speaks the adjustment and the section question', async () => {
    const h = await started('snapshot');
    h.socket.receive(guideMsg({ ...IDLE_GUIDE, phase: 'needs_better_view', adjustment: 'Move the phone slightly back.', version: 1 }));
    expect(h.speech.spoken().at(-1)).toBe('Move the phone slightly back.');
    h.speech.finish();
    h.socket.receive(
      guideMsg({
        ...IDLE_GUIDE,
        phase: 'choosing_section',
        guideId: 'g',
        version: 2,
        sectionChoices: [
          { id: 'm', title: 'Microwave', stepCount: 4, complete: true },
          { id: 'o', title: 'Oven', stepCount: 6, complete: true },
        ],
      }),
    );
    expect(h.speech.spoken().at(-1)).toBe('I can see 2 different methods: Microwave, 4 steps; Oven, 6 steps. Which one?');
  });

  it('snapshot mode waits for other assistant audio, never two engines at once', async () => {
    const h = await started('snapshot');
    h.player.setState({ playing: true, turnId: 1 });
    h.socket.receive(guideMsg(makeGuide({ version: 1, currentIndex: 0 })));
    expect(h.speech.speak).not.toHaveBeenCalled();
    h.player.setState({ playing: false, turnId: null });
    expect(h.speech.spoken()).toEqual(['Step 1 of 4: Pierce the film lid several times.']);
  });

  it('Live mode: the model speaks; the client never uses TTS and only announces short status', async () => {
    const h = await started('live');
    h.socket.receive(guideMsg(makeGuide({ version: 1, currentIndex: 0, confirmations: [] })));
    h.socket.receive(guideMsg(makeGuide({ version: 2, currentIndex: 1 })));
    expect(h.speech.speak).not.toHaveBeenCalled();
    expect(h.controller.getState().announcement?.text).toBe('Step 1 confirmed done.');
    // While the assistant is speaking, polite guide announcements are suppressed.
    h.socket.receive({ type: 'turn', turnId: 1, event: 'start', at: 0 });
    h.socket.receive({ type: 'audio', turnId: 1, seq: 0, data: 'AAAA' });
    const before = h.controller.getState().announcement;
    h.socket.receive(guideMsg(makeGuide({ version: 3, phase: 'paused' })));
    expect(h.controller.getState().announcement).toBe(before);
    expect(h.speech.speak).not.toHaveBeenCalled();
  });
});
