/**
 * Server-side module contracts. OWNER: lead. Workers implement these; request changes, don't edit.
 *
 * Ownership map (exclusive):
 *   src/server/index.ts, config.ts, http/**     lead (assembly, health, origin/access gate)
 *   src/server/session/**, src/server/live/**   conversation agent (ClientSession, Live bridge, tools, prompts)
 *   src/server/vision/**, src/shared/dates.ts, services/detector/**   vision agent
 */
import type { FramePayload, LabelEvidence, NormalizedBox, ServerDetections, ServerMessage } from '../shared/protocol.js';
import type { GuideExtraction } from '../shared/guide.js';
import type { AppConfig } from './config.js';

export type Clock = () => Date;

/** Outbound channel to one browser client. `send` must never throw; drops if closed or backpressured. */
export interface ClientChannel {
  send(msg: ServerMessage): void;
  close(code?: number, reason?: string): void;
  readonly isOpen: boolean;
  /** Bytes queued in the socket (ws.bufferedAmount) for backpressure decisions. */
  readonly bufferedAmount: number;
}

export interface ConversationTurn {
  role: 'user' | 'assistant';
  text: string;
}

export interface VisionService {
  readonly model: string;
  /**
   * Extract exact visible text, instructions and dates from a fresh high-resolution frame.
   * Date interpretation must be computed with src/shared/dates.ts using `now` and the configured timezone.
   * Must throw VisionError on provider failure (never return fabricated evidence).
   */
  extractLabel(input: { frame: FramePayload; focus?: string | undefined; now: Date; signal?: AbortSignal | undefined }): Promise<LabelEvidence>;
  /** Snapshot-mode answer: one image + question (+ short history). Plain, concise text for TTS. */
  answer(input: {
    frame: FramePayload;
    question: string;
    history: ConversationTurn[];
    now: Date;
    signal?: AbortSignal | undefined;
  }): Promise<{ text: string; latencyMs: number }>;
  /**
   * Gemini box detection for a free-text query ("salt", "the label text"). Boxes are normalised 0..1 (converted
   * from Gemini's box_2d [ymin, xmin, ymax, xmax] in 0..1000). Empty array = not visible. Never fabricated.
   */
  /**
   * Instruction companion: assess whether the requested instructions are readable in this FRESH frame and extract them
   * into ordered, source-grounded steps per section (alternative methods kept separate). Must report an
   * evidence-based issue + ONE adjustment when inadequate, never invented glare/blur. Never fabricated; throws
   * VisionError on provider failure. The server post-checks numbers/units in `spoken` against `sourceText`.
   */
  extractGuide(input: { frame: FramePayload; goal: string; now: Date; signal?: AbortSignal | undefined }): Promise<GuideExtraction>;
  locate(input: { frame: FramePayload; query: string; signal?: AbortSignal | undefined }): Promise<{
    boxes: { label: string; box: NormalizedBox; score: number }[];
    model: string;
    latencyMs: number;
  }>;
}

export interface DetectorService {
  readonly enabled: boolean;
  readonly model: string;
  /** Returns null if disabled, busy (one request in flight), or failed. Never fabricates boxes. */
  detect(frame: FramePayload, signal?: AbortSignal): Promise<ServerDetections | null>;
  health(): Promise<'disabled' | 'ok' | 'unreachable'>;
}

/** Subset of @google/genai Session used by the bridge, so tests can inject a fake. */
export interface LiveSessionLike {
  sendRealtimeInput(params: import('@google/genai').LiveSendRealtimeInputParameters): void;
  sendClientContent(params: import('@google/genai').LiveSendClientContentParameters): void;
  sendToolResponse(params: import('@google/genai').LiveSendToolResponseParameters): void;
  close(): void;
}

export type LiveConnector = (params: import('@google/genai').LiveConnectParameters) => Promise<LiveSessionLike>;

export interface SessionDeps {
  channel: ClientChannel;
  config: AppConfig;
  vision: VisionService | null;
  detector: DetectorService;
  /** null when credentials are missing: session must report missing_credentials honestly. */
  liveConnector: LiveConnector | null;
  clock: Clock;
  log: Logger;
}

/** One per WebSocket connection. Implemented in src/server/session/ClientSession.ts (conversation agent). */
export interface ClientSessionHandle {
  /** Raw text frame from the socket (already size-limited by ws maxPayload). */
  handleRaw(raw: string): void;
  /** Socket closed or server shutting down: close provider session, abort in-flight work. Idempotent. */
  dispose(reason: string): void;
}

export type ClientSessionFactory = (deps: SessionDeps) => ClientSessionHandle;

export class VisionError extends Error {
  constructor(
    message: string,
    readonly code: 'missing_credentials' | 'model_unavailable' | 'quota_exceeded' | 'provider_error' | 'invalid_output',
  ) {
    super(message);
    this.name = 'VisionError';
  }
}

/** Metadata-only logger: never pass image/audio/transcript content or keys. */
export interface Logger {
  info(event: string, fields?: Record<string, string | number | boolean | null | undefined>): void;
  warn(event: string, fields?: Record<string, string | number | boolean | null | undefined>): void;
  error(event: string, fields?: Record<string, string | number | boolean | null | undefined>): void;
}
