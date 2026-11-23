import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CameraController, CameraState, CameraStatus, CapturedFrame, CaptureOptions } from '../contracts.js';
import { LIMITS } from '../../shared/protocol.js';
import { createFrameSampler, effectiveIntervalMs } from './FrameSampler.js';

function fakeCamera(initial: CameraStatus = 'active') {
  let status = initial;
  let id = 0;
  const captureTimes: number[] = [];
  const capture = vi.fn(async (_o: CaptureOptions): Promise<CapturedFrame | null> => {
    captureTimes.push(Date.now());
    return { frameId: ++id, capturedAt: Date.now(), width: 4, height: 3, mimeType: 'image/jpeg', data: 'QUJD' };
  });
  const cam = {
    getState: () => ({ status }) as CameraState,
    subscribe: () => () => {},
    capture,
  } as unknown as CameraController;
  return { cam, capture, captureTimes, setStatus: (s: CameraStatus) => (status = s) };
}

const visible = { visibilityState: 'visible' as DocumentVisibilityState };

describe('FrameSampler', () => {
  beforeEach(() => {
    vi.useFakeTimers({ now: 1_700_000_000_000 });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('never samples faster than LIMITS.liveFrameMinIntervalMs even if asked for 200 ms', async () => {
    const { cam, capture, captureTimes } = fakeCamera();
    const s = createFrameSampler(cam, { intervalMs: 200, maxDim: 768, jpegQuality: 0.7 }, { document: visible });
    s.start(() => {});
    await vi.advanceTimersByTimeAsync(5_000);
    expect(capture).toHaveBeenCalledTimes(6); // t = 0, 1000, ..., 5000
    for (let i = 1; i < captureTimes.length; i++) {
      expect(captureTimes[i]! - captureTimes[i - 1]!).toBeGreaterThanOrEqual(LIMITS.liveFrameMinIntervalMs);
    }
    expect(capture.mock.calls[0]![0]).toEqual({ maxDim: 768, jpegQuality: 0.7 });
    s.stop();
  });

  it('does not sample faster than the interval across stop()/start()', async () => {
    const { cam, capture } = fakeCamera();
    const s = createFrameSampler(cam, { intervalMs: 1000, maxDim: 768, jpegQuality: 0.7 }, { document: visible });
    s.start(() => {});
    await vi.advanceTimersByTimeAsync(10);
    s.stop();
    s.start(() => {});
    await vi.advanceTimersByTimeAsync(500);
    expect(capture).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(500);
    expect(capture).toHaveBeenCalledTimes(2);
    s.stop();
  });

  it('delivers frames to onFrame and keeps only the latest', async () => {
    const { cam } = fakeCamera();
    const got: number[] = [];
    const s = createFrameSampler(cam, { intervalMs: 1000, maxDim: 768, jpegQuality: 0.7 }, { document: visible });
    s.start((f) => got.push(f.frameId));
    await vi.advanceTimersByTimeAsync(2_000);
    expect(got).toEqual([1, 2, 3]);
    expect(s.latest()?.frameId).toBe(3);
    s.stop();
    expect(s.latest()).toBeNull();
  });

  it('skips ticks while a capture is still in flight and counts them as dropped', async () => {
    const { cam, capture } = fakeCamera();
    let finish!: (f: CapturedFrame | null) => void;
    capture.mockImplementationOnce(() => new Promise((r) => (finish = r)));
    const onFrame = vi.fn();
    const s = createFrameSampler(cam, { intervalMs: 1000, maxDim: 768, jpegQuality: 0.7 }, { document: visible });
    s.start(onFrame);
    await vi.advanceTimersByTimeAsync(3_000); // ticks at 1000, 2000, 3000 find the first capture pending
    expect(capture).toHaveBeenCalledTimes(1);
    expect(s.droppedCount).toBe(3);
    finish({ frameId: 1, capturedAt: Date.now(), width: 4, height: 3, mimeType: 'image/jpeg', data: 'QUJD' });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(capture).toHaveBeenCalledTimes(2);
    expect(onFrame).toHaveBeenCalledTimes(2);
    s.stop();
  });

  it('does nothing while the page is hidden', async () => {
    const { cam, capture } = fakeCamera();
    const doc = { visibilityState: 'hidden' as DocumentVisibilityState };
    const s = createFrameSampler(cam, { intervalMs: 1000, maxDim: 768, jpegQuality: 0.7 }, { document: doc });
    s.start(() => {});
    await vi.advanceTimersByTimeAsync(5_000);
    expect(capture).not.toHaveBeenCalled();
    doc.visibilityState = 'visible';
    await vi.advanceTimersByTimeAsync(1_000);
    expect(capture).toHaveBeenCalledTimes(1);
    s.stop();
  });

  it('does nothing unless the camera is active', async () => {
    const { cam, capture, setStatus } = fakeCamera('paused');
    const s = createFrameSampler(cam, { intervalMs: 1000, maxDim: 768, jpegQuality: 0.7 }, { document: visible });
    s.start(() => {});
    await vi.advanceTimersByTimeAsync(3_000);
    expect(capture).not.toHaveBeenCalled();
    setStatus('active');
    await vi.advanceTimersByTimeAsync(1_000);
    expect(capture).toHaveBeenCalledTimes(1);
    s.stop();
  });

  it('stop() clears timers and discards a capture that resolves afterwards', async () => {
    const { cam, capture } = fakeCamera();
    let finish!: (f: CapturedFrame | null) => void;
    capture.mockImplementationOnce(() => new Promise((r) => (finish = r)));
    const onFrame = vi.fn();
    const s = createFrameSampler(cam, { intervalMs: 1000, maxDim: 768, jpegQuality: 0.7 }, { document: visible });
    s.start(onFrame);
    await vi.advanceTimersByTimeAsync(0);
    s.stop();
    expect(vi.getTimerCount()).toBe(0);
    finish({ frameId: 1, capturedAt: Date.now(), width: 4, height: 3, mimeType: 'image/jpeg', data: 'QUJD' });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(onFrame).not.toHaveBeenCalled();
    expect(s.latest()).toBeNull();
    expect(capture).toHaveBeenCalledTimes(1);
  });
});

describe('FrameSampler minIntervalMs (detection sampler)', () => {
  beforeEach(() => {
    vi.useFakeTimers({ now: 1_700_000_000_000 });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('effectiveIntervalMs: default floor is the Live 1 FPS limit; minIntervalMs lowers it but never below 250 ms', () => {
    expect(effectiveIntervalMs({ intervalMs: 250 })).toBe(LIMITS.liveFrameMinIntervalMs);
    expect(effectiveIntervalMs({ intervalMs: 250, minIntervalMs: LIMITS.detectFrameMinIntervalMs })).toBe(250);
    expect(effectiveIntervalMs({ intervalMs: 50, minIntervalMs: 10 })).toBe(LIMITS.detectFrameMinIntervalMs);
    expect(effectiveIntervalMs({ intervalMs: 500, minIntervalMs: 250 })).toBe(500);
    expect(effectiveIntervalMs({ intervalMs: Number.NaN, minIntervalMs: Number.NaN })).toBe(LIMITS.liveFrameMinIntervalMs);
  });

  it('samples at 4 FPS when allowed, and is clamped to 250 ms when asked for faster', async () => {
    const { cam, capture, captureTimes } = fakeCamera();
    const s = createFrameSampler(cam, { intervalMs: 100, minIntervalMs: 50, maxDim: 640, jpegQuality: 0.6 }, { document: visible });
    s.start(() => {});
    await vi.advanceTimersByTimeAsync(1_000);
    expect(capture).toHaveBeenCalledTimes(5); // t = 0, 250, 500, 750, 1000
    for (let i = 1; i < captureTimes.length; i++) expect(captureTimes[i]! - captureTimes[i - 1]!).toBeGreaterThanOrEqual(LIMITS.detectFrameMinIntervalMs);
    expect(capture.mock.calls[0]![0]).toEqual({ maxDim: 640, jpegQuality: 0.6 });
    s.stop();
  });
});
