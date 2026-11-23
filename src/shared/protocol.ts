/**
 * Sightline shared message contract (browser <-> Node backend over one same-origin WebSocket, path /ws).
 *
 * OWNER: lead. Workers must request changes rather than edit this file.
 *
 * Design rules:
 *  - Every message is JSON with a `type` discriminator and is validated with zod on receipt.
 *  - Binary media travels as base64 strings with explicit, bounded sizes.
 *  - Application control/state (turns, tools, evidence, errors) is carried in explicit
 *    events, never inferred from model prose.
 *  - IDs: frameId is a per-session monotonically increasing integer assigned by the client.
 *    turnId is a per-session monotonically increasing integer assigned by the server.
 *    requestId is a client- or server-generated opaque string (<= 64 chars).
 */
import { z } from 'zod';

export const PROTOCOL_VERSION = 1 as const;
export const WS_PATH = '/ws' as const;

/** Audio formats required by the Gemini Live API (verified against @google/genai 3.6.1 docs, 2026-11-23). */
export const INPUT_SAMPLE_RATE = 16_000; // PCM16 little-endian mono, mimeType 'audio/pcm;rate=16000'
export const OUTPUT_SAMPLE_RATE = 24_000; // PCM16 little-endian mono from the model
export const INPUT_AUDIO_MIME = `audio/pcm;rate=${INPUT_SAMPLE_RATE}` as const;

export const LIMITS = {
  /** ws maxPayload on the server. A 1600px JPEG at q0.85 is typically 200-600 KB (base64 ~ x1.34). */
  maxWsMessageBytes: 2_500_000,
  maxFrameBase64Chars: 2_000_000,
  /** ~1 s of 16 kHz PCM16 is 32 000 bytes -> 42 668 base64 chars. Allow up to ~1.5 s per chunk. */
  maxAudioChunkBase64Chars: 64_000,
  maxTextChars: 2_000,
  maxRequestIdChars: 64,
  /** Live API: images are JPEG at up to 1 FPS. Never send ambient frames faster than this. */
  liveFrameMinIntervalMs: 1_000,
  /** Longest side of ambient frames streamed to Live. */
  liveFrameMaxDim: 768,
  /** Longest side of high-resolution inspection snapshots (label reading / look again / snapshot mode). */
  snapshotMaxDim: 1_600,
  liveFrameJpegQuality: 0.7,
  snapshotJpegQuality: 0.85,
  /** A frame older than this is not used to answer a fresh question; a new capture is required. */
  frameMaxAgeMs: 2_500,
  /** Server waits this long for the client to answer a snapshot.request. */
  snapshotRequestTimeoutMs: 8_000,
  /** Detection results older than this are cleared from overlays. */
  detectionTtlMs: 2_500,
  detectionMinIntervalMs: 1_000,
  maxDetections: 50,
  maxTranscriptEntries: 200,
  maxClientReconnectAttempts: 5,
  /** Max inbound audio chunks per second before the server drops input (abuse guard). */
  maxAudioChunksPerSecond: 50,
} as const;

// ---------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------

const base64 = (max: number) =>
  z
    .string()
    .min(1)
    .max(max)
    .regex(/^[A-Za-z0-9+/]+={0,2}$/, 'must be base64 without a data: prefix');

export const RequestId = z.string().min(1).max(LIMITS.maxRequestIdChars).regex(/^[A-Za-z0-9_.:-]+$/);
export type RequestId = z.infer<typeof RequestId>;

/** Optional cheap client-side image statistics. Only these may justify saying "too dark"/"blurry". */
export const FrameQuality = z.object({
  /** Mean luma 0..255 on a downscaled copy. */
  meanLuma: z.number().min(0).max(255),
  /** Variance of a Laplacian on a downscaled grayscale copy; higher = sharper. Device-dependent scale. */
  sharpness: z.number().min(0),
});
export type FrameQuality = z.infer<typeof FrameQuality>;

export const FrameMeta = z.object({
  frameId: z.number().int().nonnegative(),
  /** Client epoch milliseconds (Date.now()) at capture time. */
  capturedAt: z.number().int().positive(),
  /** Pixel dimensions of the encoded JPEG (already rotated as displayed; never mirrored). */
  width: z.number().int().positive().max(8192),
  height: z.number().int().positive().max(8192),
  mimeType: z.literal('image/jpeg'),
  quality: FrameQuality.optional(),
});
export type FrameMeta = z.infer<typeof FrameMeta>;

export const FramePayload = FrameMeta.extend({
  /** Base64 JPEG bytes, no data: prefix. */
  data: base64(LIMITS.maxFrameBase64Chars),
});
export type FramePayload = z.infer<typeof FramePayload>;

export const SessionMode = z.enum(['live', 'snapshot']);
export type SessionMode = z.infer<typeof SessionMode>;

export const InspectPurpose = z.enum(['read_label', 'look_again']);
export type InspectPurpose = z.infer<typeof InspectPurpose>;

// ---------------------------------------------------------------------------
// Evidence (structured, grounded output of the vision pipeline)
// ---------------------------------------------------------------------------

export const DateLabelType = z.enum([
  'use_by',
  'best_before',
  'best_before_end',
  'display_until',
  'sell_by',
  'packed_on',
  'production_date',
  'expiry_unspecified',
  'unknown',
]);
export type DateLabelType = z.infer<typeof DateLabelType>;

export const DateInterpretation = z.object({
  /**
   * parsed: unambiguous calendar date including year.
   * ambiguous: e.g. 03/04/27 could be day/month or month/day.
   * incomplete: e.g. no year printed, or month+year only (comparison may still be possible for month-only).
   * unparseable: not a date we can interpret.
   */
  status: z.enum(['parsed', 'ambiguous', 'incomplete', 'unparseable']),
  /** ISO yyyy-mm-dd only when status === 'parsed'. Month-only dates use the last day of that month. */
  isoDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable(),
  /** Comparison against the injected current date in the configured timezone. */
  comparison: z.enum(['past', 'today', 'future', 'unknown']),
  /** Short neutral explanation, e.g. "Year not printed". Never a safety judgement. */
  note: z.string().max(200),
});
export type DateInterpretation = z.infer<typeof DateInterpretation>;

export const DateEvidence = z.object({
  /** Exactly as printed, e.g. "BEST BEFORE END 03 2027" or "USE BY 24 NOV". */
  printedText: z.string().min(1).max(200),
  labelType: DateLabelType,
  /** Computed deterministically on the server from printedText (src/shared/dates.ts), not by the model. */
  interpretation: DateInterpretation,
});
export type DateEvidence = z.infer<typeof DateEvidence>;

export const TextSection = z.enum([
  'product_name',
  'brand',
  'ingredients',
  'allergens',
  'cooking_instructions',
  'storage',
  'after_opening',
  'dates',
  'nutrition',
  'warnings',
  'other',
]);
export type TextSection = z.infer<typeof TextSection>;

export const ImageIssue = z.enum(['text_cut_off', 'glare', 'too_far', 'blurry', 'too_dark', 'angled', 'obstructed', 'no_text_visible']);
export type ImageIssue = z.infer<typeof ImageIssue>;

export const LabelEvidence = z.object({
  frameId: z.number().int().nonnegative(),
  capturedAt: z.number().int().positive(),
  /** Overall legibility as judged by the vision model on the actual image. */
  readability: z.enum(['clear', 'partial', 'unreadable']),
  /** Exact visible text, transcribed verbatim, grouped by section. */
  exactText: z.array(z.object({ section: TextSection, text: z.string().min(1).max(2_000) })).max(40),
  /** Cooking/preparation instructions, verbatim steps grouped by method (e.g. "Microwave", "Oven"). */
  instructions: z.array(z.object({ method: z.string().max(80), steps: z.array(z.string().max(500)).max(20) })).max(8),
  dates: z.array(DateEvidence).max(6),
  /** Lot/batch codes are kept separate and never treated as dates. */
  batchCodes: z.array(z.string().max(80)).max(6),
  /** Interpretation (clearly separated from exactText): what the item probably is. */
  itemGuess: z.string().max(200).nullable(),
  /** Model-reported issues in the actual image (plus client frame statistics if present). */
  issues: z.array(ImageIssue).max(8),
  /** At most one concrete adjustment to request, e.g. "Turn the pack so the back faces the camera." */
  suggestion: z.string().max(200).nullable(),
  /** Vision model used. */
  model: z.string().max(100),
  latencyMs: z.number().int().nonnegative(),
});
export type LabelEvidence = z.infer<typeof LabelEvidence>;

/** Normalised (0..1) box relative to the source image as sent (top-left origin, not mirrored). */
export const NormalizedBox = z.object({
  x: z.number().min(0).max(1),
  y: z.number().min(0).max(1),
  w: z.number().min(0).max(1),
  h: z.number().min(0).max(1),
});
export type NormalizedBox = z.infer<typeof NormalizedBox>;

export const Detection = z.object({
  label: z.string().min(1).max(80),
  score: z.number().min(0).max(1),
  box: NormalizedBox,
});
export type Detection = z.infer<typeof Detection>;

// ---------------------------------------------------------------------------
// Client -> Server
// ---------------------------------------------------------------------------

export const ClientSettings = z.object({
  /** Push-to-talk: client only streams mic audio while the talk control is held, then sends audio.end. */
  pushToTalk: z.boolean(),
  /** Request optional detector overlays (ignored if server has no detector). */
  detections: z.boolean(),
});
export type ClientSettings = z.infer<typeof ClientSettings>;

export const ClientHello = z.object({
  type: z.literal('hello'),
  protocolVersion: z.literal(PROTOCOL_VERSION),
  mode: SessionMode,
  settings: ClientSettings,
  /** Client Date.now() when sending hello; server estimates clock skew (phone vs laptop) for frame-age checks. */
  clientTime: z.number().int().positive(),
  /** Set when reconnecting after a network loss; server may resume the provider session. */
  resume: z.boolean().optional(),
});

export const ClientAudio = z.object({
  type: z.literal('audio'),
  seq: z.number().int().nonnegative(),
  /** PCM16 LE mono at INPUT_SAMPLE_RATE, base64. */
  data: base64(LIMITS.maxAudioChunkBase64Chars),
});

/** Mic muted / push-to-talk released / stream paused > 1 s. Maps to Live `audioStreamEnd`. */
export const ClientAudioEnd = z.object({ type: z.literal('audio.end') });

/** Ambient frame (<= 1 FPS) for the live session. */
export const ClientFrame = z.object({ type: z.literal('frame'), frame: FramePayload });

/** Typed question. In snapshot mode `frame` is required (fresh capture). */
export const ClientText = z.object({
  type: z.literal('text'),
  requestId: RequestId,
  text: z.string().trim().min(1).max(LIMITS.maxTextChars),
  frame: FramePayload.optional(),
});

/** Explicit UI controls that do not rely on the model choosing a tool. */
export const ClientAction = z.object({
  type: z.literal('action'),
  requestId: RequestId,
  action: z.enum(['read_label', 'look_again', 'repeat']),
  /** Required for read_label / look_again: fresh high-resolution capture. */
  frame: FramePayload.optional(),
});

/** Reply to a server snapshot.request (used when the model calls a vision tool). */
export const ClientSnapshotResult = z.object({
  type: z.literal('snapshot.result'),
  requestId: RequestId,
  frame: FramePayload,
});

export const ClientSnapshotUnavailable = z.object({
  type: z.literal('snapshot.unavailable'),
  requestId: RequestId,
  reason: z.enum(['camera_off', 'camera_denied', 'not_ready', 'backgrounded', 'error']),
});

/** User pressed "Stop speaking" (or barge-in detected locally). Server discards remaining output of turnId. */
export const ClientPlaybackStop = z.object({ type: z.literal('playback.stop'), turnId: z.number().int().nonnegative() });

/** Page hidden / visible. While paused, the server must not forward media and the client must not send it. */
export const ClientVisibility = z.object({ type: z.literal('visibility'), state: z.enum(['hidden', 'visible']) });

export const ClientSettingsUpdate = z.object({ type: z.literal('settings'), settings: ClientSettings });

export const ClientBye = z.object({ type: z.literal('bye') });

export const ClientMessage = z.discriminatedUnion('type', [
  ClientHello,
  ClientAudio,
  ClientAudioEnd,
  ClientFrame,
  ClientText,
  ClientAction,
  ClientSnapshotResult,
  ClientSnapshotUnavailable,
  ClientPlaybackStop,
  ClientVisibility,
  ClientSettingsUpdate,
  ClientBye,
]);
export type ClientMessage = z.infer<typeof ClientMessage>;
export type ClientMessageOf<T extends ClientMessage['type']> = Extract<ClientMessage, { type: T }>;

// ---------------------------------------------------------------------------
// Server -> Client
// ---------------------------------------------------------------------------

export const ErrorCode = z.enum([
  'missing_credentials',
  'model_unavailable',
  'quota_exceeded',
  'provider_error',
  'provider_disconnected',
  'invalid_message',
  'rate_limited',
  'session_limit',
  'too_many_sessions',
  'unauthorized',
  'frame_stale',
  'frame_missing',
  'snapshot_timeout',
  'detector_unavailable',
  'internal',
]);
export type ErrorCode = z.infer<typeof ErrorCode>;

export const ServerReady = z.object({
  type: z.literal('ready'),
  sessionId: z.string(),
  mode: SessionMode,
  models: z.object({ live: z.string().nullable(), vision: z.string().nullable() }),
  features: z.object({ live: z.boolean(), snapshot: z.boolean(), detections: z.boolean() }),
  /** Server epoch ms; lets the client estimate clock skew for latency metrics. */
  serverTime: z.number().int(),
  maxSessionMs: z.number().int().positive(),
});

export const ServerStatus = z.object({
  type: z.literal('status'),
  /** Provider connection state as seen by the server. */
  state: z.enum(['connecting', 'live', 'reconnecting', 'snapshot', 'paused', 'closed']),
  detail: z.string().max(200).optional(),
});

export const ServerAudio = z.object({
  type: z.literal('audio'),
  turnId: z.number().int().nonnegative(),
  seq: z.number().int().nonnegative(),
  /** PCM16 LE mono at OUTPUT_SAMPLE_RATE, base64. */
  data: z.string(),
});

/**
 * Real provider transcription only (never fabricated). `text` is an incremental fragment to append.
 * user = inputTranscription, assistant = outputTranscription.
 */
export const ServerTranscript = z.object({
  type: z.literal('transcript'),
  role: z.enum(['user', 'assistant']),
  turnId: z.number().int().nonnegative(),
  text: z.string().max(4_000),
  final: z.boolean(),
});

export const ServerTurn = z.object({
  type: z.literal('turn'),
  turnId: z.number().int().nonnegative(),
  /**
   * start: first model output of a turn. interrupted: provider reported barge-in, client must flush.
   * generation_complete: model finished generating. complete: turn finished.
   * cancelled: server discarded the rest of this turn (after playback.stop).
   */
  event: z.enum(['start', 'interrupted', 'generation_complete', 'complete', 'cancelled']),
  /** Server epoch ms. */
  at: z.number().int(),
});

/** Server asks the client for a fresh high-resolution capture (because the model called a vision tool). */
export const ServerSnapshotRequest = z.object({
  type: z.literal('snapshot.request'),
  requestId: RequestId,
  purpose: InspectPurpose,
  maxDim: z.number().int().positive().max(4096),
});

/** Application-level tool progress, for status announcements. */
export const ServerTool = z.object({
  type: z.literal('tool'),
  callId: z.string().max(128),
  name: z.enum(['read_label', 'look_again']),
  state: z.enum(['started', 'completed', 'cancelled', 'failed']),
});

export const ServerEvidence = z.object({
  type: z.literal('evidence'),
  requestId: RequestId.nullable(),
  evidence: LabelEvidence,
});

/** Snapshot-mode (or fallback) text answer produced by the vision endpoint. Spoken with browser TTS. */
export const ServerAnswer = z.object({
  type: z.literal('answer'),
  requestId: RequestId,
  text: z.string().max(4_000),
  frameId: z.number().int().nonnegative(),
  model: z.string(),
  latencyMs: z.number().int().nonnegative(),
});

export const ServerDetections = z.object({
  type: z.literal('detections'),
  frameId: z.number().int().nonnegative(),
  capturedAt: z.number().int().positive(),
  sourceWidth: z.number().int().positive(),
  sourceHeight: z.number().int().positive(),
  /** Server epoch ms when inference finished. */
  detectedAt: z.number().int(),
  model: z.string().max(100),
  detections: z.array(Detection).max(LIMITS.maxDetections),
});
export type ServerDetections = z.infer<typeof ServerDetections>;

export const ServerError = z.object({
  type: z.literal('error'),
  code: ErrorCode,
  /** Human-readable, safe to show. Must not contain keys or raw provider payloads. */
  message: z.string().max(500),
  recoverable: z.boolean(),
  requestId: RequestId.optional(),
  /** Suggested client transition. */
  fallback: z.enum(['snapshot', 'none']).optional(),
});

export const ServerNotice = z.object({
  type: z.literal('notice'),
  code: z.enum(['go_away', 'session_resumed', 'session_limit_soon', 'detector_disabled', 'media_paused']),
  message: z.string().max(300),
});

export const ServerMessage = z.discriminatedUnion('type', [
  ServerReady,
  ServerStatus,
  ServerAudio,
  ServerTranscript,
  ServerTurn,
  ServerSnapshotRequest,
  ServerTool,
  ServerEvidence,
  ServerAnswer,
  ServerDetections,
  ServerError,
  ServerNotice,
]);
export type ServerMessage = z.infer<typeof ServerMessage>;
export type ServerMessageOf<T extends ServerMessage['type']> = Extract<ServerMessage, { type: T }>;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export type ParseResult<T> = { ok: true; value: T } | { ok: false; error: string };

function parseWith<T>(schema: z.ZodType<T>, raw: unknown): ParseResult<T> {
  let value: unknown = raw;
  if (typeof raw === 'string') {
    try {
      value = JSON.parse(raw);
    } catch {
      return { ok: false, error: 'invalid JSON' };
    }
  }
  const res = schema.safeParse(value);
  if (!res.success) {
    const first = res.error.issues[0];
    return { ok: false, error: first ? `${first.path.join('.') || '(root)'}: ${first.message}` : 'invalid message' };
  }
  return { ok: true, value: res.data };
}

export const parseClientMessage = (raw: unknown) => parseWith(ClientMessage, raw);
export const parseServerMessage = (raw: unknown) => parseWith(ServerMessage, raw);

/** Health endpoint payload (GET /api/health). Contains no secrets. */
export const HealthResponse = z.object({
  ok: z.boolean(),
  version: z.string(),
  configured: z.boolean(),
  models: z.object({ live: z.string(), vision: z.string() }),
  detector: z.enum(['disabled', 'ok', 'unreachable']),
  accessGate: z.boolean(),
  timeZone: z.string(),
});
export type HealthResponse = z.infer<typeof HealthResponse>;
