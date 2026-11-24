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
  FindCandidate,
  FindPromptKind,
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
  /** The app's single output AudioContext (null before unlock). Cue sounds share it to avoid competing contexts. */
  readonly context: AudioContext | null;
  close(): Promise<void>;
}

/** Image-relative target for the find beacon (normalised to the unmirrored rear-camera picture). */
export interface CueTarget {
  /** Box centre, 0..1 from left / top of the picture. pan = clamp(2*cx - 1, -1, 1). */
  cx: number;
  cy: number;
  /** Box area as a fraction of the picture, 0..1. Not used as distance. */
  area: number;
  /** Stably centred (server dwell + hysteresis). The beacon stops pulsing when true. */
  centered: boolean;
  /** Client-clock capture time of the observation. Older than LIMITS.findObservationMaxAgeMs = no cue. */
  observedAt: number;
}

export type Earcon = 'session_start' | 'session_end' | 'listening' | 'capture' | 'working' | 'found' | 'lost' | 'error';

/**
 * Non-speech audio + haptics, sharing the AudioPlayer's AudioContext.
 * Beacon: short gentle tone -> gain envelope (attack/release) -> StereoPannerNode (smoothed with setTargetAtTime)
 * -> output. Pulse interval goes from LIMITS.findPulseFarMs (far from centre) to LIMITS.findPulseNearMs (near
 * centre) and represents alignment, never distance. No pitch language in v1.
 */
export interface SpatialCueEngine {
  readonly supported: boolean;
  /** Attach to / resume the shared AudioContext. MUST be called synchronously inside a user gesture handler. */
  unlock(): Promise<void>;
  /** Latest observation; null = no target (pulses stop immediately). Stale observations are ignored. */
  setTarget(target: CueTarget | null): void;
  /** Start/stop the beacon loop. stopTracking cancels every scheduled pulse immediately. */
  startTracking(): void;
  stopTracking(): void;
  /** One-shot event sound (and matching vibration if haptics enabled). */
  earcon(kind: Earcon): void;
  /** Lower volume (e.g. screen reader likely speaking). */
  setDucked(ducked: boolean): void;
  /** Silence pulses entirely while true (assistant speech, guidance speech, user speech). Resumes after. */
  setSuppressed(suppressed: boolean): void;
  /** Calibration: one tone hard left (-1), hard right (+1) or centre (0). Resolves when it has finished playing. */
  calibrationTone(channel: 'left' | 'right' | 'centre'): Promise<void>;
  configure(opts: { earcons: boolean; beacon: boolean; haptics: boolean; volume: number }): void;
  /** performance.now() ms until which a cue is (or is scheduled to be) audible, incl. release tail. Used to blank mic input. */
  readonly audibleUntil: number;
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
  trackId: number | null;
  /** Client-clock capture time of the latest observation of the target, or null. */
  observedAt: number | null;
  /** Choices in needs_selection (empty otherwise). */
  candidates: FindCandidate[];
  /** Last app-generated prompt (also spoken unless muted). */
  lastPrompt: { kind: FindPromptKind; text: string } | null;
}

export type CalibrationStep = 'idle' | 'left' | 'right' | 'centre' | 'confirm' | 'done';

export interface CalibrationState {
  step: CalibrationStep;
  /** null until answered. false = user did not hear the expected left/right separation. */
  heardSeparation: boolean | null;
  /** Whether the microphone was active during the test (Bluetooth routing may differ when it is). */
  micActive: boolean;
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
  /** Find-mode stereo beacon (left/right in the picture -> left/right ear; faster = better aligned). */
  spatialAudio: boolean;
  /** Vibration patterns (Android Chrome) for capture / centred / found. */
  haptics: boolean;
  /** Cue volume 0..1 (beacon + earcons). */
  cueVolume: number;
  /** 'stereo': panned beacon + occasional spoken tilt prompts. 'spoken': spoken left/right/up/down instead of panning. */
  guidanceMode: 'stereo' | 'spoken';
  /**
   * 'keep': microphone stays open during Find (barge-in works; Bluetooth earbuds may switch to mono call audio).
   * 'release': microphone is released while Find runs (better chance of stereo on Bluetooth); hold Talk to speak.
   */
  findMicPolicy: 'keep' | 'release';
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
  /** Latest detection result: arrival time minus its frame's capture time (both client clock), ms. */
  detectionAgeMs: number | null;
  /** Detection results received in the last ~5 s, per second. */
  detectionRate: number | null;
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
  calibration: CalibrationState;
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
  /** Choose a candidate in needs_selection. */
  selectTarget(candidateId: number): void;
  setTorch(on: boolean): Promise<void>;
  /** User-initiated stereo check: left tone, right tone, centre tone, then confirm. Call from a tap. */
  startCalibration(): Promise<void>;
  answerCalibration(heardSeparation: boolean): void;
  cancelCalibration(): void;
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
