/**
 * HTTP client for the optional private local object detector (services/detector, Ultralytics YOLO, COCO
 * classes), plus the per-session latest-frame scheduler that feeds it.
 *
 *  - Disabled when config.detectorUrl is null: detect() -> null, health() -> 'disabled'.
 *  - One request in flight; concurrent calls return null immediately ('busy').
 *  - At most one request per LIMITS.detectionMinIntervalMs; each request times out after ~1.5 s.
 *  - Responses are validated with zod; results for another frameId are rejected; boxes below
 *    MIN_SCORE (0.30, the tracker's low-score floor) are dropped; at most LIMITS.maxDetections are returned.
 *    Boxes are never invented.
 *  - After FAILURE_THRESHOLD consecutive failures the client pauses for COOLDOWN_MS and logs once.
 *  - detectWithOutcome() reports WHY there is no result (busy / cooldown / failed / aborted / disabled) so the
 *    find flow can tell "skip this frame" from "the detector is broken".
 *
 * createDetectScheduler (one per session): one inference in flight, a single latest-pending frame slot (a newer
 * frame replaces the pending one; old frames are never queued), the minimum interval respected by delaying the
 * pending frame instead of letting the detector refuse it, and results for frameId <= the last delivered one
 * rejected.
 */
import { z } from 'zod';
import { LIMITS, ServerDetections, type FramePayload } from '../../shared/protocol.js';
import type { AppConfig } from '../config.js';
import type { DetectorService, Logger } from '../contracts.js';

export const DETECTOR_DEFAULTS = {
  requestTimeoutMs: 1_500,
  healthTimeoutMs: 1_000,
  minIntervalMs: LIMITS.detectionMinIntervalMs,
  minScore: 0.3,
  failureThreshold: 3,
  cooldownMs: 30_000,
} as const;

export type DetectorOptions = Partial<{ -readonly [K in keyof typeof DETECTOR_DEFAULTS]: number }>;

const DetectorResponse = z.object({
  frameId: z.number().int().nonnegative(),
  model: z.string().min(1).max(100).optional(),
  detections: z
    .array(
      z.object({
        label: z.string().min(1).max(80),
        score: z.number().min(0).max(1),
        box: z.object({ x: z.number().min(0).max(1), y: z.number().min(0).max(1), w: z.number().min(0).max(1), h: z.number().min(0).max(1) }),
      }),
    )
    .max(1_000),
});

const HealthBody = z.object({ ok: z.literal(true), model: z.string().max(100).optional() });

/**
 * True when `next` should replace `prev` in an overlay: frameIds are per-session monotonic, so only a strictly
 * larger frameId is newer. Equal or older frames (late responses) are ignored.
 */
export function isNewerDetection(prev: Pick<ServerDetections, 'frameId'> | null | undefined, next: Pick<ServerDetections, 'frameId'>): boolean {
  return !prev || next.frameId > prev.frameId;
}

/** Why a detect call produced (or did not produce) a result. */
export type DetectOutcome =
  | { kind: 'ok'; result: ServerDetections }
  /** Another request in flight or the minimum interval not elapsed: skip, not a failure. */
  | { kind: 'busy' }
  /** Paused after repeated failures. */
  | { kind: 'cooldown' }
  | { kind: 'disabled' }
  | { kind: 'aborted' }
  /** HTTP error, timeout, unreachable or invalid response. */
  | { kind: 'failed'; reason: string };

/** The real detector also reports outcomes; fakes implementing only DetectorService are adapted. */
export interface DetailedDetectorService extends DetectorService {
  detectWithOutcome(frame: FramePayload, signal?: AbortSignal): Promise<DetectOutcome>;
}

function hasOutcome(d: DetectorService): d is DetailedDetectorService {
  return typeof (d as Partial<DetailedDetectorService>).detectWithOutcome === 'function';
}

/** Outcome-reporting detect for any DetectorService (plain ones: null / throw = failed). */
export async function detectWithOutcome(d: DetectorService, frame: FramePayload, signal?: AbortSignal): Promise<DetectOutcome> {
  if (hasOutcome(d)) return d.detectWithOutcome(frame, signal);
  if (!d.enabled) return { kind: 'disabled' };
  try {
    const result = await d.detect(frame, signal);
    if (signal?.aborted) return { kind: 'aborted' };
    return result ? { kind: 'ok', result } : { kind: 'failed', reason: 'no_result' };
  } catch {
    return signal?.aborted ? { kind: 'aborted' } : { kind: 'failed', reason: 'threw' };
  }
}

class DetectorFailure extends Error {}

export function createDetector(deps: {
  config: AppConfig;
  log: Logger;
  /** Injected for tests. Defaults to global fetch. */
  fetch?: typeof fetch;
  /** Epoch ms clock, injected for tests. */
  now?: () => number;
  options?: DetectorOptions;
}): DetailedDetectorService {
  const { config, log } = deps;
  const baseUrl = config.detectorUrl?.replace(/\/+$/, '') ?? null;
  if (!baseUrl) {
    return {
      enabled: false,
      model: 'none',
      detect: () => Promise.resolve(null),
      detectWithOutcome: () => Promise.resolve({ kind: 'disabled' }),
      health: () => Promise.resolve('disabled'),
    };
  }
  const doFetch = deps.fetch ?? ((...args: Parameters<typeof fetch>) => fetch(...args));
  const now = deps.now ?? Date.now;
  const opts = { ...DETECTOR_DEFAULTS, ...deps.options };

  let model = 'yolo';
  let inFlight = false;
  let lastStartedAt = -Infinity;
  let consecutiveFailures = 0;
  let cooldownUntil = 0;
  let coolingLogged = false;

  const recordFailure = (reason: string) => {
    consecutiveFailures++;
    if (consecutiveFailures >= opts.failureThreshold) {
      cooldownUntil = now() + opts.cooldownMs;
      consecutiveFailures = 0;
      if (!coolingLogged) {
        coolingLogged = true;
        log.warn('detector_cooldown', { reason, cooldownMs: opts.cooldownMs, failures: opts.failureThreshold });
      }
    }
  };

  const recordSuccess = () => {
    if (coolingLogged) log.info('detector_recovered', { model });
    consecutiveFailures = 0;
    coolingLogged = false;
  };

  async function run(frame: FramePayload, signal?: AbortSignal): Promise<DetectOutcome> {
    const t = now();
    if (signal?.aborted) return { kind: 'aborted' };
    if (t < cooldownUntil) return { kind: 'cooldown' };
    if (inFlight || t - lastStartedAt < opts.minIntervalMs) return { kind: 'busy' };
    inFlight = true;
    lastStartedAt = t;
    const timeout = AbortSignal.timeout(opts.requestTimeoutMs);
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
    try {
      const res = await doFetch(`${baseUrl}/detect`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ frameId: frame.frameId, capturedAt: frame.capturedAt, width: frame.width, height: frame.height, image: frame.data }),
        signal: combined,
      });
      if (!res.ok) throw new DetectorFailure(`http_${res.status}`);
      let body: unknown;
      try {
        body = await res.json();
      } catch {
        throw new DetectorFailure('invalid_json');
      }
      const parsed = DetectorResponse.safeParse(body);
      if (!parsed.success) throw new DetectorFailure('invalid_response');
      if (parsed.data.frameId !== frame.frameId) throw new DetectorFailure('frame_mismatch');
      if (parsed.data.model) model = parsed.data.model;

      const detections = parsed.data.detections
        .filter((d) => d.score >= opts.minScore)
        .sort((a, b) => b.score - a.score)
        .slice(0, LIMITS.maxDetections)
        .map((d) => ({
          label: d.label,
          score: d.score,
          box: { x: d.box.x, y: d.box.y, w: Math.min(d.box.w, 1 - d.box.x), h: Math.min(d.box.h, 1 - d.box.y) },
        }));
      const result = ServerDetections.parse({
        type: 'detections',
        frameId: frame.frameId,
        capturedAt: frame.capturedAt,
        sourceWidth: frame.width,
        sourceHeight: frame.height,
        detectedAt: now(),
        model,
        detections,
      });
      recordSuccess();
      return { kind: 'ok', result };
    } catch (err) {
      if (signal?.aborted) return { kind: 'aborted' }; // caller cancelled: not a detector failure
      const reason = err instanceof DetectorFailure ? err.message : timeout.aborted ? 'timeout' : 'unreachable';
      log.warn('detector_error', { reason, frameId: frame.frameId });
      recordFailure(reason);
      return { kind: 'failed', reason };
    } finally {
      inFlight = false;
    }
  }

  async function health(): Promise<'ok' | 'unreachable'> {
    try {
      const res = await doFetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(opts.healthTimeoutMs) });
      if (!res.ok) return 'unreachable';
      const parsed = HealthBody.safeParse(await res.json());
      if (!parsed.success) return 'unreachable';
      if (parsed.data.model) model = parsed.data.model;
      return 'ok';
    } catch {
      return 'unreachable';
    }
  }

  return {
    enabled: true,
    get model() {
      return model;
    },
    detect: (frame, signal) => run(frame, signal).then((o) => (o.kind === 'ok' ? o.result : null)),
    detectWithOutcome: run,
    health,
  };
}

// ---------------------------------------------------------------------------
// Latest-frame scheduler (one per session)
// ---------------------------------------------------------------------------

export interface DetectSchedulerStats {
  submitted: number;
  /** Pending frames replaced by a newer one before they ran. */
  replaced: number;
  /** Frames rejected on submit because their frameId was not newer than the last submitted one. */
  outOfOrder: number;
  runs: number;
  ok: number;
  failed: number;
  busy: number;
  /** Results discarded because a newer frame's result was already delivered. */
  lateResults: number;
  latencyMsTotal: number;
  latencyMsMax: number;
}

export interface DetectScheduler {
  /** Offer a frame. It runs now if idle, else it becomes the single pending frame (replacing an older one). */
  submit(frame: FramePayload): void;
  /** Drop the pending frame, abort the in-flight call and clear timers. Its late result is never delivered. */
  cancel(): void;
  readonly inFlight: boolean;
  readonly hasPending: boolean;
  readonly stats: Readonly<DetectSchedulerStats>;
}

export interface DetectSchedulerDeps {
  detector: DetectorService;
  /** A result for a frame newer than any delivered before. */
  onResult(result: ServerDetections, frame: FramePayload, latencyMs: number): void;
  /** The detector could not produce a result for this frame ('failed', 'cooldown' or 'disabled'). */
  onFailure(kind: 'failed' | 'cooldown' | 'disabled', frame: FramePayload): void;
  /** Minimum gap between call starts (matches the detector's own guard). */
  minIntervalMs?: number;
  /** Retry delay when the shared detector is busy with another session. */
  busyRetryMs?: number;
  now?: () => number;
}

export function createDetectScheduler(deps: DetectSchedulerDeps): DetectScheduler {
  const minIntervalMs = deps.minIntervalMs ?? DETECTOR_DEFAULTS.minIntervalMs;
  const busyRetryMs = deps.busyRetryMs ?? 50;
  const now = deps.now ?? Date.now;
  const stats: DetectSchedulerStats = {
    submitted: 0,
    replaced: 0,
    outOfOrder: 0,
    runs: 0,
    ok: 0,
    failed: 0,
    busy: 0,
    lateResults: 0,
    latencyMsTotal: 0,
    latencyMsMax: 0,
  };
  let pending: FramePayload | null = null;
  let running: AbortController | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let lastSubmittedId = -1;
  let lastDeliveredId = -1;
  let lastStartedAt = Number.NEGATIVE_INFINITY;
  let generation = 0;

  /** A consumer bug must never stall the scheduler (the next frame still runs). */
  const safely = (fn: () => void) => {
    try {
      fn();
    } catch {
      /* swallowed: the session logs its own failures */
    }
  };

  const clearTimer = () => {
    if (timer) clearTimeout(timer);
    timer = null;
  };

  const arm = (ms: number) => {
    clearTimer();
    timer = setTimeout(() => {
      timer = null;
      pump();
    }, Math.max(0, ms));
  };

  function pump() {
    if (running || !pending) return;
    const wait = lastStartedAt + minIntervalMs - now();
    if (wait > 0) {
      if (!timer) arm(wait);
      return;
    }
    clearTimer();
    const frame = pending;
    pending = null;
    const ac = new AbortController();
    const gen = generation;
    running = ac;
    lastStartedAt = now();
    stats.runs++;
    const started = now();
    void detectWithOutcome(deps.detector, frame, ac.signal).then((outcome) => {
      if (gen !== generation) return; // cancelled meanwhile: never deliver
      running = null;
      const latency = Math.max(0, now() - started);
      switch (outcome.kind) {
        case 'ok':
          stats.ok++;
          stats.latencyMsTotal += latency;
          stats.latencyMsMax = Math.max(stats.latencyMsMax, latency);
          if (outcome.result.frameId <= lastDeliveredId) stats.lateResults++;
          else {
            lastDeliveredId = outcome.result.frameId;
            safely(() => deps.onResult(outcome.result, frame, latency));
          }
          break;
        case 'busy':
          stats.busy++;
          // Another session holds the shared detector: retry this frame shortly unless a newer one arrived.
          if (!pending) pending = frame;
          arm(busyRetryMs);
          return;
        case 'aborted':
          break;
        default:
          stats.failed++;
          safely(() => deps.onFailure(outcome.kind, frame));
      }
      pump();
    });
  }

  return {
    submit(frame) {
      if (frame.frameId <= lastSubmittedId) {
        stats.outOfOrder++;
        return;
      }
      lastSubmittedId = frame.frameId;
      stats.submitted++;
      if (pending) stats.replaced++;
      pending = frame;
      pump();
    },
    cancel() {
      generation++;
      if (pending) stats.replaced++;
      pending = null;
      clearTimer();
      running?.abort();
      running = null;
    },
    get inFlight() {
      return running !== null;
    },
    get hasPending() {
      return pending !== null;
    },
    stats,
  };
}
