/**
 * Rear-camera controller for Sightline (phone Chrome). Implements the lead-owned CameraController
 * contract: permission + error mapping, rear preference with constraint fallbacks, pause/resume to
 * release the camera while backgrounded, and un-mirrored JPEG capture with bounded size.
 *
 * Small-print reading: the stream prefers 2560x1440 (then the verified 1920x1080), continuous autofocus is
 * requested when the track supports it, captureStill() uses ImageCapture.takePhoto() at the sensor's photo
 * resolution (or the sharpest of a few video frames), and setTorch() drives the torch where the track exposes it.
 *
 * Browser globals are only defaults; every dependency can be injected for tests.
 */
import type {
  CameraController,
  CameraFacing,
  CameraState,
  CameraStatus,
  CaptureOptions,
  CapturedFrame,
  Listener,
} from '../contracts.js';
import { LIMITS, type FrameQuality } from '../../shared/protocol.js';
import { ANALYSIS_MAX_SIDE, computeFrameQuality, laplacianVariance, toGrayscale } from './frameQuality.js';
import { createCanvasSurfaceFactory, type FrameSurface, type SurfaceFactory, type SurfaceRotation } from './surface.js';

/** Structural subset of the browser ImageCapture used here (injectable for tests). */
export interface ImageCaptureLike {
  takePhoto(settings?: PhotoSettings): Promise<Blob>;
  getPhotoCapabilities?(): Promise<PhotoCapabilities>;
}

/** A decoded still: an ImageBitmap in the browser. */
export type DecodedPhoto = CanvasImageSource & { readonly width: number; readonly height: number; close?(): void };

export interface CameraControllerOptions {
  getUserMedia?: (constraints: MediaStreamConstraints) => Promise<MediaStream>;
  enumerateDevices?: () => Promise<MediaDeviceInfo[]>;
  /** Defaults to window.isSecureContext. */
  isSecureContext?: boolean;
  /** Epoch-ms clock for capturedAt. Defaults to Date.now. */
  now?: () => number;
  /** Used to create the fallback capture <video> and HTMLCanvasElement fallback. */
  document?: Document;
  /** Source of 'devicechange' events. Defaults to navigator.mediaDevices. */
  deviceEvents?: Pick<EventTarget, 'addEventListener' | 'removeEventListener'>;
  /** Canvas/JPEG encoder factory. Defaults to OffscreenCanvas / HTMLCanvasElement. */
  createSurface?: SurfaceFactory;
  /** How long capture() waits for a decodable frame right after start/resume. Default 1000 ms. */
  readyTimeoutMs?: number;
  /** ImageCapture factory. Defaults to `new ImageCapture(track)` when the browser has it; null disables takePhoto. */
  createImageCapture?: ((track: MediaStreamTrack) => ImageCaptureLike) | null;
  /** Decode a photo Blob honouring EXIF orientation. Defaults to createImageBitmap(blob, { imageOrientation: 'from-image' }). */
  decodePhoto?: (blob: Blob) => Promise<DecodedPhoto>;
  /** Deadline for getPhotoCapabilities + takePhoto before falling back to video frames. Default 2500 ms. */
  stillTimeoutMs?: number;
  /** Gap between the video frames compared by captureStill's fallback. Default 120 ms. */
  stillFrameGapMs?: number;
}

const HAVE_CURRENT_DATA = 2; // HTMLMediaElement.HAVE_CURRENT_DATA (literal so it works outside the DOM)
const MAX_ENCODED_SIDE = 8192; // FrameMeta width/height upper bound
/** Side of the copy used to compare sharpness between candidate frames (128 px is too coarse for small print). */
export const STILL_SHARPNESS_SAMPLE_SIDE = 512;
const MAX_BEST_OF = 8;

export const CAMERA_MESSAGES = {
  insecure:
    'Camera needs a secure page. Open the app over https, or as http://localhost:3000 on the phone using adb reverse.',
  unsupported: 'This browser does not support camera access.',
  denied: 'Camera permission was denied. Allow Camera for this site in Chrome site settings, then try again.',
  blocked: 'Camera access is blocked on this page. Check Chrome site settings for Camera, then try again.',
  unavailable: 'No usable camera was found on this device.',
  inUse: 'The camera could not start. It may be in use by another app. Close other camera apps and try again.',
  error: 'The camera could not start. Please try again.',
  disconnected: 'The camera stopped unexpectedly. Start the camera again to continue.',
  paused: 'Camera paused while the app is in the background.',
} as const;

const TORCH_OFF = { supported: false, on: false } as const;

const INITIAL_STATE: CameraState = {
  status: 'idle',
  facing: 'unknown',
  deviceLabel: '',
  videoWidth: 0,
  videoHeight: 0,
  canSwitch: false,
  torch: TORCH_OFF,
  stillCapture: false,
  message: null,
};

/** Output size for a capture: longest side <= maxDim, aspect preserved, never upscaled. */
export function computeCaptureSize(srcWidth: number, srcHeight: number, maxDim: number): { width: number; height: number } {
  const limit = Math.min(Math.max(1, Math.floor(maxDim)), MAX_ENCODED_SIDE);
  const scale = Math.min(1, limit / Math.max(srcWidth, srcHeight));
  return {
    width: Math.max(1, Math.min(limit, Math.round(srcWidth * scale))),
    height: Math.max(1, Math.min(limit, Math.round(srcHeight * scale))),
  };
}

/**
 * Video-only constraints, most specific first. 2560x1440 is tried first (sharper fallback stills and live frames);
 * 1920x1080, the previously verified Galaxy S25 path, stays the next option.
 */
export function constraintChain(pref: { deviceId?: string | null; facing?: CameraFacing; exactFacing?: boolean }): MediaStreamConstraints[] {
  const qhd = { width: { ideal: 2560 }, height: { ideal: 1440 } };
  const hd = { width: { ideal: 1920 }, height: { ideal: 1080 } };
  const chain: MediaStreamConstraints[] = [];
  if (pref.deviceId) {
    const deviceId = { exact: pref.deviceId };
    chain.push({ audio: false, video: { deviceId, ...qhd } }, { audio: false, video: { deviceId, ...hd } }, { audio: false, video: { deviceId } });
  }
  const facing = pref.facing === 'user' ? 'user' : 'environment';
  if (pref.exactFacing) {
    // Used by switchCamera: must actually change camera, so no generic {video:true} fallback here.
    chain.push(
      { audio: false, video: { facingMode: { exact: facing }, ...qhd } },
      { audio: false, video: { facingMode: { exact: facing }, ...hd } },
      { audio: false, video: { facingMode: { exact: facing } } },
    );
    return chain;
  }
  chain.push(
    { audio: false, video: { facingMode: { ideal: facing }, ...qhd } },
    { audio: false, video: { facingMode: { ideal: facing }, ...hd } },
    { audio: false, video: { facingMode: { ideal: facing } } },
    { audio: false, video: true },
  );
  return chain;
}

/** The constraint asks for more than 1920 px wide (some devices refuse such streams with NotReadableError). */
function isAboveHd(c: MediaStreamConstraints): boolean {
  const v = c.video;
  if (!v || typeof v !== 'object') return false;
  const w = v.width;
  return typeof w === 'object' && w !== null && typeof w.ideal === 'number' && w.ideal > 1920;
}

/**
 * takePhoto settings: the largest photo size whose longest side is <= maxDim (aspect of the largest size kept,
 * rounded down to the range step), or the largest size when it already fits. Flash is turned off when allowed
 * (flash glare hides print) unless the torch is on (changing fill light could switch the torch off).
 * undefined = call takePhoto() without settings.
 */
export function choosePhotoSettings(caps: PhotoCapabilities | null, maxDim: number, torchOn: boolean): PhotoSettings | undefined {
  const settings: PhotoSettings = {};
  const wr = caps?.imageWidth;
  const hr = caps?.imageHeight;
  if (wr?.max && hr?.max && wr.max > 0 && hr.max > 0) {
    const scale = Math.min(1, maxDim / Math.max(wr.max, hr.max));
    const fit = (r: MediaSettingsRange, v: number) => {
      const min = r.min ?? 1;
      const step = r.step && r.step > 0 ? r.step : 1;
      return Math.max(min, Math.min(r.max ?? v, min + Math.floor((v - min) / step) * step));
    };
    settings.imageWidth = fit(wr, Math.floor(wr.max * scale));
    settings.imageHeight = fit(hr, Math.floor(hr.max * scale));
  }
  if (!torchOn && caps?.fillLightMode?.includes('off')) settings.fillLightMode = 'off';
  return Object.keys(settings).length ? settings : undefined;
}

/**
 * Rotation that makes a still match the preview's orientation. createImageBitmap('from-image') already applies
 * EXIF orientation; if the photo still disagrees with the video (portrait vs landscape), its pixels are in sensor
 * orientation. Rear sensors on Android phones are mounted at 90 degrees (front at 270), so rotate by that.
 * Nearly square images are left alone. UNVERIFIED on the Galaxy S25.
 */
export function stillRotation(photoW: number, photoH: number, videoW: number, videoH: number, facing: CameraFacing): SurfaceRotation {
  if (!(photoW > 0 && photoH > 0 && videoW > 0 && videoH > 0)) return 0;
  const ratio = (a: number, b: number) => Math.max(a, b) / Math.min(a, b);
  if (ratio(photoW, photoH) < 1.05 || ratio(videoW, videoH) < 1.05) return 0;
  if (photoW > photoH === videoW > videoH) return 0;
  return facing === 'user' ? 270 : 90;
}

type TrackCaps = MediaTrackCapabilities & { torch?: boolean; focusMode?: string[] };

function trackCapabilities(track: MediaStreamTrack): TrackCaps {
  try {
    return typeof track.getCapabilities === 'function' ? (track.getCapabilities() as TrackCaps) : {};
  } catch {
    return {};
  }
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** The value, or null after ms. The underlying work cannot be cancelled; a late result is ignored. */
function withDeadline<T>(p: Promise<T>, ms: number): Promise<T | null> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => resolve(null), Math.max(0, ms));
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e: unknown) => {
        clearTimeout(t);
        reject(e instanceof Error ? e : new Error(String(e)));
      },
    );
  });
}

function defaultImageCaptureFactory(): ((track: MediaStreamTrack) => ImageCaptureLike) | null {
  const Ctor = (globalThis as { ImageCapture?: new (track: MediaStreamTrack) => ImageCaptureLike }).ImageCapture;
  return typeof Ctor === 'function' ? (track) => new Ctor(track) : null;
}

async function defaultDecodePhoto(blob: Blob): Promise<DecodedPhoto> {
  if (typeof createImageBitmap !== 'function') throw new Error('createImageBitmap unavailable');
  try {
    return await createImageBitmap(blob, { imageOrientation: 'from-image' });
  } catch {
    return createImageBitmap(blob); // engines that reject the option (current Chrome applies EXIF by default)
  }
}

function errorName(err: unknown): string {
  if (err && typeof err === 'object' && 'name' in err && typeof (err as { name: unknown }).name === 'string') {
    return (err as { name: string }).name;
  }
  return '';
}

/** Constraint/device mismatch: worth trying the next (looser) constraint. Never retry permission errors. */
function isRetryable(err: unknown): boolean {
  const n = errorName(err);
  return n === 'OverconstrainedError' || n === 'NotFoundError' || n === 'ConstraintNotSatisfiedError';
}

/** Map a getUserMedia failure (after fallbacks) to a status + short, actionable message. */
export function mapCameraError(err: unknown): { status: CameraStatus; message: string } {
  switch (errorName(err)) {
    case 'NotAllowedError':
    case 'PermissionDeniedError':
      return { status: 'denied', message: CAMERA_MESSAGES.denied };
    case 'SecurityError':
      return { status: 'denied', message: CAMERA_MESSAGES.blocked };
    case 'NotFoundError':
    case 'DevicesNotFoundError':
    case 'OverconstrainedError':
    case 'ConstraintNotSatisfiedError':
      return { status: 'unavailable', message: CAMERA_MESSAGES.unavailable };
    case 'NotReadableError':
    case 'TrackStartError':
    case 'AbortError':
      return { status: 'in_use', message: CAMERA_MESSAGES.inUse };
    default:
      return { status: 'error', message: CAMERA_MESSAGES.error };
  }
}

function facingFromTrack(track: MediaStreamTrack): CameraFacing {
  const f = typeof track.getSettings === 'function' ? track.getSettings().facingMode : undefined;
  return f === 'environment' || f === 'user' ? f : 'unknown';
}

function deviceIdFromTrack(track: MediaStreamTrack): string | null {
  const id = typeof track.getSettings === 'function' ? track.getSettings().deviceId : undefined;
  return id ? id : null;
}

function hasValidFrame(el: HTMLVideoElement): boolean {
  return el.videoWidth > 0 && el.videoHeight > 0 && el.readyState >= HAVE_CURRENT_DATA;
}

const VIDEO_EVENTS = ['loadedmetadata', 'loadeddata', 'resize', 'canplay', 'playing'] as const;

export function createCameraController(opts: CameraControllerOptions = {}): CameraController {
  const nav: Navigator | undefined = typeof navigator !== 'undefined' ? navigator : undefined;
  const md: MediaDevices | undefined = nav?.mediaDevices;
  const getUserMedia = opts.getUserMedia ?? (md?.getUserMedia ? md.getUserMedia.bind(md) : undefined);
  const enumerateDevices = opts.enumerateDevices ?? (md?.enumerateDevices ? md.enumerateDevices.bind(md) : undefined);
  const secure = opts.isSecureContext ?? (typeof window !== 'undefined' ? window.isSecureContext !== false : true);
  const now = opts.now ?? Date.now;
  const doc = opts.document ?? (typeof document !== 'undefined' ? document : undefined);
  const deviceEvents = opts.deviceEvents ?? md;
  const createSurface = opts.createSurface ?? createCanvasSurfaceFactory(doc);
  const readyTimeoutMs = opts.readyTimeoutMs ?? 1000;
  const createImageCapture = opts.createImageCapture === undefined ? defaultImageCaptureFactory() : opts.createImageCapture;
  const decodePhoto = opts.decodePhoto ?? defaultDecodePhoto;
  const stillTimeoutMs = opts.stillTimeoutMs ?? 2500;
  const stillFrameGapMs = opts.stillFrameGapMs ?? 120;

  let state: CameraState = INITIAL_STATE;
  const listeners = new Set<Listener>();

  let stream: MediaStream | null = null;
  let attached: HTMLVideoElement | null = null;
  // Detached element used as capture source when the UI has no preview mounted (preview hidden).
  let fallbackVideo: HTMLVideoElement | null = null;
  let boundVideo: HTMLVideoElement | null = null;
  /** Incremented whenever the current stream is invalidated (stop/pause/switch); stale async work bails. */
  let generation = 0;
  let frameCounter = 0;
  let lastDeviceId: string | null = null;
  let lastFacing: CameraFacing = 'environment';
  let devicechangeBound = false;
  /** ImageCapture for the current track, with its photo capabilities once fetched (undefined = not yet). */
  let imageCapture: { track: MediaStreamTrack; ic: ImageCaptureLike; caps: PhotoCapabilities | null | undefined } | null = null;
  /** Serialises captureStill() calls. */
  let stillQueue: Promise<unknown> = Promise.resolve();

  function setState(patch: Partial<CameraState>): void {
    if (patch.torch && patch.torch.supported === state.torch.supported && patch.torch.on === state.torch.on) {
      patch = { ...patch, torch: state.torch }; // keep the reference stable when nothing changed
    }
    let changed = false;
    for (const k of Object.keys(patch) as (keyof CameraState)[]) {
      if (state[k] !== patch[k]) changed = true;
    }
    if (!changed) return;
    state = { ...state, ...patch };
    for (const l of [...listeners]) l();
  }

  function activeTrack(): MediaStreamTrack | null {
    return stream?.getVideoTracks()[0] ?? null;
  }

  // ---- video element binding --------------------------------------------------------------

  const onVideoEvent = (): void => {
    const el = boundVideo;
    if (!el || !stream) return;
    if (el.videoWidth > 0 && el.videoHeight > 0) {
      // Android Chrome reports dimensions as displayed, so these swap on rotation ('resize').
      setState({ videoWidth: el.videoWidth, videoHeight: el.videoHeight });
    }
    // Some devices only report the torch capability once frames flow.
    const track = activeTrack();
    if (track && !state.torch.supported && trackCapabilities(track).torch === true) setState({ torch: { supported: true, on: false } });
  };

  function captureSource(): HTMLVideoElement | null {
    if (attached) return attached;
    if (!stream || !doc) return null;
    if (!fallbackVideo) fallbackVideo = doc.createElement('video');
    return fallbackVideo;
  }

  function unbindVideo(): void {
    const el = boundVideo;
    if (!el) return;
    for (const e of VIDEO_EVENTS) el.removeEventListener(e, onVideoEvent);
    el.srcObject = null;
    boundVideo = null;
  }

  /** Point the current capture source at the current stream (or detach everything if no stream). */
  function bindVideo(): void {
    const el = stream ? captureSource() : null;
    if (boundVideo && boundVideo !== el) unbindVideo();
    if (!el || !stream) {
      unbindVideo();
      return;
    }
    if (boundVideo !== el) {
      for (const e of VIDEO_EVENTS) el.addEventListener(e, onVideoEvent);
      boundVideo = el;
    }
    el.muted = true;
    el.playsInline = true;
    el.autoplay = true;
    // Rear camera must never be mirrored: we add no CSS transform and capture draws raw pixels.
    if (el.srcObject !== stream) el.srcObject = stream;
    try {
      const p = el.play() as Promise<void> | undefined;
      p?.catch(() => {
        /* autoplay of a muted inline video should succeed; if not, capture simply returns null */
      });
    } catch {
      /* jsdom / very old engines */
    }
    onVideoEvent();
  }

  // ---- stream lifecycle -------------------------------------------------------------------

  const onTrackEnded = (): void => {
    // Fires when the OS/browser ends the track (camera unplugged, permission revoked, taken by
    // another app). It does not fire for our own track.stop() calls.
    releaseStream();
    setState({ status: 'disconnected', message: CAMERA_MESSAGES.disconnected, videoWidth: 0, videoHeight: 0 });
  };

  function releaseStream(): void {
    generation++;
    const s = stream;
    stream = null;
    imageCapture = null;
    if (s) {
      for (const t of s.getTracks()) {
        t.removeEventListener('ended', onTrackEnded);
        t.stop();
      }
    }
    unbindVideo();
    // Stopping the track switches the torch off physically.
    setState({ torch: TORCH_OFF, stillCapture: false });
  }

  async function acquire(chain: MediaStreamConstraints[]): Promise<MediaStream> {
    if (!getUserMedia) throw Object.assign(new Error('getUserMedia unavailable'), { name: 'NotFoundError' });
    let lastErr: unknown = null;
    for (let i = 0; i < chain.length; i++) {
      const c = chain[i]!;
      try {
        return await getUserMedia(c);
      } catch (err) {
        lastErr = err;
        // A > 1080p request the device cannot open must not cost the user the camera: try the next size.
        const n = errorName(err);
        const hiResStartFailure = isAboveHd(c) && i < chain.length - 1 && (n === 'NotReadableError' || n === 'AbortError' || n === 'TrackStartError');
        if (!isRetryable(err) && !hiResStartFailure) throw err;
      }
    }
    throw lastErr;
  }

  async function videoInputs(): Promise<MediaDeviceInfo[]> {
    if (!enumerateDevices) return [];
    try {
      return (await enumerateDevices()).filter((d) => d.kind === 'videoinput');
    } catch {
      return [];
    }
  }

  const refreshDevices = async (): Promise<void> => {
    const inputs = await videoInputs();
    // Only meaningful after permission; before that Chrome may hide devices.
    if (stream) setState({ canSwitch: inputs.length > 1 });
  };

  const onDeviceChange = (): void => {
    void refreshDevices();
  };

  function bindDeviceChange(on: boolean): void {
    if (!deviceEvents || on === devicechangeBound) return;
    if (on) deviceEvents.addEventListener('devicechange', onDeviceChange);
    else deviceEvents.removeEventListener('devicechange', onDeviceChange);
    devicechangeBound = on;
  }

  /** Install a freshly acquired stream, unless it was superseded while pending. */
  function adopt(s: MediaStream, gen: number): boolean {
    if (gen !== generation) {
      for (const t of s.getTracks()) t.stop();
      return false;
    }
    stream = s;
    const track = s.getVideoTracks()[0];
    let facing: CameraFacing = 'unknown';
    if (track) {
      track.addEventListener('ended', onTrackEnded);
      lastDeviceId = deviceIdFromTrack(track);
      facing = facingFromTrack(track);
      if (facing !== 'unknown') lastFacing = facing;
    }
    // Any other (unexpected) tracks are stopped immediately so we never hold extra devices.
    for (const t of s.getTracks()) if (t !== track) t.stop();
    const caps: TrackCaps = track ? trackCapabilities(track) : {};
    if (track && caps.focusMode?.includes('continuous')) {
      // Best effort: keep refocusing as the user brings the pack closer.
      track.applyConstraints({ advanced: [{ focusMode: 'continuous' } as MediaTrackConstraintSet] }).catch(() => {});
    }
    imageCapture = null;
    if (track && createImageCapture) {
      try {
        imageCapture = { track, ic: createImageCapture(track), caps: undefined };
      } catch {
        imageCapture = null;
      }
    }
    setState({
      status: 'active',
      message: null,
      facing,
      deviceLabel: track?.label ?? '',
      videoWidth: 0,
      videoHeight: 0,
      torch: { supported: caps.torch === true, on: false },
      stillCapture: imageCapture !== null,
    });
    bindVideo();
    bindDeviceChange(true);
    void refreshDevices();
    return true;
  }

  async function open(chain: MediaStreamConstraints[], gen: number): Promise<void> {
    try {
      const s = await acquire(chain);
      adopt(s, gen);
    } catch (err) {
      if (gen !== generation) return; // stopped/paused meanwhile
      const m = mapCameraError(err);
      setState({ status: m.status, message: m.message, videoWidth: 0, videoHeight: 0 });
    }
  }

  function preflight(): boolean {
    if (!secure) {
      setState({ status: 'insecure_context', message: CAMERA_MESSAGES.insecure });
      return false;
    }
    if (!getUserMedia) {
      setState({ status: 'unavailable', message: CAMERA_MESSAGES.unsupported });
      return false;
    }
    return true;
  }

  // ---- capture ----------------------------------------------------------------------------

  function waitForFrame(el: HTMLVideoElement, timeoutMs: number): Promise<boolean> {
    if (hasValidFrame(el)) return Promise.resolve(true);
    if (timeoutMs <= 0) return Promise.resolve(false);
    return new Promise((resolve) => {
      const check = (): void => {
        if (hasValidFrame(el)) done(true);
      };
      const timer = setTimeout(() => done(false), timeoutMs);
      function done(ok: boolean): void {
        clearTimeout(timer);
        for (const e of VIDEO_EVENTS) el.removeEventListener(e, check);
        resolve(ok);
      }
      for (const e of VIDEO_EVENTS) el.addEventListener(e, check);
    });
  }

  /**
   * Encode a drawn surface into a CapturedFrame: quality stats on a small copy, JPEG within
   * LIMITS.maxFrameBase64Chars (one lower-quality retry), fresh frameId. null if too large or superseded.
   */
  async function finishFrame(
    surface: FrameSurface,
    size: { width: number; height: number },
    o: CaptureOptions,
    gen: number,
    capturedAtMs: number,
  ): Promise<CapturedFrame | null> {
    const jpegQuality = Math.min(1, Math.max(0.05, o.jpegQuality));
    // Assigned at draw time so ids follow capture order even when captures overlap.
    const frameId = ++frameCounter;
    let quality: FrameQuality | undefined;
    if (o.computeQuality !== false) {
      const small = surface.sample(ANALYSIS_MAX_SIDE);
      if (small) quality = computeFrameQuality(small);
    }
    let data = await surface.encodeJpeg(jpegQuality);
    if (data.length > LIMITS.maxFrameBase64Chars) {
      data = await surface.encodeJpeg(Math.max(0.3, jpegQuality * 0.6));
      if (data.length > LIMITS.maxFrameBase64Chars) return null;
    }
    // Session ended / backgrounded while encoding: never hand out a frame after stop or pause.
    if (gen !== generation || !data) return null;
    const frame: CapturedFrame = {
      frameId,
      capturedAt: Math.floor(capturedAtMs),
      width: size.width,
      height: size.height,
      mimeType: 'image/jpeg',
      data,
    };
    if (quality) frame.quality = quality;
    return frame;
  }

  async function capture(o: CaptureOptions): Promise<CapturedFrame | null> {
    if (state.status !== 'active' || !stream) return null;
    const gen = generation;
    const el = boundVideo;
    if (!el) return null;
    if (!(await waitForFrame(el, readyTimeoutMs))) return null;
    if (gen !== generation || state.status !== 'active' || boundVideo !== el) return null;

    const size = computeCaptureSize(el.videoWidth, el.videoHeight, o.maxDim);
    try {
      const surface = createSurface(size.width, size.height);
      surface.draw(el);
      return await finishFrame(surface, size, o, gen, now());
    } catch (err) {
      console.warn('camera capture failed', errorName(err) || String(err));
      return null;
    }
  }

  // ---- detail stills ----------------------------------------------------------------------

  /** ImageCapture.takePhoto path. null = unavailable / timed out / not better than video (caller falls back). */
  async function photoStill(o: CaptureOptions, gen: number): Promise<CapturedFrame | null> {
    const entry = imageCapture;
    const track = activeTrack();
    if (!entry || !track || entry.track !== track || track.readyState !== 'live') return null;
    const deadline = now() + stillTimeoutMs;
    if (entry.caps === undefined) {
      try {
        entry.caps = entry.ic.getPhotoCapabilities ? await withDeadline(entry.ic.getPhotoCapabilities(), stillTimeoutMs) : null;
      } catch {
        entry.caps = null;
      }
    }
    if (gen !== generation) return null;
    const torchWasOn = state.torch.on;
    const blob = await withDeadline(entry.ic.takePhoto(choosePhotoSettings(entry.caps ?? null, o.maxDim, torchWasOn)), deadline - now());
    const shotAt = now();
    if (torchWasOn && gen === generation) {
      // Some devices drop the torch after a still capture; re-assert it (harmless when it is still on).
      track.applyConstraints({ advanced: [{ torch: true } as MediaTrackConstraintSet] }).catch(() => {});
    }
    if (!blob || gen !== generation) return null;
    const photo = await decodePhoto(blob);
    try {
      if (gen !== generation) return null;
      const vw = boundVideo?.videoWidth ?? 0;
      const vh = boundVideo?.videoHeight ?? 0;
      const rotation = stillRotation(photo.width, photo.height, vw, vh, state.facing);
      const srcW = rotation ? photo.height : photo.width;
      const srcH = rotation ? photo.width : photo.height;
      if (!(srcW > 0 && srcH > 0)) return null;
      // A photo smaller than the video stream would lose detail: use video frames instead.
      if (Math.max(srcW, srcH) < Math.max(vw, vh)) return null;
      const size = computeCaptureSize(srcW, srcH, o.maxDim);
      const surface = createSurface(size.width, size.height);
      surface.draw(photo, rotation);
      return await finishFrame(surface, size, o, gen, shotAt);
    } finally {
      photo.close?.();
    }
  }

  /** Fallback: the sharpest of `bestOf` video frames ~stillFrameGapMs apart, at native video size (<= maxDim). */
  async function bestVideoStill(o: CaptureOptions & { bestOf?: number }, gen: number): Promise<CapturedFrame | null> {
    const el = boundVideo;
    if (!el) return null;
    if (!(await waitForFrame(el, readyTimeoutMs))) return null;
    const n = Math.max(1, Math.min(MAX_BEST_OF, Math.floor(o.bestOf ?? LIMITS.detailBestOf)));
    let best: { surface: FrameSurface; size: { width: number; height: number }; score: number; at: number } | null = null;
    for (let i = 0; i < n; i++) {
      if (i > 0) await sleep(stillFrameGapMs);
      if (gen !== generation || boundVideo !== el || state.status !== 'active') return null;
      if (!hasValidFrame(el)) break;
      const size = computeCaptureSize(el.videoWidth, el.videoHeight, o.maxDim);
      const surface = createSurface(size.width, size.height);
      surface.draw(el);
      const at = now();
      const sample = surface.sample(STILL_SHARPNESS_SAMPLE_SIDE);
      const score = sample ? laplacianVariance(toGrayscale(sample, STILL_SHARPNESS_SAMPLE_SIDE)) : 0;
      if (!best || score > best.score) best = { surface, size, score, at };
      if (!sample) break; // frames cannot be compared: the first one will do
    }
    if (!best) return null;
    return finishFrame(best.surface, best.size, o, gen, best.at);
  }

  async function runCaptureStill(o: CaptureOptions & { bestOf?: number }): Promise<CapturedFrame | null> {
    if (state.status !== 'active' || !stream) return null;
    const gen = generation;
    let frame: CapturedFrame | null = null;
    try {
      frame = await photoStill(o, gen);
    } catch (err) {
      console.warn('camera still photo failed, using video frames', errorName(err) || String(err));
    }
    if (frame || gen !== generation) return frame;
    try {
      return await bestVideoStill(o, gen);
    } catch (err) {
      console.warn('camera still capture failed', errorName(err) || String(err));
      return null;
    }
  }

  function captureStill(o: CaptureOptions & { bestOf?: number }): Promise<CapturedFrame | null> {
    // One at a time: a second call waits for the first, then takes its own fresh still.
    const run = stillQueue.then(() => runCaptureStill(o));
    stillQueue = run.catch(() => null);
    return run;
  }

  async function setTorch(on: boolean): Promise<boolean> {
    const track = activeTrack();
    if (state.status !== 'active' || !track || !state.torch.supported) return false;
    const gen = generation;
    try {
      await track.applyConstraints({ advanced: [{ torch: on } as MediaTrackConstraintSet] });
    } catch (err) {
      console.warn('torch change refused', errorName(err) || String(err));
      return false;
    }
    if (gen !== generation || activeTrack() !== track) return false;
    setState({ torch: { supported: true, on } });
    return true;
  }

  // ---- public API -------------------------------------------------------------------------

  return {
    getState: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    attachVideo(el) {
      if (el === attached) return;
      attached = el;
      bindVideo(); // rebinds the stream to `el`, or to the detached fallback element when el is null
    },

    async start() {
      if (state.status === 'active' || state.status === 'requesting') return;
      if (!preflight()) return;
      const gen = ++generation;
      setState({ status: 'requesting', message: null });
      await open(constraintChain({ facing: 'environment' }), gen);
    },

    stop() {
      releaseStream();
      bindDeviceChange(false);
      fallbackVideo = null;
      setState({ status: 'stopped', message: null, videoWidth: 0, videoHeight: 0, canSwitch: false });
    },

    async switchCamera() {
      if (state.status !== 'active' || !stream) return;
      const prevDeviceId = lastDeviceId;
      const prevFacing = state.facing;
      const inputs = await videoInputs();
      if (state.status !== 'active') return;

      // Stop the old track BEFORE opening another camera: many Android devices cannot open two
      // cameras at once and would report NotReadableError.
      releaseStream();
      const gen = ++generation;
      setState({ status: 'requesting', message: null, videoWidth: 0, videoHeight: 0 });

      const chains: MediaStreamConstraints[][] = [];
      if (prevFacing === 'environment' || prevFacing === 'user') {
        chains.push(constraintChain({ facing: prevFacing === 'environment' ? 'user' : 'environment', exactFacing: true }));
      }
      const ids = inputs.map((d) => d.deviceId).filter(Boolean);
      if (ids.length > 1) {
        const idx = prevDeviceId ? ids.indexOf(prevDeviceId) : -1;
        const next = ids[(idx + 1) % ids.length];
        if (next && next !== prevDeviceId) chains.push([{ audio: false, video: { deviceId: { exact: next } } }]);
      }
      for (const chain of chains) {
        try {
          const s = await acquire(chain);
          adopt(s, gen);
          return;
        } catch (err) {
          if (gen !== generation) return;
          if (!isRetryable(err)) {
            const m = mapCameraError(err);
            setState({ status: m.status, message: m.message });
            return;
          }
        }
      }
      // Nothing else matched: restore the previous camera so the user is not left without one.
      await open(constraintChain({ deviceId: prevDeviceId, facing: prevFacing }), gen);
    },

    pause(message?: string) {
      if (state.status !== 'active' && state.status !== 'requesting') return;
      releaseStream(); // also invalidates a pending start
      setState({ status: 'paused', message: message ?? CAMERA_MESSAGES.paused, videoWidth: 0, videoHeight: 0 });
    },

    async resume() {
      if (state.status !== 'paused') return;
      if (!preflight()) return;
      const gen = ++generation;
      setState({ status: 'requesting', message: null });
      await open(constraintChain({ deviceId: lastDeviceId, facing: lastFacing }), gen);
    },

    capture,
    captureStill,
    setTorch,
  };
}
