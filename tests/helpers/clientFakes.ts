/**
 * FIXTURE fakes for AssistantController tests (camera, sampler, mic, player, speech, socket).
 * Mirrors the helpers in src/client/session/AssistantController.test.ts (which are not exported) so the
 * verification tests do not edit worker-owned test files. Nothing here touches real media or a server.
 */
import { vi } from 'vitest';
import type {
  AudioPlayer,
  CameraController,
  CameraState,
  CaptureOptions,
  CapturedFrame,
  FrameSampler,
  MicCapture,
  MicState,
  PlayerState,
  SpeechOutput,
} from '../../src/client/contracts.js';
import type { ClientMessage, ServerMessage, ServerMessageOf } from '../../src/shared/protocol.js';
import { encodePcm16Base64 } from '../../src/client/audio/pcm.js';
import { createAssistantController, type AssistantDeps } from '../../src/client/session/AssistantController.js';
import type { SessionSocketLike } from '../../src/client/session/SessionSocket.js';

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

export function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

let nextFrameId = 1;
export const resetFrameIds = () => (nextFrameId = 1);
export const frame = (over: Partial<CapturedFrame> = {}): CapturedFrame => ({
  frameId: nextFrameId++,
  capturedAt: Date.now(),
  width: 640,
  height: 480,
  mimeType: 'image/jpeg',
  data: 'AAAA',
  ...over,
});

export function fakeCamera() {
  const s = store<CameraState>({ status: 'idle', facing: 'environment', deviceLabel: '', videoWidth: 0, videoHeight: 0, canSwitch: false, message: null, torch: { supported: false, on: false }, stillCapture: false });
  let captureImpl: (o: CaptureOptions) => Promise<CapturedFrame | null> = () => Promise.resolve(frame());
  const cam = {
    ...s,
    attachVideo: vi.fn(),
    start: vi.fn(async () => {
      s.set({ status: 'active' });
    }),
    stop: vi.fn(() => s.set({ status: 'stopped' })),
    switchCamera: vi.fn(async () => undefined),
    pause: vi.fn(() => s.set({ status: 'paused' })),
    resume: vi.fn(async () => s.set({ status: 'active' })),
    capture: vi.fn((o: CaptureOptions) => captureImpl(o)),
    // FIXTURE: no still-photo path; the controller must fall back to capture().
    captureStill: vi.fn(async (_o: CaptureOptions & { bestOf?: number }): Promise<CapturedFrame | null> => null),
    setTorch: vi.fn(async (_on: boolean) => false),
    setCapture: (fn: typeof captureImpl) => (captureImpl = fn),
  };
  return cam satisfies CameraController;
}

export function fakeSampler() {
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

export function fakeMic() {
  const s = store<MicState>({ status: 'idle', level: 0, echoCancellation: null, message: null });
  const chunkLs = new Set<(b: string) => void>();
  const mic = {
    ...s,
    gate: true,
    start: vi.fn(async () => {
      s.set({ status: 'active', echoCancellation: true });
    }),
    stop: vi.fn(() => s.set({ status: 'stopped' })),
    setMuted: vi.fn((m: boolean) => {
      if (s.getState().status === 'active' || s.getState().status === 'muted') s.set({ status: m ? 'muted' : 'active' });
    }),
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

export function fakePlayer() {
  const s = store<PlayerState>({ playing: false, turnId: null, contextState: 'uninitialized' });
  const audibleLs = new Set<(t: number, at: number) => void>();
  const player = {
    ...s,
    enqueued: [] as [number, string][],
    unlock: vi.fn(() => {
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
    // FIXTURE: no real AudioContext in Node tests.
    context: null as AudioContext | null,
    setState: s.set,
  };
  return player satisfies AudioPlayer;
}

export function fakeSpeech() {
  return { supported: true, speaking: false, speak: vi.fn(), cancel: vi.fn() } satisfies SpeechOutput;
}

export function fakeSocket() {
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

export const readyMsg = (mode: 'live' | 'snapshot' = 'live'): ServerMessageOf<'ready'> => ({
  type: 'ready',
  sessionId: 's1',
  mode,
  models: { live: mode === 'live' ? 'gemini-3.8-live' : null, vision: 'v' },
  features: { live: mode === 'live', snapshot: true, detections: false },
  serverTime: Date.now(),
  maxSessionMs: 1_200_000,
});

export const loud = encodePcm16Base64(new Float32Array(1024).fill(0.3));

export function setup(over: Partial<AssistantDeps> = {}) {
  const camera = fakeCamera();
  const sampler = fakeSampler();
  const mic = fakeMic();
  const player = fakePlayer();
  const speech = fakeSpeech();
  const sockets: ReturnType<typeof fakeSocket>[] = [];
  const createSocket = vi.fn(() => {
    const s = fakeSocket();
    sockets.push(s);
    return s;
  });
  const controller = createAssistantController({
    camera,
    createSampler: () => sampler,
    mic,
    player,
    speech,
    createSocket,
    document,
    perfNow: () => 0,
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
  };
}

export async function started(mode: 'live' | 'snapshot' = 'live', over: Partial<AssistantDeps> = {}) {
  const h = setup(over);
  const p = h.controller.start();
  h.socket.open();
  h.socket.receive(readyMsg(mode));
  await p;
  return h;
}
