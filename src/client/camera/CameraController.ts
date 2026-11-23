/**
 * Rear-camera controller for Sightline (phone Chrome). Implements the lead-owned CameraController
 * contract: permission + error mapping, rear preference with constraint fallbacks, pause/resume to
 * release the camera while backgrounded, and un-mirrored JPEG capture with bounded size.
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
import { ANALYSIS_MAX_SIDE, computeFrameQuality } from './frameQuality.js';
import { createCanvasSurfaceFactory, type SurfaceFactory } from './surface.js';

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
}

const HAVE_CURRENT_DATA = 2; // HTMLMediaElement.HAVE_CURRENT_DATA (literal so it works outside the DOM)
const MAX_ENCODED_SIDE = 8192; // FrameMeta width/height upper bound

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

const INITIAL_STATE: CameraState = {
  status: 'idle',
  facing: 'unknown',
  deviceLabel: '',
  videoWidth: 0,
  videoHeight: 0,
  canSwitch: false,
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

/** Video-only constraints, most specific first. */
export function constraintChain(pref: { deviceId?: string | null; facing?: CameraFacing; exactFacing?: boolean }): MediaStreamConstraints[] {
  const hd = { width: { ideal: 1920 }, height: { ideal: 1080 } };
  const chain: MediaStreamConstraints[] = [];
  if (pref.deviceId) {
    const deviceId = { exact: pref.deviceId };
    chain.push({ audio: false, video: { deviceId, ...hd } }, { audio: false, video: { deviceId } });
  }
  const facing = pref.facing === 'user' ? 'user' : 'environment';
  if (pref.exactFacing) {
    // Used by switchCamera: must actually change camera, so no generic {video:true} fallback here.
    chain.push({ audio: false, video: { facingMode: { exact: facing }, ...hd } }, { audio: false, video: { facingMode: { exact: facing } } });
    return chain;
  }
  chain.push(
    { audio: false, video: { facingMode: { ideal: facing }, ...hd } },
    { audio: false, video: { facingMode: { ideal: facing } } },
    { audio: false, video: true },
  );
  return chain;
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

  function setState(patch: Partial<CameraState>): void {
    let changed = false;
    for (const k of Object.keys(patch) as (keyof CameraState)[]) {
      if (state[k] !== patch[k]) changed = true;
    }
    if (!changed) return;
    state = { ...state, ...patch };
    for (const l of [...listeners]) l();
  }

  // ---- video element binding --------------------------------------------------------------

  const onVideoEvent = (): void => {
    const el = boundVideo;
    if (!el || !stream) return;
    if (el.videoWidth > 0 && el.videoHeight > 0) {
      // Android Chrome reports dimensions as displayed, so these swap on rotation ('resize').
      setState({ videoWidth: el.videoWidth, videoHeight: el.videoHeight });
    }
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
    if (s) {
      for (const t of s.getTracks()) {
        t.removeEventListener('ended', onTrackEnded);
        t.stop();
      }
    }
    unbindVideo();
  }

  async function acquire(chain: MediaStreamConstraints[]): Promise<MediaStream> {
    if (!getUserMedia) throw Object.assign(new Error('getUserMedia unavailable'), { name: 'NotFoundError' });
    let lastErr: unknown = null;
    for (const c of chain) {
      try {
        return await getUserMedia(c);
      } catch (err) {
        lastErr = err;
        if (!isRetryable(err)) throw err;
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
    setState({ status: 'active', message: null, facing, deviceLabel: track?.label ?? '', videoWidth: 0, videoHeight: 0 });
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

  async function capture(o: CaptureOptions): Promise<CapturedFrame | null> {
    if (state.status !== 'active' || !stream) return null;
    const gen = generation;
    const el = boundVideo;
    if (!el) return null;
    if (!(await waitForFrame(el, readyTimeoutMs))) return null;
    if (gen !== generation || state.status !== 'active' || boundVideo !== el) return null;

    const { width, height } = computeCaptureSize(el.videoWidth, el.videoHeight, o.maxDim);
    const jpegQuality = Math.min(1, Math.max(0.05, o.jpegQuality));
    try {
      const surface = createSurface(width, height);
      surface.draw(el);
      const capturedAt = Math.floor(now());
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
      const frame: CapturedFrame = { frameId, capturedAt, width, height, mimeType: 'image/jpeg', data };
      if (quality) frame.quality = quality;
      return frame;
    } catch (err) {
      console.warn('camera capture failed', errorName(err) || String(err));
      return null;
    }
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

    pause() {
      if (state.status !== 'active' && state.status !== 'requesting') return;
      releaseStream(); // also invalidates a pending start
      setState({ status: 'paused', message: CAMERA_MESSAGES.paused, videoWidth: 0, videoHeight: 0 });
    },

    async resume() {
      if (state.status !== 'paused') return;
      if (!preflight()) return;
      const gen = ++generation;
      setState({ status: 'requesting', message: null });
      await open(constraintChain({ deviceId: lastDeviceId, facing: lastFacing }), gen);
    },

    capture,
  };
}
