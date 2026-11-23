// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { LIMITS } from '../../shared/protocol.js';
import { FramePayload } from '../../shared/protocol.js';
import { CAMERA_MESSAGES, computeCaptureSize, createCameraController, mapCameraError, type CameraControllerOptions } from './CameraController.js';
import type { FrameSurface } from './surface.js';

// ---------------------------------------------------------------------------------------------
// Fakes (jsdom has no MediaStream, real <video> playback or canvas encoding)
// ---------------------------------------------------------------------------------------------

class FakeTrack extends EventTarget {
  kind: string;
  label: string;
  readyState: 'live' | 'ended' = 'live';
  stopCalls = 0;
  constructor(
    private settings: MediaTrackSettings = { facingMode: 'environment', deviceId: 'rear' },
    kind = 'video',
    label = 'camera 0, facing back',
  ) {
    super();
    this.kind = kind;
    this.label = label;
  }
  stop(): void {
    this.stopCalls++;
    this.readyState = 'ended';
  }
  getSettings(): MediaTrackSettings {
    return this.settings;
  }
  /** Simulate the browser/OS ending the track (not our own stop()). */
  endExternally(): void {
    this.readyState = 'ended';
    this.dispatchEvent(new Event('ended'));
  }
}

function fakeStream(...tracks: FakeTrack[]): MediaStream {
  return {
    getTracks: () => [...tracks],
    getVideoTracks: () => tracks.filter((t) => t.kind === 'video'),
  } as unknown as MediaStream;
}

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
    this.dispatchEvent(new Event('loadedmetadata'));
    this.dispatchEvent(new Event('resize'));
  }
}

const domErr = (name: string) => new DOMException(`fake ${name}`, name);

function fakeSurfaces(encode: (q: number) => string = () => 'QUJDRA==') {
  const created: { width: number; height: number; qualities: number[] }[] = [];
  const factory = (width: number, height: number): FrameSurface => {
    const rec = { width, height, qualities: [] as number[] };
    created.push(rec);
    return {
      draw: vi.fn(),
      encodeJpeg: async (q) => {
        rec.qualities.push(q);
        return encode(q);
      },
      sample: () => ({ width: 2, height: 2, data: new Uint8ClampedArray(16).fill(128) }),
    };
  };
  return { factory, created };
}

function setup(overrides: Partial<CameraControllerOptions> & { tracks?: FakeTrack[] } = {}) {
  const track = new FakeTrack();
  const tracks = overrides.tracks ?? [track];
  const getUserMedia = vi.fn(async (_c: MediaStreamConstraints) => fakeStream(...tracks));
  const deviceEvents = new EventTarget();
  const devices: MediaDeviceInfo[] = [{ kind: 'videoinput', deviceId: 'rear', label: '', groupId: '' } as MediaDeviceInfo];
  const enumerateDevices = vi.fn(async () => devices);
  const surfaces = fakeSurfaces();
  let clock = 1_700_000_000_000;
  const cam = createCameraController({
    getUserMedia,
    enumerateDevices,
    isSecureContext: true,
    now: () => clock++ + 0.4, // fractional: capturedAt must still be an integer
    document,
    deviceEvents,
    createSurface: surfaces.factory,
    readyTimeoutMs: 0,
    ...overrides,
  });
  const video = new FakeVideo();
  return { cam, track, tracks, getUserMedia, enumerateDevices, devices, deviceEvents, surfaces, video, el: video as unknown as HTMLVideoElement };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

// jsdom does not implement media playback; the detached fallback <video> would log "Not implemented".
beforeEach(() => {
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined);
});

// ---------------------------------------------------------------------------------------------

describe('CameraController: start and errors', () => {
  it('reports insecure_context without calling getUserMedia', async () => {
    const { cam, getUserMedia } = setup({ isSecureContext: false });
    await cam.start();
    expect(cam.getState().status).toBe('insecure_context');
    expect(cam.getState().message).toMatch(/https/);
    expect(cam.getState().message).toMatch(/localhost/);
    expect(cam.getState().message).toMatch(/adb reverse/);
    expect(getUserMedia).not.toHaveBeenCalled();
  });

  it('requests video only with a rear-camera preference, 2560x1440 first', async () => {
    const { cam, getUserMedia } = setup();
    await cam.start();
    expect(cam.getState().status).toBe('active');
    expect(getUserMedia).toHaveBeenCalledTimes(1);
    expect(getUserMedia.mock.calls[0]![0]).toEqual({
      audio: false,
      video: { facingMode: { ideal: 'environment' }, width: { ideal: 2560 }, height: { ideal: 1440 } },
    });
  });

  it('keeps 1920x1080 as the next option when the 2560x1440 stream cannot start', async () => {
    const { cam, getUserMedia, tracks } = setup();
    getUserMedia.mockRejectedValueOnce(domErr('NotReadableError')).mockResolvedValueOnce(fakeStream(...tracks));
    await cam.start();
    expect(cam.getState().status).toBe('active');
    expect(getUserMedia.mock.calls[1]![0]).toEqual({
      audio: false,
      video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } },
    });
  });

  it('maps NotAllowedError to denied and does not retry other constraints', async () => {
    const { cam, getUserMedia } = setup();
    getUserMedia.mockRejectedValue(domErr('NotAllowedError'));
    await cam.start();
    expect(cam.getState().status).toBe('denied');
    expect(cam.getState().message).toBe(CAMERA_MESSAGES.denied);
    expect(getUserMedia).toHaveBeenCalledTimes(1);
  });

  it('maps SecurityError to denied', async () => {
    const { cam, getUserMedia } = setup();
    getUserMedia.mockRejectedValue(domErr('SecurityError'));
    await cam.start();
    expect(cam.getState().status).toBe('denied');
    expect(getUserMedia).toHaveBeenCalledTimes(1);
  });

  it.each(['NotReadableError', 'AbortError'])('maps %s to in_use (camera held by another app)', async (name) => {
    const { cam, getUserMedia } = setup();
    getUserMedia.mockRejectedValue(domErr(name));
    await cam.start();
    expect(cam.getState().status).toBe('in_use');
    expect(cam.getState().message).toMatch(/another app/);
    // One retry at 1920x1080 (the > 1080p request may be what failed), then no further fallbacks.
    expect(getUserMedia).toHaveBeenCalledTimes(2);
  });

  it('falls back to the next constraint on OverconstrainedError', async () => {
    const { cam, getUserMedia, tracks } = setup();
    getUserMedia.mockRejectedValueOnce(domErr('OverconstrainedError')).mockResolvedValueOnce(fakeStream(...tracks));
    await cam.start();
    expect(cam.getState().status).toBe('active');
    expect(getUserMedia).toHaveBeenCalledTimes(2);
    expect(getUserMedia.mock.calls[1]![0]).toEqual({ audio: false, video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } } });
  });

  it('ends with {video:true} and then reports unavailable when nothing matches', async () => {
    const { cam, getUserMedia } = setup();
    getUserMedia.mockRejectedValue(domErr('NotFoundError'));
    await cam.start();
    expect(getUserMedia).toHaveBeenCalledTimes(4);
    expect(getUserMedia.mock.calls[2]![0]).toEqual({ audio: false, video: { facingMode: { ideal: 'environment' } } });
    expect(getUserMedia.mock.calls[3]![0]).toEqual({ audio: false, video: true });
    expect(cam.getState().status).toBe('unavailable');
  });

  it('maps unknown failures to error', () => {
    expect(mapCameraError(new TypeError('x')).status).toBe('error');
    expect(mapCameraError('weird').status).toBe('error');
  });

  it('reports unavailable when getUserMedia is missing in a secure context', async () => {
    const cam = createCameraController({ isSecureContext: true, getUserMedia: undefined, deviceEvents: new EventTarget() });
    // In jsdom navigator.mediaDevices is undefined, so the default is also missing.
    await cam.start();
    expect(cam.getState().status).toBe('unavailable');
  });

  it('determines facing from track settings, else unknown', async () => {
    const a = setup();
    await a.cam.start();
    expect(a.cam.getState().facing).toBe('environment');
    expect(a.cam.getState().deviceLabel).toBe('camera 0, facing back');

    const b = setup({ tracks: [new FakeTrack({ deviceId: 'x' })] });
    await b.cam.start();
    expect(b.cam.getState().facing).toBe('unknown');
  });

  it('sets canSwitch from videoinput count and refreshes on devicechange', async () => {
    const { cam, devices, deviceEvents } = setup();
    devices.push({ kind: 'audioinput', deviceId: 'mic', label: '', groupId: '' } as MediaDeviceInfo);
    await cam.start();
    await flush();
    expect(cam.getState().canSwitch).toBe(false);
    devices.push({ kind: 'videoinput', deviceId: 'front', label: '', groupId: '' } as MediaDeviceInfo);
    deviceEvents.dispatchEvent(new Event('devicechange'));
    await flush();
    expect(cam.getState().canSwitch).toBe(true);
  });
});

describe('CameraController: lifecycle', () => {
  it('track ended -> disconnected and releases the stream', async () => {
    const { cam, track, el, video } = setup();
    cam.attachVideo(el);
    await cam.start();
    expect(video.srcObject).not.toBeNull();
    track.endExternally();
    expect(cam.getState().status).toBe('disconnected');
    expect(cam.getState().message).toBe(CAMERA_MESSAGES.disconnected);
    expect(video.srcObject).toBeNull();
  });

  it('stop() releases every track, detaches the element and is idempotent', async () => {
    const extra = new FakeTrack({}, 'video', 'second');
    const main = new FakeTrack();
    const { cam, el, video } = setup({ tracks: [main, extra] });
    cam.attachVideo(el);
    await cam.start();
    // A second unexpected track is stopped immediately on adopt.
    expect(extra.stopCalls).toBe(1);
    const listener = vi.fn();
    cam.subscribe(listener);
    cam.stop();
    expect(main.stopCalls).toBe(1);
    expect(main.readyState).toBe('ended');
    expect(video.srcObject).toBeNull();
    expect(cam.getState().status).toBe('stopped');
    const calls = listener.mock.calls.length;
    expect(() => cam.stop()).not.toThrow();
    expect(main.stopCalls).toBe(1);
    expect(listener.mock.calls.length).toBe(calls); // no state change, no notification
  });

  it('stop() during a pending start releases the late stream', async () => {
    const { cam, getUserMedia, track } = setup();
    let resolve!: (s: MediaStream) => void;
    getUserMedia.mockImplementationOnce(() => new Promise((r) => (resolve = r)));
    const p = cam.start();
    expect(cam.getState().status).toBe('requesting');
    cam.stop();
    resolve(fakeStream(track));
    await p;
    expect(track.stopCalls).toBe(1);
    expect(cam.getState().status).toBe('stopped');
  });

  it('attachVideo sets inline/muted/autoplay, srcObject and tolerates play() rejection', async () => {
    const { cam, el, video } = setup();
    video.play.mockRejectedValueOnce(domErr('NotAllowedError'));
    await cam.start();
    cam.attachVideo(el);
    expect(video.muted).toBe(true);
    expect(video.playsInline).toBe(true);
    expect(video.autoplay).toBe(true);
    expect(video.srcObject).not.toBeNull();
    expect(video.play).toHaveBeenCalled();
    await flush();
    expect(cam.getState().status).toBe('active');
    cam.attachVideo(null);
    expect(video.srcObject).toBeNull();
  });

  it('getState() is referentially stable until something changes; subscribers are notified', async () => {
    const { cam } = setup();
    const s0 = cam.getState();
    expect(cam.getState()).toBe(s0);
    const listener = vi.fn();
    const unsub = cam.subscribe(listener);
    await cam.start();
    expect(listener).toHaveBeenCalled();
    const s1 = cam.getState();
    expect(s1).not.toBe(s0);
    expect(cam.getState()).toBe(s1);
    unsub();
    listener.mockClear();
    cam.stop();
    expect(listener).not.toHaveBeenCalled();
  });

  it('tracks video dimensions on loadedmetadata/resize (rotation swaps them)', async () => {
    const { cam, el, video } = setup();
    cam.attachVideo(el);
    await cam.start();
    video.setFrame(1080, 1920);
    expect(cam.getState()).toMatchObject({ videoWidth: 1080, videoHeight: 1920 });
    video.setFrame(1920, 1080);
    expect(cam.getState()).toMatchObject({ videoWidth: 1920, videoHeight: 1080 });
  });

  it('pause() releases the camera; resume() re-acquires the same device', async () => {
    const { cam, track, getUserMedia, el, video } = setup();
    cam.attachVideo(el);
    await cam.start();
    cam.pause();
    expect(cam.getState().status).toBe('paused');
    expect(track.stopCalls).toBe(1);
    expect(video.srcObject).toBeNull();
    getUserMedia.mockResolvedValueOnce(fakeStream(new FakeTrack()));
    await cam.resume();
    expect(cam.getState().status).toBe('active');
    expect(getUserMedia.mock.calls[1]![0]).toMatchObject({ audio: false, video: { deviceId: { exact: 'rear' } } });
    expect(video.srcObject).not.toBeNull();
  });

  it('switchCamera() stops the old track before opening the other camera', async () => {
    const { cam, track, getUserMedia, devices } = setup();
    devices.push({ kind: 'videoinput', deviceId: 'front', label: '', groupId: '' } as MediaDeviceInfo);
    await cam.start();
    const front = new FakeTrack({ facingMode: 'user', deviceId: 'front' }, 'video', 'camera 1, facing front');
    let oldStoppedAtRequest: boolean | null = null;
    getUserMedia.mockImplementationOnce(async () => {
      oldStoppedAtRequest = track.stopCalls === 1;
      return fakeStream(front);
    });
    await cam.switchCamera();
    expect(oldStoppedAtRequest).toBe(true);
    expect(getUserMedia.mock.calls[1]![0]).toMatchObject({ video: { facingMode: { exact: 'user' } } });
    expect(cam.getState()).toMatchObject({ status: 'active', facing: 'user' });
  });

  it('switchCamera() restores the previous camera if no other camera opens', async () => {
    const { cam, getUserMedia } = setup();
    await cam.start();
    getUserMedia
      .mockRejectedValueOnce(domErr('OverconstrainedError'))
      .mockRejectedValueOnce(domErr('OverconstrainedError'))
      .mockRejectedValueOnce(domErr('OverconstrainedError'))
      .mockResolvedValueOnce(fakeStream(new FakeTrack()));
    await cam.switchCamera();
    expect(cam.getState()).toMatchObject({ status: 'active', facing: 'environment' });
    expect(getUserMedia.mock.calls[4]![0]).toMatchObject({ video: { deviceId: { exact: 'rear' } } });
  });
});

describe('CameraController: capture', () => {
  const opts = { maxDim: 768, jpegQuality: 0.7 };

  it('returns null when not active', async () => {
    const { cam, el, video } = setup();
    cam.attachVideo(el);
    video.setFrame(1080, 1920);
    expect(await cam.capture(opts)).toBeNull();
  });

  it('returns null before the video has valid dimensions', async () => {
    const { cam, el, video } = setup();
    cam.attachVideo(el);
    await cam.start();
    expect(await cam.capture(opts)).toBeNull();
    video.videoWidth = 640;
    video.videoHeight = 480;
    video.readyState = 1; // HAVE_METADATA only: no decoded frame yet
    expect(await cam.capture(opts)).toBeNull();
  });

  it('waits briefly for the first frame when readyTimeoutMs > 0', async () => {
    const { cam, el, video } = setup({ readyTimeoutMs: 500 });
    cam.attachVideo(el);
    await cam.start();
    const p = cam.capture(opts);
    setTimeout(() => video.setFrame(640, 480), 10);
    const f = await p;
    expect(f).not.toBeNull();
    expect(f).toMatchObject({ width: 640, height: 480 });
  });

  it('produces a valid FramePayload with strictly increasing frameIds and integer capturedAt', async () => {
    const { cam, el, video } = setup();
    cam.attachVideo(el);
    await cam.start();
    video.setFrame(1080, 1920);
    const a = await cam.capture(opts);
    const b = await cam.capture(opts);
    const c = await cam.capture({ ...opts, computeQuality: false });
    expect(a && b && c).toBeTruthy();
    expect(b!.frameId).toBeGreaterThan(a!.frameId);
    expect(c!.frameId).toBeGreaterThan(b!.frameId);
    for (const f of [a!, b!, c!]) {
      expect(Number.isInteger(f.capturedAt)).toBe(true);
      expect(f.mimeType).toBe('image/jpeg');
      expect(f.data.startsWith('data:')).toBe(false);
      expect(FramePayload.safeParse(f).success).toBe(true);
    }
    expect(a!.quality).toEqual({ meanLuma: 128, sharpness: 0 });
    expect(c!.quality).toBeUndefined();
  });

  it('scales portrait 1080x1920 to 432x768 at maxDim 768 and never upscales', async () => {
    const { cam, el, video, surfaces } = setup();
    cam.attachVideo(el);
    await cam.start();
    video.setFrame(1080, 1920);
    expect(await cam.capture(opts)).toMatchObject({ width: 432, height: 768 });
    video.setFrame(1920, 1080);
    expect(await cam.capture(opts)).toMatchObject({ width: 768, height: 432 });
    video.setFrame(640, 480);
    expect(await cam.capture({ maxDim: 1600, jpegQuality: 0.85 })).toMatchObject({ width: 640, height: 480 });
    expect(surfaces.created.map((s) => [s.width, s.height])).toEqual([
      [432, 768],
      [768, 432],
      [640, 480],
    ]);
  });

  it('re-encodes once at lower quality when too large, else returns null', async () => {
    const big = 'A'.repeat(LIMITS.maxFrameBase64Chars + 4);
    const once = fakeSurfaces((q) => (q >= 0.7 ? big : 'QUJD'));
    const a = setup({ createSurface: once.factory });
    a.cam.attachVideo(a.el);
    await a.cam.start();
    a.video.setFrame(1080, 1920);
    expect(await a.cam.capture(opts)).toMatchObject({ data: 'QUJD' });
    expect(once.created[0]!.qualities).toHaveLength(2);
    expect(once.created[0]!.qualities[1]!).toBeLessThan(0.7);

    const always = fakeSurfaces(() => big);
    const b = setup({ createSurface: always.factory });
    b.cam.attachVideo(b.el);
    await b.cam.start();
    b.video.setFrame(1080, 1920);
    expect(await b.cam.capture(opts)).toBeNull();
    expect(always.created[0]!.qualities).toHaveLength(2);
  });

  it('returns null if the camera is stopped while encoding', async () => {
    let release!: () => void;
    const slow = (_w: number, _h: number): FrameSurface => ({
      draw: () => {},
      sample: () => null,
      encodeJpeg: () => new Promise((r) => (release = () => r('QUJD'))),
    });
    const { cam, el, video } = setup({ createSurface: slow });
    cam.attachVideo(el);
    await cam.start();
    video.setFrame(640, 480);
    const p = cam.capture(opts);
    await flush();
    cam.stop();
    release();
    expect(await p).toBeNull();
  });

  it('captures from a detached fallback element when no preview is attached', async () => {
    const { cam } = setup();
    await cam.start();
    // jsdom's fallback <video> never decodes frames, so this is null rather than throwing.
    expect(await cam.capture(opts)).toBeNull();
  });
});

describe('computeCaptureSize', () => {
  it('preserves aspect ratio and clamps the longest side', () => {
    expect(computeCaptureSize(1080, 1920, 768)).toEqual({ width: 432, height: 768 });
    expect(computeCaptureSize(1920, 1080, 768)).toEqual({ width: 768, height: 432 });
    expect(computeCaptureSize(4000, 3000, 1600)).toEqual({ width: 1600, height: 1200 });
    expect(computeCaptureSize(300, 200, 768)).toEqual({ width: 300, height: 200 });
    expect(computeCaptureSize(768, 768, 768)).toEqual({ width: 768, height: 768 });
  });
});
