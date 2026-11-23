import { describe, expect, it, vi } from 'vitest';
import { createMicCapture, mapMediaError, MIC_CONSTRAINTS } from './MicCapture.js';
import { base64ToBytes } from './pcm.js';

/** FIXTURE: fake media stream / AudioContext / worklet node. */
function setup(opts: { sampleRate?: number; gumError?: unknown } = {}) {
  const track = {
    enabled: true,
    stop: vi.fn(),
    getSettings: () => ({ echoCancellation: true }),
    addEventListener: vi.fn(),
  };
  const stream = { getTracks: () => [track], getAudioTracks: () => [track] } as unknown as MediaStream;
  const port = { onmessage: null as ((e: MessageEvent) => void) | null, postMessage: vi.fn() };
  const node = { port, connect: vi.fn(), disconnect: vi.fn() };
  const ctx = {
    sampleRate: opts.sampleRate ?? 48_000,
    state: 'running',
    destination: {},
    resume: vi.fn(() => Promise.resolve()),
    close: vi.fn(() => Promise.resolve()),
    audioWorklet: { addModule: vi.fn(() => Promise.resolve()) },
    createMediaStreamSource: vi.fn(() => ({ connect: vi.fn(), disconnect: vi.fn() })),
    createGain: vi.fn(() => ({ gain: { value: 1 }, connect: vi.fn(), disconnect: vi.fn() })),
  };
  const gum = vi.fn(() => (opts.gumError ? Promise.reject(opts.gumError) : Promise.resolve(stream)));
  const mic = createMicCapture({
    getUserMedia: gum,
    createAudioContext: () => ctx as unknown as AudioContext,
    createWorkletNode: () => node as unknown as AudioWorkletNode,
    workletUrl: 'fixture://worklet.js',
    isSecureContext: () => true,
    levelIntervalMs: 0,
  });
  const block = (n: number, v = 0.2) => port.onmessage?.({ data: new Float32Array(n).fill(v) } as MessageEvent);
  return { mic, gum, ctx, track, node, block };
}

describe('MicCapture', () => {
  it('requests the voice constraints and reports echo cancellation', async () => {
    const { mic, gum } = setup();
    await mic.start();
    expect(gum).toHaveBeenCalledWith(MIC_CONSTRAINTS);
    expect(MIC_CONSTRAINTS.audio).toMatchObject({ echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 });
    expect(mic.getState()).toMatchObject({ status: 'active', echoCancellation: true });
  });

  it('emits 1024-sample (2048-byte) 16 kHz chunks from 48 kHz input', async () => {
    const { mic, block } = setup();
    await mic.start();
    const chunks: string[] = [];
    mic.onChunk((c) => chunks.push(c));
    for (let i = 0; i < 10; i++) block(1920); // 10 x 40 ms = 400 ms -> ~6400 samples @16k
    expect(chunks.length).toBe(6);
    expect(base64ToBytes(chunks[0]!).length).toBe(2048);
    expect(mic.getState().level).toBeGreaterThan(0.15);
  });

  it('does not accumulate while gated or muted', async () => {
    const { mic, block, track } = setup();
    await mic.start();
    const chunks: string[] = [];
    mic.onChunk((c) => chunks.push(c));
    mic.setGate(false);
    for (let i = 0; i < 10; i++) block(1920);
    expect(chunks).toHaveLength(0);
    mic.setGate(true);
    block(1920);
    expect(chunks).toHaveLength(0); // nothing buffered from the gated period
    mic.setMuted(true);
    expect(track.enabled).toBe(false);
    expect(mic.getState()).toMatchObject({ status: 'muted', level: 0 });
    for (let i = 0; i < 10; i++) block(1920);
    expect(chunks).toHaveLength(0);
  });

  it('maps permission errors', async () => {
    const { mic } = setup({ gumError: Object.assign(new Error('x'), { name: 'NotAllowedError' }) });
    await mic.start();
    expect(mic.getState().status).toBe('denied');
    expect(mapMediaError({ name: 'NotReadableError' }).status).toBe('in_use');
    expect(mapMediaError({ name: 'NotFoundError' }).status).toBe('unavailable');
  });

  it('stop releases the track and closes the context', async () => {
    const { mic, track, ctx, node } = setup();
    await mic.start();
    mic.stop();
    expect(track.stop).toHaveBeenCalled();
    expect(ctx.close).toHaveBeenCalled();
    expect(node.port.postMessage).toHaveBeenCalledWith({ type: 'stop' });
    expect(mic.getState().status).toBe('stopped');
  });
});
