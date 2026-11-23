/**
 * HTTP client for the optional private local object detector (services/detector, Ultralytics YOLO, COCO
 * classes). OWNER: vision agent.
 *
 *  - Disabled when config.detectorUrl is null: detect() -> null, health() -> 'disabled'.
 *  - One request in flight; concurrent calls return null immediately (frames are simply skipped).
 *  - At most one request per LIMITS.detectionMinIntervalMs; each request times out after ~1.5 s.
 *  - Responses are validated with zod; results for another frameId are rejected; boxes below
 *    MIN_SCORE are dropped; at most LIMITS.maxDetections are returned. Boxes are never invented.
 *  - After FAILURE_THRESHOLD consecutive failures the client pauses for COOLDOWN_MS and logs once.
 */
import { z } from 'zod';
import { LIMITS, ServerDetections, type FramePayload } from '../../shared/protocol.js';
import type { AppConfig } from '../config.js';
import type { DetectorService, Logger } from '../contracts.js';

export const DETECTOR_DEFAULTS = {
  requestTimeoutMs: 1_500,
  healthTimeoutMs: 1_000,
  minIntervalMs: LIMITS.detectionMinIntervalMs,
  minScore: 0.35,
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

class DetectorFailure extends Error {}

export function createDetector(deps: {
  config: AppConfig;
  log: Logger;
  /** Injected for tests. Defaults to global fetch. */
  fetch?: typeof fetch;
  /** Epoch ms clock, injected for tests. */
  now?: () => number;
  options?: DetectorOptions;
}): DetectorService {
  const { config, log } = deps;
  const baseUrl = config.detectorUrl?.replace(/\/+$/, '') ?? null;
  if (!baseUrl) {
    return { enabled: false, model: 'none', detect: () => Promise.resolve(null), health: () => Promise.resolve('disabled') };
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

  async function detect(frame: FramePayload, signal?: AbortSignal): Promise<ServerDetections | null> {
    const t = now();
    if (inFlight || t < cooldownUntil || t - lastStartedAt < opts.minIntervalMs || signal?.aborted) return null;
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
      return result;
    } catch (err) {
      if (signal?.aborted) return null; // caller cancelled: not a detector failure
      const reason = err instanceof DetectorFailure ? err.message : timeout.aborted ? 'timeout' : 'unreachable';
      log.warn('detector_error', { reason, frameId: frame.frameId });
      recordFailure(reason);
      return null;
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
    detect,
    health,
  };
}
