/**
 * Ambient frame sampler for the Live session.
 *
 * Gemini Live accepts JPEG frames at up to 1 FPS, so the interval is clamped to
 * LIMITS.liveFrameMinIntervalMs. There is a single latest-frame slot and no queue: ticks are
 * scheduled with chained setTimeout at a fixed cadence, and a tick that fires while the previous
 * capture is still encoding is skipped (counted in droppedCount) rather than queued.
 */
import type { CameraController, CapturedFrame, FrameSampler } from '../contracts.js';
import { LIMITS } from '../../shared/protocol.js';

export interface FrameSamplerOptions {
  intervalMs: number;
  maxDim: number;
  jpegQuality: number;
}

export interface FrameSamplerDeps {
  /** Visibility source; defaults to the global document. Missing document = treated as visible. */
  document?: Pick<Document, 'visibilityState'>;
  /** Epoch-ms clock used to keep restarts from sampling faster than the interval. */
  now?: () => number;
}

export function createFrameSampler(
  camera: CameraController,
  opts: FrameSamplerOptions,
  deps: FrameSamplerDeps = {},
): FrameSampler {
  const intervalMs = Math.max(LIMITS.liveFrameMinIntervalMs, Number.isFinite(opts.intervalMs) ? opts.intervalMs : 0);
  const now = deps.now ?? (() => Date.now());
  const doc = deps.document ?? (typeof document !== 'undefined' ? document : undefined);

  let timer: ReturnType<typeof setTimeout> | null = null;
  let onFrame: ((frame: CapturedFrame) => void) | null = null;
  let inFlight = false;
  let latest: CapturedFrame | null = null;
  let dropped = 0;
  let lastCaptureStart = Number.NEGATIVE_INFINITY;
  /** Bumped by stop() so a capture that resolves afterwards is discarded. */
  let generation = 0;

  const canCapture = (): boolean =>
    camera.getState().status === 'active' && (doc ? doc.visibilityState === 'visible' : true);

  function schedule(delay: number): void {
    timer = setTimeout(tick, Math.max(0, delay));
  }

  function tick(): void {
    // Fixed cadence: schedule the next tick before doing work so a slow encode never shortens or
    // stacks intervals; overlapping ticks are skipped below instead.
    schedule(intervalMs);
    if (inFlight) {
      dropped++;
      return;
    }
    if (!canCapture()) return;
    inFlight = true;
    lastCaptureStart = now();
    const gen = generation;
    camera
      .capture({ maxDim: opts.maxDim, jpegQuality: opts.jpegQuality })
      .then((frame) => {
        if (gen !== generation || !frame) return;
        latest = frame;
        onFrame?.(frame);
      })
      .catch((err: unknown) => {
        console.warn('frame sampler: capture or delivery failed', err instanceof Error ? err.name : String(err));
      })
      .finally(() => {
        // Not generation-gated: a capture still encoding across stop()/start() must keep blocking
        // new captures until it actually finishes, so captures never overlap.
        inFlight = false;
      });
  }

  return {
    start(cb) {
      onFrame = cb;
      if (timer !== null) return; // already running; just swap the callback
      // A stop()/start() cycle must not sample faster than the interval either.
      const sinceLast = now() - lastCaptureStart;
      schedule(sinceLast >= intervalMs ? 0 : intervalMs - sinceLast);
    },
    stop() {
      if (timer !== null) clearTimeout(timer);
      timer = null;
      onFrame = null;
      generation++;
      latest = null; // nothing captured before stop may be sent afterwards
    },
    latest: () => latest,
    get droppedCount() {
      return dropped;
    },
  };
}
