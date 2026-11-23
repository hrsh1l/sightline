// @vitest-environment jsdom
/**
 * Detail stills (ImageCapture.takePhoto / sharpest video frame), torch and autofocus, with injected fakes.
 * jsdom has no ImageCapture, MediaStream, video decoding or canvas encoder; real S25 behaviour is unverified here.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FramePayload, LIMITS } from '../../shared/protocol.js';
import { choosePhotoSettings, createCameraController, stillRotation, type CameraControllerOptions, type DecodedPhoto, type ImageCaptureLike } from './CameraController.js';
import type { ImageDataLike } from './frameQuality.js';
import type { FrameSurface, SurfaceRotation } from './surface.js';

class FakeTrack extends EventTarget {
  kind = 'video';
  label = 'camera 0, facing back';
  readyState: 'live' | 'ended' = 'live';
  applied: MediaTrackConstraints[] = [];
  applyConstraints = vi.fn(async (c: MediaTrackConstraints) => {
    this.applied.push(c);
  });
  constructor(
    public caps: Record<string, unknown> = {},
    private settings: MediaTrackSettings = { facingMode: 'environment', deviceId: 'rear' },
  ) {
    super();
  }
  stop(): void {
    this.readyState = 'ended';
  }
  getSettings(): MediaTrackSettings {
    return this.settings;
  }
  getCapabilities(): MediaTrackCapabilities {
    return this.caps as MediaTrackCapabilities;
  }
}

const fakeStream = (track: FakeTrack) =>
  ({ getTracks: () => [track], getVideoTracks: () => [track] }) as unknown as MediaStream;

class FakeVideo extends EventTarget {
  videoWidth = 0;
  videoHeight = 0;
  readyState = 0;
  srcObject: MediaStream | null = null;
  muted = false;
  playsInline = false;
  autoplay = false;
  play = vi.fn(() => Promise.resolve());
  setFrame(w: number, h: number): void {
    this.videoWidth = w;
    this.videoHeight = h;
    this.readyState = 4;
    this.dispatchEvent(new Event('resize'));
  }
}

/** Grey image of w x h; `sharp` adds a 1-px checkerboard (high Laplacian variance). */
function img(w: number, h: number, sharp: number): ImageDataLike {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const v = 128 + ((x + y) % 2 ? sharp : -sharp);
      data.set([v, v, v, 255], (y * w + x) * 4);
    }
  return { width: w, height: h, data };
}

interface SurfaceRec {
  width: number;
  height: number;
  draws: { source: unknown; rotation: SurfaceRotation | undefined }[];
  qualities: number[];
  data: string;
}

/** Surfaces whose sample() returns images of the given sharpness, in creation order. */
function fakeSurfaces(sharpness: number[] = [], encode?: (q: number, i: number) => string) {
  const created: SurfaceRec[] = [];
  const factory = (width: number, height: number): FrameSurface => {
    const i = created.length;
    const rec: SurfaceRec = { width, height, draws: [], qualities: [], data: ['QUFB', 'QkJC', 'Q0ND', 'RERE', 'RUVF'][i % 5]! };
    created.push(rec);
    return {
      draw: (source, rotation) => rec.draws.push({ source, rotation }),
      encodeJpeg: async (q) => {
        rec.qualities.push(q);
        return encode ? encode(q, i) : rec.data;
      },
      sample: () => img(16, 16, sharpness[i] ?? 0),
    };
  };
  return { factory, created };
}

function fakeImageCapture(opts: { caps?: PhotoCapabilities; photo?: { width: number; height: number }; takePhoto?: () => Promise<Blob> } = {}) {
  const closed: number[] = [];
  const takePhoto = vi.fn(opts.takePhoto ?? (async (_s?: PhotoSettings) => new Blob(['FIXTURE-JPEG'], { type: 'image/jpeg' })));
  const ic: ImageCaptureLike = { takePhoto, getPhotoCapabilities: vi.fn(async () => opts.caps ?? {}) };
  const photo = opts.photo ?? { width: 4080, height: 3060 };
  const decodePhoto = vi.fn(async (_b: Blob): Promise<DecodedPhoto> => ({ ...photo, close: () => closed.push(1) }) as unknown as DecodedPhoto);
  return { ic, takePhoto, decodePhoto, closed };
}

const S25_LIKE_CAPS: PhotoCapabilities = {
  imageWidth: { min: 640, max: 4080, step: 1 },
  imageHeight: { min: 480, max: 3060, step: 1 },
  fillLightMode: ['auto', 'off', 'flash'],
};

async function setup(over: Partial<CameraControllerOptions> & { track?: FakeTrack; sharpness?: number[]; video?: [number, number] } = {}) {
  const track = over.track ?? new FakeTrack();
  const surfaces = fakeSurfaces(over.sharpness);
  let clock = 1_700_000_000_000;
  const cam = createCameraController({
    getUserMedia: vi.fn(async () => fakeStream(track)),
    enumerateDevices: async () => [],
    isSecureContext: true,
    now: () => clock++,
    document,
    deviceEvents: new EventTarget(),
    createSurface: surfaces.factory,
    readyTimeoutMs: 0,
    createImageCapture: null,
    stillFrameGapMs: 0,
    ...over,
  });
  const video = new FakeVideo();
  cam.attachVideo(video as unknown as HTMLVideoElement);
  await cam.start();
  const [vw, vh] = over.video ?? [2560, 1440];
  video.setFrame(vw, vh);
  return { cam, track, video, surfaces };
}

const STILL = { maxDim: LIMITS.detailMaxDim, jpegQuality: LIMITS.detailJpegQuality };
const flush = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

// ---------------------------------------------------------------------------------------------

describe('pure helpers', () => {
  it('choosePhotoSettings picks the largest size within maxDim, honours steps, turns flash off unless the torch is on', () => {
    expect(choosePhotoSettings(S25_LIKE_CAPS, 4096, false)).toEqual({ imageWidth: 4080, imageHeight: 3060, fillLightMode: 'off' });
    expect(choosePhotoSettings(S25_LIKE_CAPS, 2048, false)).toEqual({ imageWidth: 2048, imageHeight: 1536, fillLightMode: 'off' });
    expect(choosePhotoSettings(S25_LIKE_CAPS, 4096, true)).toEqual({ imageWidth: 4080, imageHeight: 3060 });
    expect(choosePhotoSettings({ imageWidth: { min: 640, max: 4000, step: 16 }, imageHeight: { min: 480, max: 3000, step: 16 } }, 1000, false)).toEqual({
      imageWidth: 992,
      imageHeight: 736,
    });
    expect(choosePhotoSettings(null, 4096, false)).toBeUndefined();
    expect(choosePhotoSettings({}, 4096, false)).toBeUndefined();
  });

  it('stillRotation only rotates when photo and preview orientation disagree', () => {
    expect(stillRotation(4080, 3060, 2560, 1440, 'environment')).toBe(0);
    expect(stillRotation(4080, 3060, 1440, 2560, 'environment')).toBe(90);
    expect(stillRotation(4080, 3060, 1440, 2560, 'user')).toBe(270);
    expect(stillRotation(3060, 4080, 1440, 2560, 'environment')).toBe(0);
    expect(stillRotation(3000, 3000, 1440, 2560, 'environment')).toBe(0); // square
    expect(stillRotation(4080, 3060, 0, 0, 'environment')).toBe(0); // unknown preview
  });
});

describe('torch and autofocus', () => {
  it('reports torch support from track capabilities and toggles it with applyConstraints', async () => {
    const { cam, track } = await setup({ track: new FakeTrack({ torch: true }) });
    expect(cam.getState().torch).toEqual({ supported: true, on: false });
    expect(await cam.setTorch(true)).toBe(true);
    expect(track.applyConstraints).toHaveBeenLastCalledWith({ advanced: [{ torch: true }] });
    expect(cam.getState().torch).toEqual({ supported: true, on: true });
    expect(await cam.setTorch(false)).toBe(true);
    expect(cam.getState().torch).toEqual({ supported: true, on: false });
  });

  it('resolves false without touching the track when unsupported', async () => {
    const { cam, track } = await setup();
    expect(cam.getState().torch).toEqual({ supported: false, on: false });
    expect(await cam.setTorch(true)).toBe(false);
    expect(track.applyConstraints).not.toHaveBeenCalled();
  });

  it('resolves false and keeps state when the browser refuses', async () => {
    const track = new FakeTrack({ torch: true });
    const { cam } = await setup({ track });
    track.applyConstraints.mockRejectedValueOnce(new DOMException('no', 'NotReadableError'));
    expect(await cam.setTorch(true)).toBe(false);
    expect(cam.getState().torch).toEqual({ supported: true, on: false });
  });

  it.each(['stop', 'pause'] as const)('torch resets to off on %s', async (action) => {
    const { cam } = await setup({ track: new FakeTrack({ torch: true }) });
    await cam.setTorch(true);
    cam[action]();
    expect(cam.getState().torch).toEqual({ supported: false, on: false });
    expect(await cam.setTorch(true)).toBe(false);
  });

  it('torch resets to off when switching camera', async () => {
    const rear = new FakeTrack({ torch: true });
    const front = new FakeTrack({}, { facingMode: 'user', deviceId: 'front' });
    const gum = vi.fn(async () => fakeStream(rear));
    const { cam } = await setup({ track: rear, getUserMedia: gum });
    await cam.setTorch(true);
    gum.mockResolvedValueOnce(fakeStream(front));
    await cam.switchCamera();
    expect(cam.getState()).toMatchObject({ status: 'active', facing: 'user', torch: { supported: false, on: false } });
  });

  it('picks up a torch capability that appears after frames start', async () => {
    const track = new FakeTrack({});
    const { cam, video } = await setup({ track });
    expect(cam.getState().torch.supported).toBe(false);
    track.caps = { torch: true };
    video.setFrame(2560, 1440);
    expect(cam.getState().torch).toEqual({ supported: true, on: false });
  });

  it('requests continuous autofocus only when the track offers it', async () => {
    const af = await setup({ track: new FakeTrack({ focusMode: ['manual', 'single-shot', 'continuous'] }) });
    expect(af.track.applyConstraints).toHaveBeenCalledWith({ advanced: [{ focusMode: 'continuous' }] });
    const none = await setup({ track: new FakeTrack({ focusMode: ['manual'] }) });
    expect(none.track.applyConstraints).not.toHaveBeenCalled();
  });

  it('getState() reference is stable when the torch value does not change', async () => {
    const { cam, video } = await setup({ track: new FakeTrack({ torch: true }) });
    const s = cam.getState();
    video.dispatchEvent(new Event('resize'));
    expect(cam.getState()).toBe(s);
  });
});

describe('captureStill: ImageCapture.takePhoto path', () => {
  it('stillCapture reflects ImageCapture availability', async () => {
    const f = fakeImageCapture();
    expect((await setup({ createImageCapture: () => f.ic })).cam.getState().stillCapture).toBe(true);
    expect((await setup()).cam.getState().stillCapture).toBe(false);
  });

  it('takes a full-resolution photo, flash off, and encodes it at detail quality', async () => {
    const f = fakeImageCapture({ caps: S25_LIKE_CAPS });
    const { cam, surfaces } = await setup({ createImageCapture: () => f.ic, decodePhoto: f.decodePhoto });
    const frame = await cam.captureStill(STILL);
    expect(f.takePhoto).toHaveBeenCalledWith({ imageWidth: 4080, imageHeight: 3060, fillLightMode: 'off' });
    expect(frame).toMatchObject({ width: 4080, height: 3060, mimeType: 'image/jpeg' });
    expect(FramePayload.safeParse(frame).success).toBe(true);
    expect(surfaces.created).toHaveLength(1);
    expect(surfaces.created[0]!.draws[0]!.rotation).toBe(0);
    expect(surfaces.created[0]!.qualities).toEqual([0.9]);
    expect(frame!.quality).toBeDefined();
    expect(f.closed).toHaveLength(1); // bitmap released
  });

  it('scales to maxDim (never upscales) and assigns fresh, increasing frameIds', async () => {
    const f = fakeImageCapture({ caps: S25_LIKE_CAPS, photo: { width: 2048, height: 1536 } });
    const { cam } = await setup({ createImageCapture: () => f.ic, decodePhoto: f.decodePhoto, video: [1920, 1080] });
    const a = await cam.captureStill({ maxDim: 2048, jpegQuality: 0.9 });
    const live = await cam.capture({ maxDim: 768, jpegQuality: 0.7 });
    const b = await cam.captureStill({ maxDim: 1600, jpegQuality: 0.9 });
    expect(f.takePhoto.mock.calls[0]![0]).toMatchObject({ imageWidth: 2048, imageHeight: 1536 });
    expect(a).toMatchObject({ width: 2048, height: 1536 });
    expect(b).toMatchObject({ width: 1600, height: 1200 });
    expect(live!.frameId).toBeGreaterThan(a!.frameId);
    expect(b!.frameId).toBeGreaterThan(live!.frameId);
  });

  it('rotates a sensor-oriented landscape photo to match a portrait preview', async () => {
    const f = fakeImageCapture({ photo: { width: 4080, height: 3060 } });
    const { cam, surfaces } = await setup({ createImageCapture: () => f.ic, decodePhoto: f.decodePhoto, video: [1440, 2560] });
    const frame = await cam.captureStill(STILL);
    expect(frame).toMatchObject({ width: 3060, height: 4080 });
    expect(surfaces.created[0]!.draws[0]!.rotation).toBe(90);
  });

  it('re-asserts the torch after the photo and leaves flash mode alone while the torch is on', async () => {
    const f = fakeImageCapture({ caps: S25_LIKE_CAPS });
    const { cam, track } = await setup({ track: new FakeTrack({ torch: true }), createImageCapture: () => f.ic, decodePhoto: f.decodePhoto });
    await cam.setTorch(true);
    track.applyConstraints.mockClear();
    await cam.captureStill(STILL);
    expect(f.takePhoto.mock.calls[0]![0]).not.toHaveProperty('fillLightMode');
    expect(track.applyConstraints).toHaveBeenCalledWith({ advanced: [{ torch: true }] });
  });

  it('falls back to video frames when takePhoto fails', async () => {
    const f = fakeImageCapture({ takePhoto: () => Promise.reject(new DOMException('fail', 'UnknownError')) });
    const { cam } = await setup({ createImageCapture: () => f.ic, decodePhoto: f.decodePhoto });
    const frame = await cam.captureStill(STILL);
    expect(f.takePhoto).toHaveBeenCalled();
    expect(frame).toMatchObject({ width: 2560, height: 1440 });
  });

  it('falls back to video frames when takePhoto does not answer in time', async () => {
    const f = fakeImageCapture({ takePhoto: () => new Promise(() => {}) });
    const { cam } = await setup({ createImageCapture: () => f.ic, decodePhoto: f.decodePhoto, stillTimeoutMs: 20 });
    const frame = await cam.captureStill(STILL);
    expect(frame).toMatchObject({ width: 2560, height: 1440 });
    expect(f.decodePhoto).not.toHaveBeenCalled();
  });

  it('uses video frames when the photo is smaller than the video stream', async () => {
    const f = fakeImageCapture({ photo: { width: 1280, height: 720 } });
    const { cam } = await setup({ createImageCapture: () => f.ic, decodePhoto: f.decodePhoto });
    expect(await cam.captureStill(STILL)).toMatchObject({ width: 2560, height: 1440 });
    expect(f.closed).toHaveLength(1);
  });

  it('runs one still capture at a time', async () => {
    const resolvers: Array<() => void> = [];
    const f = fakeImageCapture({
      takePhoto: () => new Promise<Blob>((r) => resolvers.push(() => r(new Blob(['x'], { type: 'image/jpeg' })))),
    });
    const { cam } = await setup({ createImageCapture: () => f.ic, decodePhoto: f.decodePhoto });
    const a = cam.captureStill(STILL);
    const b = cam.captureStill(STILL);
    await flush();
    expect(f.takePhoto).toHaveBeenCalledTimes(1);
    resolvers[0]!();
    const fa = await a;
    await flush();
    expect(f.takePhoto).toHaveBeenCalledTimes(2);
    resolvers[1]!();
    const fb = await b;
    expect(fb!.frameId).toBeGreaterThan(fa!.frameId);
  });

  it('returns null when the camera stops during takePhoto, and when not active', async () => {
    let release!: () => void;
    const f = fakeImageCapture({ takePhoto: () => new Promise<Blob>((r) => (release = () => r(new Blob(['x'])))) });
    const { cam } = await setup({ createImageCapture: () => f.ic, decodePhoto: f.decodePhoto });
    const p = cam.captureStill(STILL);
    await flush();
    cam.stop();
    release();
    expect(await p).toBeNull();
    expect(f.decodePhoto).not.toHaveBeenCalled();
    expect(await cam.captureStill(STILL)).toBeNull();
  });
});

describe('captureStill: sharpest-of-N video frames (no ImageCapture)', () => {
  it('keeps the sharpest of LIMITS.detailBestOf frames at native video size', async () => {
    const { cam, surfaces } = await setup({ sharpness: [2, 40, 10] });
    const frame = await cam.captureStill(STILL);
    expect(surfaces.created).toHaveLength(LIMITS.detailBestOf);
    expect(surfaces.created.map((s) => [s.width, s.height])).toEqual([
      [2560, 1440],
      [2560, 1440],
      [2560, 1440],
    ]);
    expect(frame!.data).toBe(surfaces.created[1]!.data); // the checkerboard frame wins
    expect(surfaces.created[0]!.qualities).toEqual([]); // losers are never encoded
    expect(surfaces.created[2]!.qualities).toEqual([]);
    expect(FramePayload.safeParse(frame).success).toBe(true);
  });

  it('honours bestOf and maxDim', async () => {
    const { cam, surfaces } = await setup({ sharpness: [5, 1, 9, 3, 7] });
    const frame = await cam.captureStill({ maxDim: 1600, jpegQuality: 0.9, bestOf: 5 });
    expect(surfaces.created).toHaveLength(5);
    expect(frame).toMatchObject({ width: 1600, height: 900, data: surfaces.created[2]!.data });
  });

  it('respects the payload cap: one lower-quality re-encode, else null', async () => {
    const big = 'A'.repeat(LIMITS.maxFrameBase64Chars + 4);
    const once = fakeSurfaces([], (q) => (q >= 0.9 ? big : 'QUJD'));
    const a = await setup({ createSurface: once.factory });
    expect(await a.cam.captureStill({ ...STILL, bestOf: 1 })).toMatchObject({ data: 'QUJD' });
    expect(once.created[0]!.qualities).toHaveLength(2);

    const always = fakeSurfaces([], () => big);
    const b = await setup({ createSurface: always.factory });
    expect(await b.cam.captureStill({ ...STILL, bestOf: 1 })).toBeNull();
  });

  it('returns null without valid video frames', async () => {
    const { cam, video } = await setup();
    video.readyState = 1;
    expect(await cam.captureStill(STILL)).toBeNull();
  });
});
