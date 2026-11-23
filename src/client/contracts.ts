/**
 * Client-side module contracts. OWNER: lead. Workers implement these; request changes, don't edit.
 *
 * Ownership map (exclusive):
 *   src/client/camera/**   camera/mobile agent   -> CameraController, FrameSampler, frame quality
 *   src/client/audio/**    conversation agent    -> MicCapture, AudioPlayer, SpeechOutput
 *   src/client/session/**  conversation agent    -> SessionSocket, AssistantController implementation
 *   src/client/ui/**, src/client/App.tsx, src/client/styles.css   interface agent
 *   src/client/main.tsx    lead (composition root)
 */
import type {
  ClientSettings,
  ErrorCode,
  FindState,
  FramePayload,
  LabelEvidence,
  NormalizedBox,
  ServerDetections,
  SessionMode,
} from '../shared/protocol.js';

export type Unsubscribe = () => void;
export type Listener = () => void;

/** Minimal external store usable with React's useSyncExternalStore. getState() must return a stable reference until it changes. */
export interface Store<S> {
  getState(): S;
  subscribe(listener: Listener): Unsubscribe;
}

// ---------------------------------------------------------------------------
// Camera
// ---------------------------------------------------------------------------

export type CameraStatus =
  | 'idle'
  | 'requesting'
  | 'active'
  | 'paused' // page hidden; track disabled or stopped
  | 'denied' // NotAllowedError / SecurityError
  | 'unavailable' // NotFoundError / OverconstrainedError with no fallback / no mediaDevices
  | 'in_use' // NotReadableError (another app holds the camera)
  | 'insecure_context' // window.isSecureContext === false
  | 'disconnected' // track 'ended' unexpectedly
  | 'error'
  | 'stopped';

export type CameraFacing = 'environment' | 'user' | 'unknown';

export interface CameraState {
  status: CameraStatus;
  facing: CameraFacing;
  /** Label is only available after permission; may be ''. */
  deviceLabel: string;
  /** Intrinsic video dimensions as displayed (videoWidth/videoHeight). 0 until valid. */
  videoWidth: number;
  videoHeight: number;
  /** More than one videoinput known after permission. */
  canSwitch: boolean;
  /** Torch (flash light) support on the active track, and whether it is on. */
  torch: { supported: boolean; on: boolean };
  /** A full-resolution still-photo path (ImageCapture.takePhoto) is available for the active track. */
  stillCapture: boolean;
  /** Human-readable, safe message for non-active states. */
  message: string | null;
}

export interface CaptureOptions {
  /** Longest side in pixels after scaling (never upscale). */
  maxDim: number;
  /** JPEG quality 0..1 */
  jpegQuality: number;
  /** Compute FrameQuality statistics (cheap, on a small copy). Default true. */
  computeQuality?: boolean;
}

/** A captured JPEG frame. `frameId` is unique and increasing for the controller's lifetime. */
export type CapturedFrame = FramePayload;

export interface CameraController extends Store<CameraState> {
  /** Attach/detach the preview element. The element is used as the capture source. */
  attachVideo(el: HTMLVideoElement | null): void;
  /** Request the rear camera (with fallbacks). Safe to call from a user gesture. */
  start(): Promise<void>;
  /** Stop all tracks immediately and release the device. Idempotent. */
  stop(): void;
  /** Switch between rear/front (or next device). Only after permission. */
  switchCamera(): Promise<void>;
  /** Pause (page hidden) / resume. Resume may require restarting the track. */
  pause(): void;
  resume(): Promise<void>;
  /** Capture a frame now. Returns null if the video has no valid dimensions or the camera is not active. */
  capture(opts: CaptureOptions): Promise<CapturedFrame | null>;
  /**
   * Highest-quality still for reading small print: ImageCapture.takePhoto() at the sensor's photo resolution when
   * supported (scaled to opts.maxDim), otherwise the sharpest of `bestOf` video frames. Never upscales.
   * Returns null when the camera is not active.
   */
  captureStill(opts: CaptureOptions & { bestOf?: number }): Promise<CapturedFrame | null>;
  /** Turn the torch on/off. Resolves false when unsupported or refused. */
  setTorch(on: boolean): Promise<boolean>;
}

/**
 * Samples ambient frames at <= 1 FPS into a single latest-frame slot (no queue).
 * onFrame is invoked with each new frame; if the consumer is still busy, older frames are dropped.
 */
export interface FrameSamplerConfig {
  intervalMs: number;
  maxDim: number;
  jpegQuality: number;
  /**
   * Floor for intervalMs. Defaults to LIMITS.liveFrameMinIntervalMs (1 FPS, the Live API limit). The detection
   * sampler (never sent to Live) may lower it to LIMITS.detectFrameMinIntervalMs.
   */
  minIntervalMs?: number;
}

export interface FrameSampler {
  start(onFrame: (frame: CapturedFrame) => void): void;
  stop(): void;
  /** Most recent captured frame, or null. */
  latest(): CapturedFrame | null;
  /** Count of frames dropped because a newer one superseded them before sending. */
  readonly droppedCount: number;
}

// ---------------------------------------------------------------------------
// Audio
// ---------------------------------------------------------------------------

export type MicStatus = 'idle' | 'requesting' | 'active' | 'muted' | 'denied' | 'unavailable' | 'in_use' | 'insecure_context' | 'error' | 'stopped';

export interface MicState {
  status: MicStatus;
  /** 0..1 RMS level of the latest chunk (for a meter), 0 when muted. */
  level: number;
  /** Actual capture constraints reported by the track (echoCancellation etc.), when known. */
  echoCancellation: boolean | null;
  message: string | null;
}

export interface MicCapture extends Store<MicState> {
  /** Request mic and begin producing chunks. Call within the Start gesture. */
  start(): Promise<void>;
  stop(): void;
  setMuted(muted: boolean): void;
  /** When false, chunks are still captured for the meter but not delivered (push-to-talk released / paused). */
  setGate(open: boolean): void;
  /** PCM16 LE mono @16 kHz, base64, roughly 20-100 ms per chunk. */
  onChunk(cb: (base64Pcm16: string) => void): Unsubscribe;
}

export interface PlayerState {
  /** Audio is currently audible or scheduled. */
  playing: boolean;
  /** turnId currently being played, or null. */
  turnId: number | null;
  /** AudioContext state; 'suspended' means a tap is needed. */
  contextState: 'uninitialized' | 'running' | 'suspended' | 'closed';
}

export interface AudioPlayer extends Store<PlayerState> {
  /** Create/resume the AudioContext. MUST be called synchronously inside a user gesture handler. */
  unlock(): Promise<void>;
  /** Queue PCM16 LE mono @24 kHz. Chunks for turns <= the last flushed turn are rejected. */
  enqueue(turnId: number, base64Pcm16: string): void;
  /** Immediately silence and drop all scheduled audio; reject later chunks of turns <= turnId (if given). */
  flush(turnId?: number): void;
  /** Wall-clock (performance.now()) of the first audible sample of a turn, for latency metrics. */
  onTurnAudible(cb: (turnId: number, at: number) => void): Unsubscribe;
  close(): Promise<void>;
}

/** Image-relative target for spatial cues (normalised to the camera picture, not physical space). */
export interface CueTarget {
  /** Box centre, 0..1 from left / top of the picture. */
  cx: number;
  cy: number;
  /** Box area as a fraction of the picture, 0..1 (bigger = fills more of the picture). */
  area: number;
  centered: boolean;
}

export type Earcon = 'session_start' | 'session_end' | 'listening' | 'capture' | 'working' | 'found' | 'lost' | 'error';

/**
 * Non-speech audio + haptic feedback. Stereo panning works best with headphones (the S25's two speakers are only
 * left/right in landscape), so pitch also encodes vertical position and beep rate encodes how centred the target is.
 */
export interface SpatialCueEngine {
  readonly supported: boolean;
  /** Create/resume its AudioContext. MUST be called synchronously inside a user gesture handler. */
  unlock(): Promise<void>;
  /** Continuous aiming cue. null = no target (silence after a short "lost" cue). */
  setTarget(target: CueTarget | null): void;
  /** Start/stop the continuous aiming cue loop (find mode). */
  startTracking(): void;
  stopTracking(): void;
  /** One-shot event sound (and matching vibration if haptics enabled). */
  earcon(kind: Earcon): void;
  /** Lower cue volume while the assistant speaks. */
  setDucked(ducked: boolean): void;
  configure(opts: { earcons: boolean; spatial: boolean; haptics: boolean; headphones: boolean }): void;
  close(): Promise<void>;
}

/** Browser speech synthesis for snapshot mode. */
export interface SpeechOutput {
  readonly supported: boolean;
  speak(text: string): void;
  cancel(): void;
  readonly speaking: boolean;
}

// ---------------------------------------------------------------------------
// Assistant (composition of camera + audio + socket). Rendered by the UI.
// ---------------------------------------------------------------------------

export type ConnectionStatus =
  | 'idle' // not started
  | 'connecting'
  | 'live' // Gemini Live session active
  | 'snapshot' // snapshot fallback mode active (typed question + still photo)
  | 'reconnecting'
  | 'paused' // backgrounded / needs a tap to resume
  | 'ended'
  | 'error';

export type TranscriptSource = 'live_transcription' | 'typed' | 'snapshot_answer' | 'evidence' | 'system';

export interface TranscriptEntry {
  id: string;
  role: 'user' | 'assistant' | 'system';
  text: string;
  /** false while a live transcription is still streaming. */
  final: boolean;
  source: TranscriptSource;
  /** Client epoch ms. */
  at: number;
  turnId?: number;
}

export interface AppError {
  code: ErrorCode | 'camera' | 'microphone' | 'audio_output' | 'network' | 'insecure_context';
  message: string;
  recoverable: boolean;
  /** What the UI should offer. */
  action?: 'retry' | 'tap_to_resume' | 'use_snapshot' | 'open_settings' | 'none';
}

export interface Announcement {
  /** Monotonic id so identical texts re-announce. */
  id: number;
  text: string;
  politeness: 'polite' | 'assertive';
}

export type BusyKind = 'connecting' | 'reading_label' | 'looking' | 'answering' | 'finding';

export interface FindStatus {
  query: string;
  state: FindState;
  source: 'yolo' | 'gemini';
  target: { label: string; score: number; box: NormalizedBox } | null;
  description: string | null;
  /** Client epoch ms of the last update. */
  updatedAt: number;
}

export interface AssistantSettings extends ClientSettings {
  /** Show the camera preview (camera keeps running either way while the session is active). */
  showPreview: boolean;
  /** 'barge_in': mic stays open during replies (echo cancellation requested). 'pause': mic is gated while assistant audio plays. */
  micDuringReplies: 'barge_in' | 'pause';
  /** Speak snapshot-mode answers with browser TTS. */
  speakSnapshotAnswers: boolean;
  /** Show developer diagnostics panel. */
  showDiagnostics: boolean;
  /** Short non-speech sounds for events (capture, found, lost...). */
  earcons: boolean;
  /** Continuous aiming beeps in find mode (pan = left/right in the picture, pitch = up/down, rate = how centred). */
  spatialAudio: boolean;
  /** Vibration patterns (Android Chrome) for capture / centred / found. */
  haptics: boolean;
  /** Use 3D (HRTF) panning tuned for headphones instead of simple stereo panning. */
  headphones: boolean;
}

export interface Metrics {
  /** Age of the newest frame delivered to the server when the latest question started (ms). */
  frameAgeAtQuestionMs: number | null;
  /** From end of user speech (or typed send / button press) to first assistant transcript text (ms). */
  questionToFirstTextMs: number | null;
  /** From end of user speech (or typed send / button press) to first audible assistant sample (ms). */
  questionToFirstAudioMs: number | null;
  framesSent: number;
  framesDropped: number;
  reconnects: number;
}

export interface ServerInfo {
  configured: boolean;
  liveModel: string | null;
  visionModel: string | null;
  detector: boolean;
  sessionId: string | null;
  /** IANA timezone the server uses for date comparisons, when known. */
  timeZone: string | null;
}

export interface AssistantState {
  connection: ConnectionStatus;
  mode: SessionMode;
  camera: CameraState;
  mic: MicState;
  player: PlayerState;
  /** Assistant speaking (live audio or TTS). */
  speaking: boolean;
  /** Push-to-talk control currently held. */
  talking: boolean;
  busy: { kind: BusyKind; since: number } | null;
  transcript: TranscriptEntry[];
  lastEvidence: LabelEvidence | null;
  /** Latest unexpired detections (null when expired/disabled). */
  detections: ServerDetections | null;
  /** Active find mode, or null. */
  find: FindStatus | null;
  error: AppError | null;
  announcement: Announcement | null;
  settings: AssistantSettings;
  server: ServerInfo | null;
  metrics: Metrics;
}

export interface AssistantController extends Store<AssistantState> {
  /** Start a session. MUST be called directly from a click/tap handler (unlocks audio, requests media). */
  start(): Promise<void>;
  /** End the session: immediately stops capture, transmission and playback; closes the socket. */
  end(): void;
  /** Stop current assistant speech locally at once; session continues. */
  stopSpeaking(): void;
  setMuted(muted: boolean): void;
  /** Push-to-talk press/release. */
  setTalking(down: boolean): void;
  readLabel(): Promise<void>;
  /** Start find mode for an item ("salt", "the red tin"). Image-relative aiming help only. */
  find(query: string): Promise<void>;
  stopFind(): void;
  setTorch(on: boolean): Promise<void>;
  lookAgain(): Promise<void>;
  repeat(): void;
  sendText(text: string): Promise<void>;
  switchCamera(): Promise<void>;
  /** Resume after background / suspended audio. Call from a tap. */
  resume(): Promise<void>;
  setMode(mode: SessionMode): void;
  updateSettings(patch: Partial<AssistantSettings>): void;
  clearTranscript(): void;
  dismissError(): void;
  attachVideo(el: HTMLVideoElement | null): void;
}
