/** Detector HTTP client tests with a FIXTURE fake fetch (no network). */
import { describe, expect, it } from 'vitest';
import { LIMITS, ServerDetections, type FramePayload } from '../../shared/protocol.js';
import type { AppConfig } from '../config.js';
import { createMemoryLogger } from '../log.js';
import { createDetector, isNewerDetection } from './detector.js';

const URL_ = 'http://127.0.0.1:8765';
const cfg = (detectorUrl: string | null) => ({ detectorUrl }) as AppConfig;

const frame = (frameId = 1): FramePayload => ({
  frameId,
  capturedAt: 1_795_000_000_000 + frameId,
  width: 768,
  height: 1024,
  mimeType: 'image/jpeg',
  data: 'AAAAFIXTURE',
});

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

/** FIXTURE detector response (hand-written, not real model output). */
const okBody = (frameId: number, extra: object[] = []) => ({
  frameId,
  model: 'yolo26n',
  detections: [
    { label: 'bottle', score: 0.91, box: { x: 0.1, y: 0.2, w: 0.2, h: 0.5 } },
    { label: 'cup', score: 0.2, box: { x: 0.5, y: 0.5, w: 0.1, h: 0.1 } },
    ...extra,
  ],
});

function setup(handler: (url: string, init?: RequestInit) => Promise<Response>, options = {}) {
  let t = 10_000;
  const calls: { url: string; init?: RequestInit | undefined }[] = [];
  const log = createMemoryLogger();
  const det = createDetector({
    config: cfg(URL_),
    log,
    now: () => t,
    fetch: ((input: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(input), init });
      return handler(String(input), init);
    }) as typeof fetch,
    options,
  });
  return { det, calls, log, advance: (ms: number) => (t += ms) };
}

describe('createDetector', () => {
  it('disabled when DETECTOR_URL is unset', async () => {
    const det = createDetector({ config: cfg(null), log: createMemoryLogger() });
    expect(det.enabled).toBe(false);
    expect(await det.detect(frame())).toBeNull();
    expect(await det.health()).toBe('disabled');
  });

  it('posts the frame and returns validated, filtered detections', async () => {
    const { det, calls } = setup(() => Promise.resolve(json(okBody(1))));
    const res = await det.detect(frame(1));
    expect(res).not.toBeNull();
    expect(ServerDetections.parse(res)).toEqual(res);
    expect(res!.detections).toEqual([{ label: 'bottle', score: 0.91, box: { x: 0.1, y: 0.2, w: 0.2, h: 0.5 } }]); // score < 0.35 dropped
    expect(res).toMatchObject({ type: 'detections', frameId: 1, capturedAt: frame(1).capturedAt, sourceWidth: 768, sourceHeight: 1024, model: 'yolo26n' });
    expect(calls[0]!.url).toBe(`${URL_}/detect`);
    expect(calls[0]!.init?.method).toBe('POST');
    expect(JSON.parse(String(calls[0]!.init?.body))).toEqual({ frameId: 1, capturedAt: frame(1).capturedAt, width: 768, height: 1024, image: 'AAAAFIXTURE' });
    expect(calls[0]!.init?.signal).toBeInstanceOf(AbortSignal);
    expect(det.model).toBe('yolo26n');
  });

  it('keeps only one request in flight', async () => {
    let release!: () => void;
    const { det, calls, advance } = setup(
      () =>
        new Promise((resolve) => {
          release = () => resolve(json(okBody(1)));
        }),
    );
    const first = det.detect(frame(1));
    advance(5_000);
    expect(await det.detect(frame(2))).toBeNull(); // busy -> null immediately
    expect(calls).toHaveLength(1);
    release();
    expect(await first).not.toBeNull();
  });

  it('enforces the minimum interval', async () => {
    const { det, calls, advance } = setup((_u, init) => Promise.resolve(json(okBody(JSON.parse(String(init?.body)).frameId))));
    expect(await det.detect(frame(1))).not.toBeNull();
    advance(LIMITS.detectionMinIntervalMs - 1);
    expect(await det.detect(frame(2))).toBeNull();
    advance(1);
    expect(await det.detect(frame(3))).not.toBeNull();
    expect(calls).toHaveLength(2);
  });

  it('times out slow requests and returns null', async () => {
    const { det, log } = setup(
      (_u, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new DOMException('timeout', 'TimeoutError')));
        }),
      { requestTimeoutMs: 20 },
    );
    expect(await det.detect(frame(1))).toBeNull();
    expect(log.events.find((e) => e.event === 'detector_error')?.fields?.reason).toBe('timeout');
  });

  it('rejects malformed responses', async () => {
    const bodies: unknown[] = [
      { frameId: 1, detections: [{ label: 'bottle', score: 1.4, box: { x: 0, y: 0, w: 0.1, h: 0.1 } }] },
      { frameId: 1, detections: [{ label: 'bottle', score: 0.9, box: { x: 0, y: 0, w: 2, h: 0.1 } }] },
      { frameId: 1 },
      'not json at all',
    ];
    for (const body of bodies) {
      const { det } = setup(() => Promise.resolve(typeof body === 'string' ? new Response(body) : json(body)));
      expect(await det.detect(frame(1))).toBeNull();
    }
    const { det } = setup(() => Promise.resolve(json({ error: 'x' }, 500)));
    expect(await det.detect(frame(1))).toBeNull();
  });

  it('rejects results for a different frameId', async () => {
    const { det, log } = setup(() => Promise.resolve(json(okBody(99))));
    expect(await det.detect(frame(1))).toBeNull();
    expect(log.events.find((e) => e.event === 'detector_error')?.fields?.reason).toBe('frame_mismatch');
  });

  it('caps at LIMITS.maxDetections, sorted by score, boxes clamped to the image', async () => {
    const many = Array.from({ length: 80 }, (_, i) => ({ label: 'apple', score: 0.4 + i / 200, box: { x: 0.9, y: 0.9, w: 0.5, h: 0.5 } }));
    const { det } = setup(() => Promise.resolve(json({ frameId: 1, detections: many })));
    const res = await det.detect(frame(1));
    expect(res!.detections).toHaveLength(LIMITS.maxDetections);
    expect(res!.detections[0]!.score).toBeCloseTo(0.4 + 79 / 200);
    expect(res!.detections[0]!.box.w).toBeCloseTo(0.1);
  });

  it('cools down after consecutive failures, logs once, then recovers', async () => {
    let fail = true;
    const { det, calls, log, advance } = setup((_u, init) =>
      fail ? Promise.reject(new TypeError('fetch failed')) : Promise.resolve(json(okBody(JSON.parse(String(init?.body)).frameId))),
    );
    for (let i = 1; i <= 3; i++) {
      expect(await det.detect(frame(i))).toBeNull();
      advance(1_000);
    }
    expect(log.events.filter((e) => e.event === 'detector_cooldown')).toHaveLength(1);
    expect(await det.detect(frame(4))).toBeNull(); // cooling down: no request made
    expect(calls).toHaveLength(3);
    advance(30_000);
    fail = false;
    expect(await det.detect(frame(5))).not.toBeNull();
    expect(log.events.some((e) => e.event === 'detector_recovered')).toBe(true);
  });

  it('caller abort returns null without counting as a failure', async () => {
    const controller = new AbortController();
    const { det, log } = setup(
      (_u, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
        }),
    );
    const p = det.detect(frame(1), controller.signal);
    controller.abort();
    expect(await p).toBeNull();
    expect(log.events.some((e) => e.event === 'detector_error')).toBe(false);
  });

  it('health: ok / unreachable', async () => {
    expect(await setup(() => Promise.resolve(json({ ok: true, model: 'yolo26n' }))).det.health()).toBe('ok');
    expect(await setup(() => Promise.reject(new TypeError('ECONNREFUSED'))).det.health()).toBe('unreachable');
    expect(await setup(() => Promise.resolve(json({ ok: false }))).det.health()).toBe('unreachable');
    expect(await setup(() => Promise.resolve(json({}, 503))).det.health()).toBe('unreachable');
  });
});

describe('isNewerDetection', () => {
  it('only a strictly larger frameId is newer', () => {
    expect(isNewerDetection(null, { frameId: 0 })).toBe(true);
    expect(isNewerDetection({ frameId: 3 }, { frameId: 4 })).toBe(true);
    expect(isNewerDetection({ frameId: 4 }, { frameId: 4 })).toBe(false);
    expect(isNewerDetection({ frameId: 5 }, { frameId: 4 })).toBe(false);
  });
});
