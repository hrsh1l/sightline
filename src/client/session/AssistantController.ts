/**
 * AssistantController: composes camera + sampler + mic + player + speech + socket into the store the UI renders.
 * Depends only on the contracts in src/client/contracts.ts (never imports the camera implementation).
 *
 * Key rules:
 *  - start() calls player.unlock() FIRST, synchronously inside the user gesture, before any await.
 *  - Every async continuation is guarded by a session `epoch`: after end() nothing is sent or captured.
 *  - Media is sent only while connected live, visible and not reconnecting. Nothing is queued while
 *    disconnected, so nothing old is replayed after a reconnect.
 *  - Stop speaking and barge-in flush the local player immediately, before telling the server.
 *  - Transcript text only ever comes from the server (provider transcription, answers, evidence) or the
 *    user's own typed text. Nothing is fabricated.
 *
 * Turn ids: the server numbers turns from 1 per server session (per socket). The controller maps them to
 * local ids (local = turnOffset + serverTurnId, turnOffset = highest local id seen when a new socket becomes
 * ready) so the player's "reject turns <= flushed turn" rule keeps working across reconnects.
 *
 * Metrics (all timestamps on the client epoch clock, `now()` = Date.now() by default):
 *  - questionEnd: for an explicit request (Read label / Look again / Repeat button, typed send) the time of the
 *    press/send. For live voice, the last time a mic chunk's RMS exceeded SPEECH_RMS_THRESHOLD before the
 *    assistant turn started (only chunks after the previous response began count). Null if unknown.
 *  - frameAgeAtQuestionMs: voice: questionEnd - capturedAt of the newest frame sent before questionEnd.
 *    Explicit requests carry their own fresh capture, so it is (time the request was sent) - capturedAt.
 *  - questionToFirstTextMs: arrival of the first assistant transcript fragment of the turn (live) or of the
 *    snapshot answer, minus questionEnd.
 *  - questionToFirstAudioMs: the player's onTurnAudible time (performance.now() of the first scheduled sample,
 *    converted to the epoch clock via now() - (perfNow() - at)) minus questionEnd; for snapshot answers, the
 *    moment browser TTS reports it started speaking.
 *  - framesSent / framesDropped (controller drops + sampler supersessions) / reconnects (socket re-established).
 *  - detectionAgeMs: arrival time (now()) minus the frame's capture time (both client clock) of the latest
 *    detection result (ServerDetections.capturedAt) or Find observation (ServerFind.observedAt).
 *  - detectionRate: distinct detection results (by frameId) received in the last DETECTION_RATE_WINDOW_MS, per s.
 *
 * Find mode (image-relative aiming help with the REAR camera; never distance or room navigation):
 *  - The server detects/tracks the selected object and sends ServerFind updates. The controller turns a FRESH
 *    selected-target observation (tracking/centered, observedAt within LIMITS.findObservationMaxAgeMs) into the
 *    stereo beacon target; anything else is setTarget(null) (silence, never steer from an old position).
 *  - ServerFind.prompt is app-generated text (never model prose). It is spoken ONCE with the local SpeechOutput
 *    (browser TTS) through a small queue: waits while Gemini audio plays (up to GUIDANCE_WAIT_FOR_ASSISTANT_MS),
 *    never cuts off other speech, a newer prompt of the same kind replaces an unspoken older one, and prompts tied
 *    to a state (tilt, centred, lost...) are dropped when that state no longer holds. Spoken prompts are NOT also
 *    sent to the screen-reader announcer (no double speech).
 *  - Entering 'centered' plays the 'found' chime (+ haptic) once per centring episode, then the spoken confirmation.
 *  - The beacon is suppressed (spatial.setSuppressed) while assistant audio, guidance/answer TTS, user speech,
 *    push-to-talk in mic-release mode, or calibration is in progress.
 *  - guidanceMode 'spoken': no panning beacon; short words "Left"/"Right"/"Up"/"Down" from the latest fresh target
 *    (horizontal first), at most every SPOKEN_DIRECTION_INTERVAL_MS, never over other speech, silent when centred.
 *  - Guidance never becomes user input. findMicPolicy 'keep': mic chunks captured while a cue is audible
 *    (spatial.audibleUntil) or guidance TTS is speaking are replaced by silence (the stream stays continuous so the
 *    server VAD behaves); loud input outside cue windows suppresses the beacon for USER_SPEECH_SUPPRESS_MS so the
 *    user can talk. findMicPolicy 'release': the mic is released while Find runs and only reopened while the Talk
 *    control is held. Why: on Android, an open Bluetooth headset microphone usually switches the earbuds from
 *    stereo media audio (A2DP / LE Audio media) to mono call audio (HFP / SCO), which would collapse the beacon to
 *    mono. Releasing the mic gives the stereo beacon its best chance.
 *
 * Instruction companion (guide):
 *  - The SERVER owns guide progress. state.guide is the latest ServerGuide snapshot, applied only when newer
 *    (higher version, newer revision or a different guideId). Reading a step never marks it complete; only the
 *    user's explicit Done (guide.action 'confirm' bound to guideId + revision + the current step id) does.
 *  - guideInspect() captures a FRESH detail still (like Read label) and sends guide.inspect; busy 'checking_view'
 *    until a ServerGuide answers it (or error / GUIDE_INSPECT_TIMEOUT_MS). snapshot.request purpose 'guide' (voice
 *    "how about now?") uses the same still path.
 *  - Guide actions are never queued offline: while not connected they are refused with "Not connected". Pause and
 *    Stop silence assistant speech locally first.
 *  - resumeKey from `ready` is kept in memory only (never storage) and sent in hello on reconnect / mode change. If
 *    a guide was active and the next `ready` does not report guideRestored, the guide is cleared and guideLost set
 *    (honest message). After a page reload there is no key, so nothing is restored.
 *  - Snapshot mode: the app speaks guide changes with local TTS (one engine at a time, never over Gemini audio).
 *    Live mode: the model speaks; the client only announces short status changes (confirmed, paused...) politely.
 */
import {
  LIMITS,
  PROTOCOL_VERSION,
  type ClientMessage,
  type FindPromptKind,
  type FindState,
  type FramePayload,
  type LabelEvidence,
  type ServerDetections,
  type ServerMessage,
  type ServerMessageOf,
  type SessionMode,
} from '../../shared/protocol.js';
import type {
  AppError,
  AssistantController,
  AssistantSettings,
  AssistantState,
  BusyKind,
  CalibrationState,
  CameraController,
  CapturedFrame,
  ConnectionStatus,
  CueTarget,
  Earcon,
  FindStatus,
  FrameSampler,
  Listener,
  Metrics,
  MicCapture,
  AudioPlayer,
  SpatialCueEngine,
  SpeechOutput,
  TranscriptEntry,
  Unsubscribe,
} from '../contracts.js';
import { base64ToBytes, bytesToBase64, rmsOfPcm16Base64 } from '../audio/pcm.js';
import { GUIDE_LIMITS, IDLE_GUIDE, type GuideAction } from '../../shared/guide.js';
import {
  GUIDE_LOST_TEXT,
  GUIDE_NOT_CONNECTED_TEXT,
  currentStep,
  guideAnnouncement,
  guideRejectText,
  guideSpeech,
  isNewerGuide,
  type GuideCause,
} from './guideSpeech.js';
import { boxArea, boxCenter, cocoMatch } from '../../shared/find.js';
import type { SessionSocketLike } from './SessionSocket.js';

export type AssistantDeps = {
  camera: CameraController;
  createSampler: (camera: CameraController) => FrameSampler;
  mic: MicCapture;
  player: AudioPlayer;
  speech: SpeechOutput;
  createSocket: () => SessionSocketLike;
  /** Epoch ms clock (default Date.now). */
  now?: () => number;
  document?: Document;
  /** Monotonic clock matching AudioPlayer.onTurnAudible (default performance.now). */
  perfNow?: () => number;
  initialSettings?: Partial<AssistantSettings>;
  /** Delay before client reconnect attempt n (0-based). Default 500 ms doubling, max 8 s. */
  reconnectDelayMs?: (attempt: number) => number;
  /** Busy indicator timeout. Default 30 s. */
  busyTimeoutMs?: number;
  /** Earcons, aiming cues and haptics (optional: without it the app is silent apart from speech). */
  spatial?: SpatialCueEngine;
  /**
   * Small fast frames for the detector / find tracking (never forwarded to Live). Runs only while live/snapshot,
   * visible, and (detections on with a detector, or find active).
   */
  createDetectSampler?: (camera: CameraController) => FrameSampler;
  /** Busy this long before the 'working' tick starts (default 1.5 s), then repeats every workingCueIntervalMs. */
  workingCueDelayMs?: number;
  workingCueIntervalMs?: number;
};

export const DEFAULT_SETTINGS: AssistantSettings = {
  pushToTalk: false,
  detections: false,
  showPreview: true,
  micDuringReplies: 'barge_in',
  speakSnapshotAnswers: true,
  showDiagnostics: false,
  earcons: true,
  spatialAudio: true,
  haptics: true,
  cueVolume: 0.5,
  guidanceMode: 'stereo',
  findMicPolicy: 'keep',
};

/** Defaults + validation (drops the removed v2 `headphones` setting that may still be persisted). */
function sanitizeSettings(s: AssistantSettings): AssistantSettings {
  const out = { ...s } as AssistantSettings & { headphones?: unknown };
  delete out.headphones;
  out.cueVolume = Number.isFinite(out.cueVolume) ? Math.min(1, Math.max(0, out.cueVolume)) : DEFAULT_SETTINGS.cueVolume;
  if (out.guidanceMode !== 'stereo' && out.guidanceMode !== 'spoken') out.guidanceMode = DEFAULT_SETTINGS.guidanceMode;
  if (out.findMicPolicy !== 'keep' && out.findMicPolicy !== 'release') out.findMicPolicy = DEFAULT_SETTINGS.findMicPolicy;
  return out;
}

export const REAR_CAMERA_PROMPT = 'Find works with the rear camera. Switch to the rear camera first.';
export const CAMERA_STOPPED_FIND_TEXT = 'The camera stopped, so Find has stopped.';
/** Guidance prompts wait at most this long for assistant (Gemini) audio to finish, then speak. */
export const GUIDANCE_WAIT_FOR_ASSISTANT_MS = 4_000;
/** Unspoken guidance older than this is dropped. */
export const GUIDANCE_MAX_AGE_MS = 8_000;
/** The spoken centred confirmation follows the 'found' chime by this much. */
export const CENTRED_SPEECH_DELAY_MS = 300;
/** Spoken-direction mode: at most one word per this interval. */
export const SPOKEN_DIRECTION_INTERVAL_MS = 1_500;
/** Mic input stays blanked this long after guidance TTS reports it ended (speaker tail). */
export const GUIDANCE_TTS_TAIL_MS = 300;
/** Beacon stays silent this long after the user is heard speaking (mic policy 'keep'). */
export const USER_SPEECH_SUPPRESS_MS = 1_500;
/** RMS (0..1) of a 16 kHz mic chunk that counts as the user starting to speak during Find. */
export const USER_SPEECH_RMS = 0.03;
/** A mic chunk is treated as captured from (arrival - this) ms: ~64 ms chunk + a little input latency. */
export const MIC_CHUNK_LEAD_MS = 100;
export const DETECTION_RATE_WINDOW_MS = 5_000;
/**
 * Calibration words. Browsers cannot pan speechSynthesis, so these words are always heard centred; the TONE played
 * after each one carries the channel (hard left / hard right / both).
 */
export const CALIBRATION_PHRASES = { left: 'Left ear.', right: 'Right ear.', centre: 'Both ears.' } as const;
export const CALIBRATION_FALLBACK_TEXT = 'Switched Find to spoken directions: left, right, up and down.';

/** Spoken-mode word for an image-relative target position, or null inside the centre zone. Horizontal first. */
export function directionWord(cx: number, cy: number): 'Left' | 'Right' | 'Up' | 'Down' | null {
  const dx = cx - 0.5;
  const dy = cy - 0.5;
  if (Math.abs(dx) > LIMITS.findCenterEnter.x) return dx < 0 ? 'Left' : 'Right';
  if (Math.abs(dy) > LIMITS.findCenterEnter.y) return dy < 0 ? 'Up' : 'Down';
  return null;
}

/** Prompts that only make sense while the find is in one of these states (dropped from the queue otherwise). */
const PROMPT_STATES: Partial<Record<FindPromptKind, readonly FindState[]>> = {
  tilt_up: ['tracking'],
  tilt_down: ['tracking'],
  tracking: ['tracking', 'centered'],
  centred: ['centered'],
  lost: ['lost'],
  select: ['needs_selection'],
  reselect: ['needs_selection'],
  not_seen: ['searching'],
};
const promptFamily = (k: FindPromptKind) => (k === 'tilt_up' || k === 'tilt_down' ? 'tilt' : k);
const isTilt = (k: FindPromptKind) => k === 'tilt_up' || k === 'tilt_down';

const IDLE_CALIBRATION: CalibrationState = { step: 'idle', heardSeparation: null, micActive: false };

/** Do not send detect frames when this much is queued on the socket (they are the most expendable traffic). */
export const MAX_BUFFERED_FOR_DETECT = 64 * 1024;
/** Gemini-located boxes arrive ~1x/s, so they stay on screen a little longer than YOLO boxes. */
export const GEMINI_DETECTION_TTL_MS = LIMITS.detectionTtlMs + LIMITS.locateMinIntervalMs;
const TERMINAL_FIND: ReadonlySet<FindState> = new Set<FindState>(['not_found', 'stopped', 'timeout', 'unsupported', 'error']);

/** RMS (0..1) above which a 16 kHz mic chunk counts as speech for the questionEnd metric. */
export const SPEECH_RMS_THRESHOLD = 0.02;
/** Do not send ambient frames when this much data is already queued on the socket. */
export const MAX_BUFFERED_FOR_FRAMES = 256 * 1024;
export const LOOK_AGAIN_MAX_DIM = 1_024;
/** "Check this view" waits this long for the server's guide answer (vision extraction can be slow). */
export const GUIDE_INSPECT_TIMEOUT_MS = 35_000;
/** Guide tools that capture and inspect a fresh view (busy 'checking_view' while they run). */
const GUIDE_INSPECT_TOOLS: ReadonlySet<string> = new Set(['start_guide', 'inspect_current_view']);
const GUIDE_TOOLS: ReadonlySet<string> = new Set([
  'start_guide',
  'inspect_current_view',
  'choose_section',
  'navigate_step',
  'confirm_step',
  'undo_completion',
  'pause_guide',
  'resume_guide',
  'get_guide_status',
  'stop_guide',
]);
/** Actions that carry the current step id (the step the user is acting on). */
const STEP_BOUND_ACTIONS: ReadonlySet<GuideAction> = new Set<GuideAction>(['confirm', 'next', 'previous']);

const EMPTY_METRICS: Metrics = {
  frameAgeAtQuestionMs: null,
  questionToFirstTextMs: null,
  questionToFirstAudioMs: null,
  framesSent: 0,
  framesDropped: 0,
  reconnects: 0,
  detectionAgeMs: null,
  detectionRate: null,
};

const CONNECTION_ANNOUNCEMENTS: Partial<Record<ConnectionStatus, string>> = {
  connecting: 'Connecting.',
  live: 'Live. Ask about what is in front of the camera.',
  snapshot: 'Snapshot mode. Type a question; a photo is taken when you send it.',
  reconnecting: 'Connection lost. Reconnecting.',
  paused: 'Paused. Tap Resume to continue.',
  ended: 'Session ended.',
};

type SpeechWithEvents = SpeechOutput & { onSpeakingChange?: (cb: (speaking: boolean) => void) => Unsubscribe };

interface BusyInfo {
  kind: BusyKind;
  requestId: string | null;
  fromTool: boolean;
}

interface GuidanceItem {
  kind: FindPromptKind;
  text: string;
  /** now() when queued. */
  queuedAt: number;
  notBefore: number;
  trackId: number | null;
  /** Spoken after the find ended (final unsupported / timeout / error prompt): not tied to a live state. */
  final: boolean;
}

interface ResponseMetrics {
  /** Local turn id or answer request id. */
  key: string;
  questionEnd: number | null;
  gotText: boolean;
  gotAudio: boolean;
}

export function createAssistantController(deps: AssistantDeps): AssistantController {
  const { camera, mic, player } = deps;
  const speech = deps.speech as SpeechWithEvents;
  const now = deps.now ?? (() => Date.now());
  const perfNow = deps.perfNow ?? (() => performance.now());
  const doc: Document | undefined = deps.document ?? (typeof document !== 'undefined' ? document : undefined);
  const reconnectDelay = deps.reconnectDelayMs ?? ((n: number) => Math.min(8_000, 500 * 2 ** n));
  const busyTimeoutMs = deps.busyTimeoutMs ?? 30_000;
  const spatial = deps.spatial ?? null;
  const workingCueDelayMs = deps.workingCueDelayMs ?? 1_500;
  const workingCueIntervalMs = deps.workingCueIntervalMs ?? 1_200;

  // ---------------------------------------------------------------------------
  // Store
  // ---------------------------------------------------------------------------

  let state: AssistantState = {
    connection: 'idle',
    mode: 'live',
    camera: camera.getState(),
    mic: mic.getState(),
    player: player.getState(),
    speaking: false,
    talking: false,
    busy: null,
    transcript: [],
    lastEvidence: null,
    detections: null,
    find: null,
    calibration: IDLE_CALIBRATION,
    guide: IDLE_GUIDE,
    guideLost: false,
    error: null,
    announcement: null,
    settings: sanitizeSettings({ ...DEFAULT_SETTINGS, ...deps.initialSettings }),
    server: null,
    metrics: EMPTY_METRICS,
  };
  const listeners = new Set<Listener>();
  const setState = (patch: Partial<AssistantState>) => {
    let changed = false;
    for (const k of Object.keys(patch) as (keyof AssistantState)[]) {
      if (state[k] !== patch[k]) {
        changed = true;
        break;
      }
    }
    if (!changed) return;
    state = { ...state, ...patch };
    for (const l of [...listeners]) l();
  };
  const setMetrics = (patch: Partial<Metrics>) => setState({ metrics: { ...state.metrics, ...patch } });

  // ---------------------------------------------------------------------------
  // Session variables
  // ---------------------------------------------------------------------------

  let epoch = 0;
  let active = false;
  let socket: SessionSocketLike | null = null;
  let socketUnsubs: Unsubscribe[] = [];
  let socketGen = 0;
  let socketIsResume = false;
  let ready = false;
  let noReconnect = false;
  let reconnectAttempts = 0;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  /** Paused by visibility; stays true until resume() from a tap. */
  let paused = false;
  let muted = false;
  let audioSeq = 0;
  let audioStreaming = false;
  let sampler: FrameSampler | null = null;
  let samplerRunning = false;
  let framesSent = 0;
  let framesDroppedLocal = 0;
  let reconnects = 0;
  let turnOffset = 0;
  let maxLocalTurn = 0;
  let currentTurn: number | null = null;
  let cancelledThrough = 0;
  let reqCounter = 0;
  let entryCounter = 0;
  let announceId = 0;
  let busyInfo: BusyInfo | null = null;
  let busyTimer: ReturnType<typeof setTimeout> | null = null;
  let detectionTimer: ReturnType<typeof setTimeout> | null = null;
  /** Newest detections shown, per source (YOLO and Gemini frames arrive out of step). */
  const lastDetections: Partial<Record<'yolo' | 'gemini', { frameId: number; capturedAt: number }>> = {};
  let audioUnlockSettled = false;
  // Detect sampler
  let detectSampler: FrameSampler | null = null;
  let detectSamplerRunning = false;
  /** null until the user (or initialSettings) chooses; then auto-enable after ready never overrides it. */
  let detectionsChosen: boolean | null = deps.initialSettings?.detections ?? null;
  let sessionStartCuePlayed = false;
  // Find mode
  /** A find is running (local or assistant-started). state.find may also hold an inactive final status. */
  let findOn = false;
  let findReqId: string | null = null;
  /** Incremented on every find state transition (prompt de-duplication). */
  let findStateSeq = 0;
  const endedFindIds: string[] = [];
  // Guidance speech (app-generated prompts, spoken-direction words, calibration words) via the local SpeechOutput
  let guidanceQueue: GuidanceItem[] = [];
  let guidanceTimer: ReturnType<typeof setTimeout> | null = null;
  let guidanceSpeaking = false;
  let guidanceSafetyTimer: ReturnType<typeof setTimeout> | null = null;
  /** perfNow() until which mic input is still blanked after guidance TTS ended. */
  let guidanceQuietUntil = Number.NEGATIVE_INFINITY;
  const ttsWaiters = new Set<() => void>();
  let lastPromptHeard: { key: string; seq: number; at: number } | null = null;
  let lastDirectionAt = Number.NEGATIVE_INFINITY;
  // Beacon suppression / user speech (now() clock)
  let suppressedNow = false;
  let userSpeechUntil = Number.NEGATIVE_INFINITY;
  let userSpeechTimer: ReturnType<typeof setTimeout> | null = null;
  const zeroChunks = new Map<number, string>();
  // Mic policy 'release'
  let micReleased = false;
  let micRestoreOnResume = false;
  // Calibration
  let calEpoch = 0;
  let calibrating = false;
  // Detection metrics
  const detectionArrivals: { at: number; frameId: number }[] = [];
  let firstDetectionAt: number | null = null;
  // Working cue
  let workingTimer: ReturnType<typeof setTimeout> | null = null;
  // Metrics bookkeeping
  let lastSpeechAt: number | null = null;
  let lastResponseStartAt = Number.NEGATIVE_INFINITY;
  let pendingQuestion: { at: number; frameAgeMs: number | null } | null = null;
  let response: ResponseMetrics | null = null;
  const sentFrames: { sentAt: number; capturedAt: number }[] = [];
  // Instruction companion
  /** From the latest `ready`; memory only (never localStorage/sessionStorage). */
  let resumeKey: string | null = null;
  /** requestId of the guide.inspect waiting for its answer. */
  let guideInspectReq: string | null = null;
  /** guide.action requests sent and not yet answered (requestId -> action). */
  const guideActionReqs = new Map<string, GuideAction>();
  /** Snapshot-mode guide speech waiting for Gemini/other audio to finish. */
  let pendingGuideSpeech: string | null = null;

  const isActiveEpoch = (ep: number) => ep === epoch && active;
  const clientSettings = () => ({ pushToTalk: state.settings.pushToTalk, detections: state.settings.detections });
  const isUsable = () => active && ready && !paused && (state.connection === 'live' || state.connection === 'snapshot');
  const send = (msg: ClientMessage): boolean => (active && socket ? socket.send(msg) : false);

  // ---------------------------------------------------------------------------
  // Announcements & errors
  // ---------------------------------------------------------------------------

  function announce(text: string, politeness: 'polite' | 'assertive' = 'polite') {
    if (state.announcement?.text === text) return; // dedupe identical consecutive texts
    if (politeness === 'polite' && state.speaking) return;
    setState({ announcement: { id: ++announceId, text, politeness } });
  }

  const cue = (kind: Earcon) => spatial?.earcon(kind);

  function setError(error: AppError | null, announceIt = true) {
    setState({ error });
    if (error && announceIt) {
      if (error.code !== 'audio_output') cue('error');
      announce(error.message, 'assertive');
    }
  }

  function setConnection(connection: ConnectionStatus) {
    if (state.connection === connection) return;
    setState({ connection });
    const text = CONNECTION_ANNOUNCEMENTS[connection];
    if (text) announce(text, connection === 'reconnecting' ? 'assertive' : 'polite');
    updateGate();
    updateDetectSampler();
  }

  const applySpatialConfig = () => {
    const s = state.settings;
    spatial?.configure({ earcons: s.earcons, beacon: s.spatialAudio && s.guidanceMode === 'stereo', haptics: s.haptics, volume: s.cueVolume });
  };
  applySpatialConfig();

  // ---------------------------------------------------------------------------
  // Busy
  // ---------------------------------------------------------------------------

  function stopWorkingCue() {
    if (workingTimer) clearTimeout(workingTimer);
    workingTimer = null;
  }

  /** Gentle repeating tick while busy longer than workingCueDelayMs (not while connecting or speaking). */
  function startWorkingCue() {
    stopWorkingCue();
    const ep = epoch;
    const tick = (delay: number) => {
      workingTimer = setTimeout(() => {
        workingTimer = null;
        if (!isActiveEpoch(ep) || !busyInfo || busyInfo.kind === 'connecting') return;
        if (!state.speaking) cue('working');
        tick(workingCueIntervalMs);
      }, delay);
    };
    tick(workingCueDelayMs);
  }

  function setBusy(kind: BusyKind, requestId: string | null, fromTool = false, timeoutMs = busyTimeoutMs) {
    if (busyTimer) clearTimeout(busyTimer);
    if (busyInfo?.kind !== kind) {
      if (kind === 'connecting') stopWorkingCue();
      else startWorkingCue();
    }
    busyInfo = { kind, requestId, fromTool };
    setState({ busy: { kind, since: now() } });
    const ep = epoch;
    busyTimer = setTimeout(() => {
      busyTimer = null;
      if (!isActiveEpoch(ep) || !busyInfo) return;
      const k = busyInfo.kind;
      clearBusy();
      if (k === 'checking_view') guideInspectReq = null;
      if (k !== 'connecting') announce('That is taking too long. Please try again.', 'assertive');
    }, timeoutMs);
  }

  function clearBusy() {
    if (busyTimer) clearTimeout(busyTimer);
    busyTimer = null;
    stopWorkingCue();
    busyInfo = null;
    setState({ busy: null });
  }

  // ---------------------------------------------------------------------------
  // Transcript
  // ---------------------------------------------------------------------------

  function pushEntry(entry: TranscriptEntry) {
    const t = [...state.transcript, entry];
    while (t.length > LIMITS.maxTranscriptEntries) t.shift();
    setState({ transcript: t });
  }

  function appendLive(role: 'user' | 'assistant', localTurn: number, text: string, final: boolean) {
    const id = `live-${role}-${localTurn}`;
    const list = state.transcript;
    let idx = -1;
    for (let i = list.length - 1; i >= 0; i--) {
      if (list[i]!.id === id) {
        idx = i;
        break;
      }
    }
    if (idx >= 0) {
      const e = list[idx]!;
      const next: TranscriptEntry = { ...e, text: e.text + text, final: e.final || final };
      if (next.text === e.text && next.final === e.final) return;
      const copy = list.slice();
      copy[idx] = next;
      setState({ transcript: copy });
      return;
    }
    if (!text) return;
    pushEntry({ id, role, text, final, source: 'live_transcription', at: now(), turnId: localTurn });
  }

  function finalizeTurnEntries(localTurn: number) {
    appendLive('user', localTurn, '', true);
    appendLive('assistant', localTurn, '', true);
  }

  // ---------------------------------------------------------------------------
  // Mic gating
  // ---------------------------------------------------------------------------

  function audioAllowed(): boolean {
    if (!active || !ready || paused || muted || state.connection !== 'live' || !socket?.isOpen) return false;
    if (state.settings.pushToTalk && !state.talking) return false;
    // findMicPolicy 'release': only while the Talk control is held.
    if (micReleased && !state.talking) return false;
    if (state.settings.micDuringReplies === 'pause' && player.getState().playing) return false;
    return true;
  }

  function updateGate() {
    const open = audioAllowed();
    mic.setGate(open);
    if (!open && audioStreaming) {
      audioStreaming = false;
      send({ type: 'audio.end' });
    }
  }

  function zeroChunkLike(b64: string): string {
    const n = base64ToBytes(b64).length;
    let z = zeroChunks.get(n);
    if (z === undefined) {
      z = bytesToBase64(new Uint8Array(n));
      zeroChunks.set(n, z);
    }
    return z;
  }

  /** Mic input that may contain our own guidance sound (find mode, mic policy 'keep'). perfNow() clock. */
  function inGuidanceWindow(): boolean {
    const t = perfNow();
    if (guidanceSpeaking || t < guidanceQuietUntil) return true;
    const until = spatial?.audibleUntil ?? Number.NEGATIVE_INFINITY;
    return t - MIC_CHUNK_LEAD_MS < until;
  }

  function noteUserSpeech() {
    userSpeechUntil = now() + USER_SPEECH_SUPPRESS_MS;
    if (userSpeechTimer) clearTimeout(userSpeechTimer);
    userSpeechTimer = setTimeout(() => {
      userSpeechTimer = null;
      updateSuppression();
    }, USER_SPEECH_SUPPRESS_MS);
    updateSuppression();
  }

  mic.onChunk((b64) => {
    if (!active) return;
    let data = b64;
    const level = rmsOfPcm16Base64(b64);
    if (findOn && state.settings.findMicPolicy === 'keep') {
      if (inGuidanceWindow()) {
        // Never let a cue or guidance phrase become user input: send silence (keeps the stream continuous).
        data = zeroChunkLike(b64);
      } else if (level > USER_SPEECH_RMS) {
        noteUserSpeech();
      }
    }
    if (data === b64 && level > SPEECH_RMS_THRESHOLD) lastSpeechAt = now();
    if (!audioAllowed()) return; // dropped: never queued (e.g. while reconnecting)
    if (send({ type: 'audio', seq: audioSeq++, data })) audioStreaming = true;
  });

  // ---------------------------------------------------------------------------
  // Mirrors of the media stores
  // ---------------------------------------------------------------------------

  /** Beacon silent while anything is speaking, the user is talking, or calibration runs. */
  function updateSuppression() {
    const s =
      player.getState().playing ||
      speech.speaking ||
      guidanceSpeaking ||
      now() < userSpeechUntil ||
      (micReleased && state.talking) ||
      calibrating;
    if (s === suppressedNow) return;
    suppressedNow = s;
    spatial?.setSuppressed(s);
  }

  const refreshSpeaking = () => {
    const speaking = player.getState().playing || speech.speaking;
    setState({ speaking });
    // Earcons stay audible under speech, at ~30%; beacon pulses are suppressed entirely.
    spatial?.setDucked(speaking);
    updateSuppression();
  };

  camera.subscribe(() => {
    const cs = camera.getState();
    setState({ camera: cs });
    if (!findOn || !active) return;
    if (cs.facing === 'user') {
      stopFindNow();
      showLocalFindError(state.find?.query ?? '', REAR_CAMERA_PROMPT);
    } else if (cs.status !== 'active' && cs.status !== 'paused') {
      // Camera failure: no picture, so no guidance. ('paused' = page hidden, handled by visibility.)
      stopFindNow();
      announce(CAMERA_STOPPED_FIND_TEXT, 'assertive');
    }
  });
  mic.subscribe(() => setState({ mic: mic.getState() }));
  player.subscribe(() => {
    const p = player.getState();
    setState({ player: p });
    refreshSpeaking();
    updateGate();
    if (!p.playing) {
      pumpGuidance();
      flushPendingGuideSpeech();
    }
    if (!active || !audioUnlockSettled) return;
    if (p.contextState === 'suspended' && !paused) {
      if (state.error?.action !== 'tap_to_resume') {
        setError({ code: 'audio_output', message: 'Sound is paused by the browser. Tap to resume.', recoverable: true, action: 'tap_to_resume' });
      }
    } else if (p.contextState === 'running' && state.error?.code === 'audio_output') {
      setError(null);
    }
  });
  speech.onSpeakingChange?.((speaking) => {
    if (!speaking) onTtsEnded();
    refreshSpeaking();
    if (speaking && response && !response.gotAudio && response.questionEnd !== null && response.key.startsWith('answer:')) {
      response.gotAudio = true;
      setMetrics({ questionToFirstAudioMs: Math.max(0, now() - response.questionEnd) });
    }
  });
  player.onTurnAudible((turnId, at) => {
    if (!response || response.gotAudio || response.key !== `turn:${turnId}` || response.questionEnd === null) return;
    response.gotAudio = true;
    const audibleEpoch = now() - (perfNow() - at);
    setMetrics({ questionToFirstAudioMs: Math.max(0, Math.round(audibleEpoch - response.questionEnd)) });
  });

  // ---------------------------------------------------------------------------
  // Metrics helpers
  // ---------------------------------------------------------------------------

  function recordFrameSent(frame: Pick<FramePayload, 'capturedAt'>) {
    sentFrames.push({ sentAt: now(), capturedAt: frame.capturedAt });
    while (sentFrames.length > 20) sentFrames.shift();
  }

  function frameAgeBefore(t: number): number | null {
    for (let i = sentFrames.length - 1; i >= 0; i--) {
      const f = sentFrames[i]!;
      if (f.sentAt <= t) return Math.max(0, t - f.capturedAt);
    }
    return null;
  }

  function beginResponse(key: string) {
    let questionEnd: number | null = null;
    let frameAge: number | null = null;
    if (pendingQuestion) {
      questionEnd = pendingQuestion.at;
      frameAge = pendingQuestion.frameAgeMs;
      pendingQuestion = null;
    } else if (lastSpeechAt !== null && lastSpeechAt > lastResponseStartAt) {
      questionEnd = lastSpeechAt;
      frameAge = frameAgeBefore(lastSpeechAt);
    }
    lastResponseStartAt = now();
    response = { key, questionEnd, gotText: false, gotAudio: false };
    setMetrics({ frameAgeAtQuestionMs: frameAge, questionToFirstTextMs: null, questionToFirstAudioMs: null });
  }

  function markFirstText(key: string) {
    if (!response || response.key !== key || response.gotText || response.questionEnd === null) return;
    response.gotText = true;
    setMetrics({ questionToFirstTextMs: Math.max(0, now() - response.questionEnd) });
  }

  const updateFrameMetrics = () =>
    setMetrics({ framesSent, framesDropped: framesDroppedLocal + (sampler?.droppedCount ?? 0), reconnects });

  // ---------------------------------------------------------------------------
  // Sampler
  // ---------------------------------------------------------------------------

  function onSampledFrame(frame: CapturedFrame) {
    if (!active || paused) return;
    const canSend =
      ready && state.connection === 'live' && socket !== null && socket.isOpen && socket.bufferedAmount < MAX_BUFFERED_FOR_FRAMES;
    if (canSend && send({ type: 'frame', frame })) {
      framesSent++;
      recordFrameSent(frame);
    } else {
      framesDroppedLocal++;
    }
    updateFrameMetrics();
  }

  function startSampler() {
    if (samplerRunning || !active || paused) return;
    sampler ??= deps.createSampler(camera);
    samplerRunning = true;
    sampler.start(onSampledFrame);
  }

  function stopSampler() {
    if (!samplerRunning) return;
    samplerRunning = false;
    sampler?.stop();
  }

  // ---------------------------------------------------------------------------
  // Detect sampler (small frames for the detector / find; never sent to Live)
  // ---------------------------------------------------------------------------

  function wantDetectFrames(): boolean {
    if (!deps.createDetectSampler || !active || !ready || paused) return false;
    if (state.connection !== 'live' && state.connection !== 'snapshot') return false;
    if (doc && doc.visibilityState === 'hidden') return false;
    return (state.settings.detections && state.server?.detector === true) || findOn;
  }

  function onDetectFrame(frame: CapturedFrame) {
    if (!wantDetectFrames() || !socket || !socket.isOpen) return;
    if (socket.bufferedAmount >= MAX_BUFFERED_FOR_DETECT) return; // drop: never queue detection frames
    send({ type: 'detect.frame', frame });
  }

  function updateDetectSampler() {
    const want = wantDetectFrames();
    if (want && !detectSamplerRunning) {
      detectSampler ??= deps.createDetectSampler!(camera);
      detectSamplerRunning = true;
      detectSampler.start(onDetectFrame);
    } else if (!want && detectSamplerRunning) {
      detectSamplerRunning = false;
      detectSampler?.stop();
    }
  }

  // ---------------------------------------------------------------------------
  // Playback control
  // ---------------------------------------------------------------------------

  /** Flush everything playing now and reject the rest of those turns. */
  function flushAllPlayback() {
    const t = Math.max(currentTurn ?? 0, player.getState().turnId ?? 0, maxLocalTurn);
    if (t > 0) cancelledThrough = Math.max(cancelledThrough, t);
    player.flush(t > 0 ? t : undefined);
    cancelGuidance(); // queued guidance must not start when the cancelled speech ends
    speech.cancel();
  }

  // ---------------------------------------------------------------------------
  // Socket
  // ---------------------------------------------------------------------------

  function detachSocket(): SessionSocketLike | null {
    for (const u of socketUnsubs) u();
    socketUnsubs = [];
    const s = socket;
    socket = null;
    socketGen++;
    ready = false;
    audioStreaming = false;
    // Unanswered guide requests die with the socket (never replayed); the guide itself is kept for a restore.
    guideInspectReq = null;
    guideActionReqs.clear();
    pendingGuideSpeech = null;
    return s;
  }

  function openSocket(resume: boolean) {
    const gen = ++socketGen;
    const sock = deps.createSocket();
    socket = sock;
    socketIsResume = resume;
    ready = false;
    let helloSent = false;
    const sendHello = () => {
      if (helloSent || gen !== socketGen || !active) return;
      helloSent = true;
      sock.send({
        type: 'hello',
        protocolVersion: PROTOCOL_VERSION,
        mode: state.mode,
        settings: clientSettings(),
        clientTime: now(),
        ...(resume ? { resume: true } : {}),
        ...(resumeKey ? { resumeKey } : {}),
      });
    };
    socketUnsubs = [
      sock.onOpen(sendHello),
      sock.onMessage((m) => {
        if (gen === socketGen && active) handleServer(m);
      }),
      sock.onClose(() => onSocketClose(gen)),
    ];
    if (sock.isOpen) sendHello();
  }

  function onSocketClose(gen: number) {
    if (gen !== socketGen || !active) return;
    detachSocket();
    flushAllPlayback();
    stopSampler();
    // The server-side find (and its session) is gone with the socket.
    endFindLocal();
    if (busyInfo && busyInfo.kind !== 'connecting') clearBusy();
    updateDetectSampler();
    if (noReconnect) {
      if (state.connection !== 'error') setConnection('ended');
      return;
    }
    scheduleReconnect();
  }

  function scheduleReconnect() {
    if (reconnectAttempts >= LIMITS.maxClientReconnectAttempts) {
      clearBusy();
      setConnection('error');
      setError({ code: 'network', message: 'Lost the connection to the Sightline server.', recoverable: true, action: 'retry' });
      return;
    }
    const delay = reconnectDelay(reconnectAttempts++);
    setConnection(paused ? 'paused' : 'reconnecting');
    const ep = epoch;
    if (reconnectTimer) clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      if (isActiveEpoch(ep)) openSocket(true);
    }, delay);
  }

  // ---------------------------------------------------------------------------
  // Server messages
  // ---------------------------------------------------------------------------

  const localTurn = (serverTurnId: number) => turnOffset + serverTurnId;

  function onReady(msg: ServerMessageOf<'ready'>) {
    ready = true;
    reconnectAttempts = 0;
    turnOffset = maxLocalTurn;
    if (socketIsResume) reconnects++;
    updateFrameMetrics();
    const target: ConnectionStatus = msg.mode === 'live' && msg.features.live ? 'live' : msg.features.snapshot ? 'snapshot' : 'error';
    setState({
      mode: msg.mode,
      server: {
        configured: msg.features.live || msg.features.snapshot,
        liveModel: msg.models.live,
        visionModel: msg.models.vision,
        detector: msg.features.detections,
        sessionId: msg.sessionId,
        timeZone: msg.timeZone ?? null,
      },
    });
    if (busyInfo?.kind === 'connecting') clearBusy();
    if (state.error?.code === 'network') setError(null);
    if (msg.resumeKey) resumeKey = msg.resumeKey;
    const guideLostNow = state.guide.phase !== 'idle' && !msg.guideRestored;
    if (guideLostNow) {
      // The server could not re-attach the guide: never pretend it is still there.
      setState({ guide: { ...IDLE_GUIDE, goal: state.guide.goal }, guideLost: true });
    }
    // Said after the connection status (single announcement slot: the last one wins).
    const sayGuideLost = () => {
      if (guideLostNow) announce(GUIDE_LOST_TEXT, 'assertive');
    };
    // Detection overlays default to on when the server has a detector, unless the user chose otherwise.
    if (msg.features.detections && detectionsChosen === null && !state.settings.detections) {
      setState({ settings: { ...state.settings, detections: true } });
      send({ type: 'settings', settings: clientSettings() });
    }
    if (paused) {
      send({ type: 'visibility', state: 'hidden' });
      setConnection('paused');
      sayGuideLost();
      return;
    }
    if (!sessionStartCuePlayed && target !== 'error') {
      sessionStartCuePlayed = true;
      cue('session_start');
    }
    setConnection(target);
    sayGuideLost();
    if (target === 'live') startSampler();
    updateDetectSampler();
  }

  function onStatus(msg: ServerMessageOf<'status'>) {
    if (msg.state === 'closed') {
      noReconnect = true;
      return;
    }
    if (!ready || paused) return;
    switch (msg.state) {
      case 'live':
        if (state.connection === 'reconnecting' || state.connection === 'snapshot') setConnection('live');
        if (state.connection === 'live') startSampler();
        return;
      case 'reconnecting':
        if (state.connection === 'live') {
          stopSampler();
          setConnection('reconnecting');
        }
        return;
      case 'snapshot':
        stopSampler();
        setState({ mode: 'snapshot' });
        setConnection('snapshot');
        return;
      default:
        return;
    }
  }

  function onTurn(msg: ServerMessageOf<'turn'>) {
    const local = localTurn(msg.turnId);
    maxLocalTurn = Math.max(maxLocalTurn, local);
    switch (msg.event) {
      case 'start':
        if (local <= cancelledThrough) return;
        currentTurn = local;
        if (busyInfo && !busyInfo.fromTool && busyInfo.kind !== 'connecting' && busyInfo.kind !== 'finding' && busyInfo.kind !== 'checking_view') {
          clearBusy();
        }
        beginResponse(`turn:${local}`);
        return;
      case 'interrupted':
        // Barge-in: silence immediately and reject any late chunks of this turn.
        cancelledThrough = Math.max(cancelledThrough, local);
        player.flush(local);
        finalizeTurnEntries(local);
        return;
      case 'generation_complete':
        return;
      case 'complete':
      case 'cancelled':
        finalizeTurnEntries(local);
        if (currentTurn === local) currentTurn = null;
        return;
    }
  }

  async function onSnapshotRequest(msg: ServerMessageOf<'snapshot.request'>) {
    const ep = epoch;
    const gen = socketGen;
    const reply = (m: ClientMessage) => {
      if (isActiveEpoch(ep) && gen === socketGen) send(m);
    };
    const unavailable = (reason: Extract<ClientMessage, { type: 'snapshot.unavailable' }>['reason']) =>
      reply({ type: 'snapshot.unavailable', requestId: msg.requestId, reason });
    if (paused || doc?.visibilityState === 'hidden') return unavailable('backgrounded');
    const cs = camera.getState().status;
    if (cs === 'denied') return unavailable('camera_denied');
    if (cs === 'requesting') return unavailable('not_ready');
    if (cs !== 'active') return unavailable('camera_off');
    let frame: CapturedFrame | null;
    try {
      frame =
        msg.purpose === 'read_label' || msg.purpose === 'guide'
          ? await captureLabelStill()
          : await camera.capture({ maxDim: Math.min(msg.maxDim, LIMITS.snapshotMaxDim), jpegQuality: LIMITS.snapshotJpegQuality });
    } catch {
      return unavailable('error');
    }
    if (!isActiveEpoch(ep) || gen !== socketGen) return;
    if (!frame) return unavailable('not_ready');
    reply({ type: 'snapshot.result', requestId: msg.requestId, frame });
    recordFrameSent(frame);
  }

  /**
   * Best still for reading small print: camera.captureStill (full-resolution photo or sharpest of a few frames),
   * falling back to a normal high-res capture. A soft tick says "hold still"; the shutter cue + haptic mark the
   * moment the photo is taken.
   */
  /**
   * If the camera is still starting (permission prompt / getUserMedia in flight), wait for it briefly instead of
   * failing: users tap "Guide me" or "Read label" right after Start. Denied/failed cameras return at once.
   */
  async function waitForCameraStarting(maxMs = 5_000): Promise<void> {
    if (camera.getState().status !== 'requesting') return;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(done, maxMs);
      const unsub = camera.subscribe(() => {
        if (camera.getState().status !== 'requesting') done();
      });
      function done() {
        clearTimeout(timer);
        unsub();
        resolve();
      }
    });
  }

  async function captureLabelStill(): Promise<CapturedFrame | null> {
    if (camera.getState().status === 'requesting') await waitForCameraStarting();
    cue('listening');
    let frame: CapturedFrame | null = null;
    if (typeof camera.captureStill === 'function') {
      try {
        frame = await camera.captureStill({ maxDim: LIMITS.detailMaxDim, jpegQuality: LIMITS.detailJpegQuality, bestOf: LIMITS.detailBestOf });
      } catch {
        frame = null;
      }
    }
    frame ??= await camera.capture({ maxDim: LIMITS.snapshotMaxDim, jpegQuality: LIMITS.snapshotJpegQuality });
    if (frame) cue('capture');
    return frame;
  }

  function summarizeEvidence(e: LabelEvidence): string {
    const parts = [`Label read (${e.readability})`];
    if (e.exactText.length) parts.push(`${e.exactText.length} text section${e.exactText.length === 1 ? '' : 's'}`);
    if (e.instructions.length) parts.push(`${e.instructions.length} instruction set${e.instructions.length === 1 ? '' : 's'}`);
    if (e.dates.length) parts.push(`${e.dates.length} date${e.dates.length === 1 ? '' : 's'}`);
    return `${parts.join(', ')}.`;
  }

  /** detectionAgeMs / detectionRate from a detection result or find observation (capture time, client clock). */
  function recordDetectionResult(frameId: number | null, capturedAt: number) {
    const t = now();
    const age = Math.max(0, Math.round(t - capturedAt));
    const id = frameId ?? -1;
    if (id >= 0 && detectionArrivals.some((a) => a.frameId === id)) {
      setMetrics({ detectionAgeMs: age }); // same frame already counted (detections + find for one frame)
      return;
    }
    detectionArrivals.push({ at: t, frameId: id });
    firstDetectionAt ??= t;
    while (detectionArrivals.length && detectionArrivals[0]!.at <= t - DETECTION_RATE_WINDOW_MS) detectionArrivals.shift();
    const windowMs = Math.min(DETECTION_RATE_WINDOW_MS, Math.max(1_000, t - firstDetectionAt));
    const rate = Math.round((detectionArrivals.length / (windowMs / 1000)) * 10) / 10;
    setMetrics({ detectionAgeMs: age, detectionRate: rate });
  }

  function onDetections(msg: ServerDetections) {
    recordDetectionResult(msg.frameId, msg.capturedAt);
    if (!state.settings.detections && !findOn) return;
    const source = msg.source ?? 'yolo';
    const last = lastDetections[source];
    if (last && (msg.frameId < last.frameId || (msg.frameId === last.frameId && msg.capturedAt <= last.capturedAt))) {
      return; // older than what we have shown from this source
    }
    const ttl = msg.capturedAt + (source === 'gemini' ? GEMINI_DETECTION_TTL_MS : LIMITS.detectionTtlMs) - now();
    if (ttl <= 0) return;
    lastDetections[source] = { frameId: msg.frameId, capturedAt: msg.capturedAt };
    setState({ detections: msg });
    if (detectionTimer) clearTimeout(detectionTimer);
    detectionTimer = setTimeout(() => {
      detectionTimer = null;
      if (state.detections === msg) setState({ detections: null });
    }, ttl);
  }

  // ---------------------------------------------------------------------------
  // Guidance speech (local browser TTS for app-generated text only)
  // ---------------------------------------------------------------------------

  function clearGuidanceSafety() {
    if (guidanceSafetyTimer) clearTimeout(guidanceSafetyTimer);
    guidanceSafetyTimer = null;
  }

  /** TTS finished (or was cancelled): release guidance state, wake waiters and the queue. */
  function onTtsEnded() {
    if (guidanceSpeaking) {
      guidanceSpeaking = false;
      guidanceQuietUntil = perfNow() + GUIDANCE_TTS_TAIL_MS;
    }
    clearGuidanceSafety();
    for (const w of [...ttsWaiters]) w();
    ttsWaiters.clear();
    updateSuppression();
    pumpGuidance();
  }

  /** Speak one short app-generated phrase now. Marks guidance speech (beacon suppressed, mic blanked). */
  function speakGuidance(text: string) {
    guidanceSpeaking = true;
    updateSuppression();
    clearGuidanceSafety();
    // Without speaking-change events (or if the engine never reports the end) do not stay "speaking" forever.
    guidanceSafetyTimer = setTimeout(
      () => {
        guidanceSafetyTimer = null;
        if (guidanceSpeaking) onTtsEnded();
      },
      1_200 + text.length * 90,
    );
    speech.speak(text);
  }

  /** Resolves when the phrase has been spoken (or immediately when TTS is unavailable). */
  function speakAndWait(text: string): Promise<void> {
    if (!speech.supported) return Promise.resolve();
    return new Promise<void>((resolve) => {
      ttsWaiters.add(resolve);
      speakGuidance(text);
    });
  }

  function cancelGuidance() {
    guidanceQueue = [];
    if (guidanceTimer) clearTimeout(guidanceTimer);
    guidanceTimer = null;
    if (guidanceSpeaking) {
      guidanceSpeaking = false;
      speech.cancel();
    }
    clearGuidanceSafety();
    for (const w of [...ttsWaiters]) w();
    ttsWaiters.clear();
    updateSuppression();
  }

  function promptStillValid(it: GuidanceItem, t: number): boolean {
    if (t - it.queuedAt > GUIDANCE_MAX_AGE_MS) return false;
    if (it.final) return true;
    if (!findOn || !state.find) return false;
    const states = PROMPT_STATES[it.kind];
    if (states && !states.includes(state.find.state)) return false;
    // A tilt hint for a different target is wrong now.
    if (isTilt(it.kind) && it.trackId !== null && state.find.trackId !== it.trackId) return false;
    return true;
  }

  function pumpGuidance() {
    if (guidanceTimer) clearTimeout(guidanceTimer);
    guidanceTimer = null;
    if (!guidanceQueue.length || calibrating) return;
    if (guidanceSpeaking || speech.speaking) return; // resumes on the speaking-change event / safety timer
    const t = now();
    guidanceQueue = guidanceQueue.filter((it) => promptStillValid(it, t));
    const item = guidanceQueue[0];
    if (!item) return;
    let wakeAt = item.notBefore;
    // Do not talk over Gemini: wait for its audio to end (player subscription pumps), at most a few seconds.
    if (player.getState().playing) wakeAt = Math.max(wakeAt, item.queuedAt + GUIDANCE_WAIT_FOR_ASSISTANT_MS);
    if (t < wakeAt) {
      guidanceTimer = setTimeout(pumpGuidance, wakeAt - t);
      return;
    }
    guidanceQueue.shift();
    speakGuidance(item.text);
  }

  /** Queue an app-generated find prompt to be spoken once. */
  function enqueuePrompt(prompt: { kind: FindPromptKind; text: string }, final = false) {
    const text = prompt.text.trim();
    if (!text) return;
    // Spoken-direction mode already says Up/Down: skip the server's tilt hints there.
    if (!final && isTilt(prompt.kind) && state.settings.guidanceMode === 'spoken') return;
    const t = now();
    const key = `${prompt.kind}|${text}`;
    if (lastPromptHeard && lastPromptHeard.key === key && lastPromptHeard.seq === findStateSeq && t - lastPromptHeard.at < LIMITS.findPromptMinIntervalMs) {
      return; // the same prompt repeated in consecutive updates: speak it once
    }
    lastPromptHeard = { key, seq: findStateSeq, at: t };
    if (!speech.supported) {
      announce(text); // no TTS: the screen reader is the only voice
      return;
    }
    const family = promptFamily(prompt.kind);
    guidanceQueue = guidanceQueue.filter((it) => promptFamily(it.kind) !== family); // newer replaces unspoken older
    guidanceQueue.push({
      kind: prompt.kind,
      text,
      queuedAt: t,
      notBefore: t + (prompt.kind === 'centred' ? CENTRED_SPEECH_DELAY_MS : 0),
      trackId: state.find?.trackId ?? null,
      final,
    });
    pumpGuidance();
  }

  /** Spoken-direction mode: one short word from a fresh target, throttled, never over other speech. */
  function maybeSpeakDirection(cue: CueTarget) {
    if (state.settings.guidanceMode !== 'spoken' || !speech.supported || cue.centered || calibrating) return;
    if (!isFresh(cue.observedAt)) return;
    if (player.getState().playing || speech.speaking || guidanceSpeaking || guidanceQueue.length > 0) return;
    if (now() < userSpeechUntil) return;
    const t = now();
    if (t - lastDirectionAt < SPOKEN_DIRECTION_INTERVAL_MS) return;
    const word = directionWord(cue.cx, cue.cy);
    if (!word) return;
    lastDirectionAt = t;
    speakGuidance(word);
  }

  // ---------------------------------------------------------------------------
  // Find mode (image-relative aiming help)
  // ---------------------------------------------------------------------------

  const isFresh = (observedAt: number) => now() - observedAt <= LIMITS.findObservationMaxAgeMs;

  /** Beacon target from a fresh observation of the selected target only. */
  function cueTargetFor(msg: ServerMessageOf<'find'>): CueTarget | null {
    if ((msg.state !== 'tracking' && msg.state !== 'centered') || !msg.target) return null;
    const observedAt = msg.observedAt;
    if (typeof observedAt !== 'number' || !isFresh(observedAt)) return null;
    const { cx, cy } = boxCenter(msg.target.box);
    return { cx, cy, area: boxArea(msg.target.box), centered: msg.state === 'centered', observedAt };
  }

  /** Silence every find cue now: beacon pulses and guidance speech. */
  function stopFindCues() {
    spatial?.stopTracking();
    cancelGuidance();
    lastDirectionAt = Number.NEGATIVE_INFINITY;
    if (userSpeechTimer) clearTimeout(userSpeechTimer);
    userSpeechTimer = null;
    userSpeechUntil = Number.NEGATIVE_INFINITY;
  }

  /**
   * findMicPolicy 'release': close the mic while a find runs (Talk reopens it while held); reopen on find end.
   * On Android an open Bluetooth headset mic usually switches earbuds to mono call audio, collapsing the beacon.
   */
  function applyFindMicPolicy() {
    const want = active && findOn && state.settings.findMicPolicy === 'release';
    if (want && !micReleased) {
      const s = mic.getState().status;
      if (s !== 'active' && s !== 'muted' && s !== 'requesting') return; // nothing open to release
      micReleased = true;
      if (!state.talking) mic.stop();
      updateGate();
    } else if (!want && micReleased) {
      micReleased = false;
      if (active) {
        if (paused || doc?.visibilityState === 'hidden') micRestoreOnResume = true;
        else restartMic();
      }
      updateGate();
      updateSuppression();
    }
  }

  function restartMic() {
    const ep = epoch;
    void mic
      .start()
      .catch(() => undefined)
      .then(() => {
        if (!isActiveEpoch(ep)) return;
        mic.setMuted(muted);
        updateGate();
      });
  }

  /** Forget the current find locally (no message to the server); late updates for it are ignored. */
  function endFindLocal(announceText?: string, keepMicPolicy = false) {
    if (!findOn && findReqId === null && state.find === null) return;
    if (findReqId) {
      endedFindIds.push(findReqId);
      while (endedFindIds.length > 20) endedFindIds.shift();
    }
    findOn = false;
    findReqId = null;
    lastPromptHeard = null;
    stopFindCues();
    if (busyInfo?.kind === 'finding') clearBusy();
    setState({ find: null });
    if (!keepMicPolicy) applyFindMicPolicy();
    updateSuppression();
    updateDetectSampler();
    if (announceText) announce(announceText);
  }

  /** Immediate local stop (cues first), then tell the server. */
  function stopFindNow(announceText?: string) {
    stopFindCues();
    if (findOn) send({ type: 'find.stop' });
    endFindLocal(announceText);
  }

  /** An inactive find status that only carries a message (e.g. rear camera required), spoken once. */
  function showLocalFindError(query: string, text: string) {
    setState({
      find: {
        query,
        state: 'error',
        source: 'yolo',
        target: null,
        description: null,
        updatedAt: now(),
        trackId: null,
        observedAt: null,
        candidates: [],
        lastPrompt: { kind: 'error', text },
      },
    });
    lastPromptHeard = null;
    enqueuePrompt({ kind: 'error', text }, true);
  }

  // ---------------------------------------------------------------------------
  // Stereo calibration (user-initiated)
  // ---------------------------------------------------------------------------

  const setCalibration = (patch: Partial<CalibrationState>) => setState({ calibration: { ...state.calibration, ...patch } });

  /** Stop calibration tones and words now; the beacon may resume. */
  function stopCalibration() {
    calEpoch++;
    const wasCalibrating = calibrating;
    calibrating = false;
    if (wasCalibrating) {
      const ext = spatial as (SpatialCueEngine & { cancelCalibrationTone?: () => void }) | null;
      if (ext?.cancelCalibrationTone) ext.cancelCalibrationTone();
      else if (!findOn) spatial?.stopTracking();
      if (guidanceSpeaking) {
        guidanceSpeaking = false;
        speech.cancel();
      }
      clearGuidanceSafety();
      for (const w of [...ttsWaiters]) w();
      ttsWaiters.clear();
    }
    updateSuppression();
    pumpGuidance();
  }

  async function runCalibration(unlockP: Promise<void>) {
    const my = ++calEpoch;
    calibrating = true;
    cancelGuidance(); // nothing else may talk during the test
    if (player.getState().playing) controller.stopSpeaking();
    const m = mic.getState().status;
    // Bluetooth routing may differ (mono call audio) while the microphone is open: record it with the result.
    setState({ calibration: { step: 'left', heardSeparation: null, micActive: m === 'active' || m === 'muted' } });
    updateSuppression();
    await unlockP.catch(() => undefined);
    const steps = ['left', 'right', 'centre'] as const;
    for (const ch of steps) {
      if (my !== calEpoch) return;
      setCalibration({ step: ch });
      // speechSynthesis cannot be panned, so the word is heard centred; the TONE carries the channel.
      await speakAndWait(CALIBRATION_PHRASES[ch]);
      if (my !== calEpoch) return;
      await (spatial?.calibrationTone(ch) ?? Promise.resolve());
    }
    if (my !== calEpoch) return;
    setCalibration({ step: 'confirm' }); // the UI asks "Did you hear left, then right, then both?"
  }

  const FINAL_FALLBACK: Partial<Record<FindState, (q: string) => string>> = {
    not_found: (q) => `Could not find ${q} in the picture.`,
    timeout: (q) => `Stopped finding ${q}: time limit reached.`,
    stopped: (q) => `Stopped finding ${q}.`,
    unsupported: (q) => `Find cannot look for ${q}.`,
    error: () => 'Find is not available right now.',
  };

  function onFind(msg: ServerMessageOf<'find'>) {
    if (msg.requestId && endedFindIds.includes(msg.requestId)) return; // stopped locally / replaced
    const q = msg.query;
    if (TERMINAL_FIND.has(msg.state)) {
      if (!findOn || msg.requestId !== findReqId) return;
      if (msg.state === 'not_found') cue('lost');
      else if (msg.state === 'error') cue('error');
      endFindLocal();
      const text = msg.prompt?.text ?? FINAL_FALLBACK[msg.state]?.(q) ?? `Stopped finding ${q}.`;
      if (msg.state !== 'stopped') {
        // Keep an inactive final status so the UI can show why (cleared by stopFind() or the next find).
        setState({
          find: {
            query: q,
            state: msg.state,
            source: msg.source,
            target: null,
            description: msg.description,
            updatedAt: now(),
            trackId: null,
            observedAt: null,
            candidates: [],
            lastPrompt: msg.prompt ?? null,
          },
        });
      }
      if (msg.prompt && speech.supported) enqueuePrompt(msg.prompt, true);
      else announce(text);
      return;
    }
    if (!findOn || msg.requestId !== findReqId) {
      // A find started by the assistant (find_object tool), or a replacement: silence the old one first.
      if (findOn) {
        stopFindCues();
        if (findReqId) endedFindIds.push(findReqId);
      }
      findOn = true;
      findReqId = msg.requestId;
      findStateSeq++;
      lastPromptHeard = null;
      setState({ find: null });
    }
    const prev = state.find;
    const stateChanged = prev?.state !== msg.state;
    if (stateChanged) findStateSeq++;
    const trackId = msg.trackId ?? null;
    if (prev && prev.trackId !== null && trackId !== null && prev.trackId !== trackId) {
      // A different object is now the target: never let cues for the old one continue.
      spatial?.setTarget(null);
      guidanceQueue = guidanceQueue.filter((it) => !isTilt(it.kind));
    }
    const status: FindStatus = {
      query: q,
      state: msg.state,
      source: msg.source,
      target: msg.target,
      description: msg.description,
      updatedAt: now(),
      trackId,
      observedAt: msg.observedAt ?? null,
      candidates: msg.candidates ?? [],
      lastPrompt: msg.prompt ?? prev?.lastPrompt ?? null,
    };
    setState({ find: status });
    if (typeof msg.observedAt === 'number') recordDetectionResult(msg.frameId, msg.observedAt);
    spatial?.startTracking();
    switch (msg.state) {
      case 'searching':
        if (busyInfo?.kind !== 'finding') setBusy('finding', msg.requestId);
        break;
      case 'needs_selection':
      case 'tracking':
      case 'centered':
        if (busyInfo?.kind === 'finding') clearBusy();
        break;
      default:
        break;
    }
    const cueTarget = cueTargetFor(msg);
    spatial?.setTarget(cueTarget);
    if (stateChanged) {
      // Drop queued prompts that no longer fit (e.g. a tilt hint once centred or lost).
      const t = now();
      guidanceQueue = guidanceQueue.filter((it) => promptStillValid(it, t));
      if (msg.state === 'centered') cue('found'); // confirmation chime + haptic, once per centring
      else if (msg.state === 'lost' && prev && prev.state !== 'searching') cue('lost');
    }
    if (msg.prompt) enqueuePrompt(msg.prompt);
    else if (stateChanged && msg.state === 'needs_selection' && status.candidates.length > 0) {
      // Not spoken: give screen-reader users the choice as polite text (one announcement per state change).
      announce(`${status.candidates.length} matches: ${status.candidates.map((c) => `${c.position} ${c.label}`).join(', ')}. Choose one.`);
    }
    if (cueTarget) maybeSpeakDirection(cueTarget);
    applyFindMicPolicy();
    updateDetectSampler();
  }

  // ---------------------------------------------------------------------------
  // Instruction companion (server-owned guide snapshots)
  // ---------------------------------------------------------------------------

  /** Snapshot mode only: app speech for guide changes (local TTS). Live mode: the model speaks instead. */
  const guideSpokenByApp = () =>
    state.connection === 'snapshot' && state.settings.speakSnapshotAnswers && speech.supported && !paused;

  function flushPendingGuideSpeech() {
    if (pendingGuideSpeech === null || player.getState().playing) return;
    const text = pendingGuideSpeech;
    pendingGuideSpeech = null;
    if (!active || calibrating) return;
    speakGuideNow(text);
  }

  /** One speech engine at a time: drop queued find guidance and replace any TTS in progress. */
  function speakGuideNow(text: string) {
    guidanceQueue = [];
    if (guidanceTimer) clearTimeout(guidanceTimer);
    guidanceTimer = null;
    speakGuidance(text); // speak() replaces the current utterance (no overlap)
  }

  function speakGuide(text: string) {
    if (calibrating) return;
    if (player.getState().playing) {
      pendingGuideSpeech = text; // never over Gemini audio; newest wins
      return;
    }
    pendingGuideSpeech = null;
    speakGuideNow(text);
  }

  function onGuide(msg: ServerMessageOf<'guide'>) {
    const reqId = msg.requestId;
    let cause: GuideCause = null;
    if (reqId && reqId === guideInspectReq) cause = 'inspect';
    else if (reqId && guideActionReqs.has(reqId)) cause = guideActionReqs.get(reqId)!;
    if (reqId) guideActionReqs.delete(reqId);
    const rejected = msg.result !== null && !msg.result.ok;
    const prev = state.guide;
    const next = msg.guide;
    const apply = isNewerGuide(prev, next);
    if (apply) setState({ guide: next, ...(next.phase !== 'idle' ? { guideLost: false } : {}) });
    // A view check is over once it is answered with a settled phase (or rejected); a tool-started check once
    // any settled snapshot arrives.
    const settled = next.phase !== 'acquiring_image' && next.phase !== 'preparing_guide';
    const mine = reqId !== null && reqId === guideInspectReq;
    if (mine && (settled || rejected)) guideInspectReq = null;
    if (busyInfo?.kind === 'checking_view') {
      const forBusy = mine || (busyInfo.fromTool && reqId === null) || (busyInfo.requestId !== null && busyInfo.requestId === reqId);
      if (forBusy && (settled || rejected)) clearBusy();
    }
    if (rejected) {
      const text = guideRejectText(msg.result?.code ?? null);
      if (text) {
        // Shown in the guide status line (until the next snapshot) and said once, briefly.
        setState({ guide: { ...state.guide, message: text } });
        if (guideSpokenByApp()) speakGuide(text);
        else announce(text);
      }
      return;
    }
    if (!apply) return;
    if (guideSpokenByApp()) {
      const text = guideSpeech(prev, next, cause);
      if (text) speakGuide(text);
      return;
    }
    const text = guideAnnouncement(prev, next, cause, state.connection === 'live');
    if (text) announce(text);
  }

  function onServerError(msg: ServerMessageOf<'error'>) {
    if (msg.requestId && msg.requestId === findReqId) endFindLocal();
    if (msg.requestId && msg.requestId === guideInspectReq) guideInspectReq = null;
    if (msg.requestId) guideActionReqs.delete(msg.requestId);
    if (busyInfo && ((msg.requestId && busyInfo.requestId === msg.requestId) || (msg.code === 'snapshot_timeout' && busyInfo.fromTool))) {
      clearBusy();
    }
    if (msg.fallback === 'snapshot') {
      stopSampler();
      setState({ mode: 'snapshot' });
      setError({ code: msg.code, message: msg.message, recoverable: true, action: 'none' });
      return;
    }
    if (!msg.recoverable) {
      noReconnect = true;
      // The session cannot continue: release camera, microphone, playback and the socket now. (For
      // missing credentials the UI returns to the Start screen, which has no End button.)
      teardown();
      setState({ busy: null, talking: false, detections: null, speaking: false });
      setConnection('error');
      setError({ code: msg.code, message: msg.message, recoverable: false, action: msg.code === 'missing_credentials' ? 'none' : 'retry' });
      return;
    }
    setError({ code: msg.code, message: msg.message, recoverable: true, action: 'none' });
  }

  function handleServer(msg: ServerMessage) {
    switch (msg.type) {
      case 'ready':
        return onReady(msg);
      case 'status':
        return onStatus(msg);
      case 'audio': {
        const local = localTurn(msg.turnId);
        if (local <= cancelledThrough || paused) return;
        player.enqueue(local, msg.data);
        return;
      }
      case 'transcript': {
        const local = localTurn(msg.turnId);
        maxLocalTurn = Math.max(maxLocalTurn, local);
        if (msg.role === 'assistant' && local <= cancelledThrough && msg.text) {
          appendLive('assistant', local, '', true);
          return; // late text of a stopped turn
        }
        appendLive(msg.role, local, msg.text, msg.final);
        if (msg.role === 'assistant' && msg.text) markFirstText(`turn:${local}`);
        return;
      }
      case 'turn':
        return onTurn(msg);
      case 'snapshot.request':
        void onSnapshotRequest(msg);
        return;
      case 'tool':
        // Find messages drive busy/cues/prompts for the find tools.
        if (msg.name === 'find_object' || msg.name === 'select_target' || msg.name === 'stop_finding') return;
        if (GUIDE_TOOLS.has(msg.name)) {
          // Guide progress arrives as ServerGuide snapshots; only the view check shows a busy state.
          if (!GUIDE_INSPECT_TOOLS.has(msg.name)) return;
          if (msg.state === 'started') {
            setBusy('checking_view', null, true, GUIDE_INSPECT_TIMEOUT_MS);
            announce('Checking the view');
          } else if (busyInfo?.fromTool && busyInfo.kind === 'checking_view') {
            clearBusy();
          }
          return;
        }
        if (msg.state === 'started') {
          const kind: BusyKind = msg.name === 'read_label' ? 'reading_label' : 'looking';
          setBusy(kind, null, true);
          announce(kind === 'reading_label' ? 'Reading label' : 'Taking a fresh look');
        } else if (busyInfo?.fromTool) {
          clearBusy();
        }
        return;
      case 'evidence':
        setState({ lastEvidence: msg.evidence });
        pushEntry({ id: `evidence-${++entryCounter}`, role: 'system', text: summarizeEvidence(msg.evidence), final: true, source: 'evidence', at: now() });
        if (busyInfo && (busyInfo.fromTool || busyInfo.requestId === msg.requestId)) clearBusy();
        return;
      case 'answer': {
        const key = `answer:${msg.requestId}`;
        beginResponse(key);
        markFirstText(key);
        pushEntry({ id: `answer-${++entryCounter}`, role: 'assistant', text: msg.text, final: true, source: 'snapshot_answer', at: now() });
        if (busyInfo?.requestId === msg.requestId) clearBusy();
        if (state.settings.speakSnapshotAnswers && !paused && speech.supported) {
          // The answer replaces any guidance phrase in progress (speak() cancels the current utterance).
          if (guidanceSpeaking) {
            guidanceSpeaking = false;
            clearGuidanceSafety();
          }
          speech.speak(msg.text);
        }
        return;
      }
      case 'detections':
        return onDetections(msg);
      case 'find':
        return onFind(msg);
      case 'guide':
        return onGuide(msg);
      case 'error':
        return onServerError(msg);
      case 'notice':
        announce(msg.message);
        return;
    }
  }

  // ---------------------------------------------------------------------------
  // Visibility
  // ---------------------------------------------------------------------------

  function onVisibilityChange() {
    if (!active || !doc) return;
    if (doc.visibilityState === 'hidden') {
      if (paused) return;
      paused = true;
      if (audioStreaming) {
        audioStreaming = false;
        send({ type: 'audio.end' });
      }
      send({ type: 'visibility', state: 'hidden' });
      stopSampler();
      camera.pause();
      flushAllPlayback();
      endFindLocal(); // the server ends find mode when hidden
      if (calibrating) {
        stopCalibration();
        setState({ calibration: { ...state.calibration, step: 'idle', heardSeparation: null } });
      }
      if (busyInfo && busyInfo.kind !== 'connecting') clearBusy();
      setConnection('paused');
      updateGate();
    } else if (paused) {
      // Back in view: stay paused until the user taps Resume (audio needs a gesture anyway).
      setState({ announcement: { id: ++announceId, text: 'Sightline is paused. Tap Resume to continue.', politeness: 'polite' } });
    }
  }

  let visibilityAttached = false;
  const attachVisibility = () => {
    if (!doc || visibilityAttached) return;
    doc.addEventListener('visibilitychange', onVisibilityChange);
    visibilityAttached = true;
  };
  const detachVisibility = () => {
    if (!doc || !visibilityAttached) return;
    doc.removeEventListener('visibilitychange', onVisibilityChange);
    visibilityAttached = false;
  };

  // ---------------------------------------------------------------------------
  // Explicit actions
  // ---------------------------------------------------------------------------

  async function explicitCapture(action: 'read_label' | 'look_again') {
    if (!isUsable()) return;
    const ep = epoch;
    const pressAt = now();
    const kind: BusyKind = action === 'read_label' ? 'reading_label' : 'looking';
    setBusy(kind, null);
    announce(action === 'read_label' ? 'Reading label. Hold still.' : 'Taking a fresh look');
    let frame: CapturedFrame | null;
    try {
      frame =
        action === 'read_label'
          ? await captureLabelStill()
          : await camera.capture({ maxDim: LOOK_AGAIN_MAX_DIM, jpegQuality: LIMITS.snapshotJpegQuality });
    } catch {
      frame = null;
    }
    if (!isActiveEpoch(ep)) return;
    if (!frame) {
      clearBusy();
      setError({ code: 'camera', message: 'Camera unavailable. Check the camera and try again.', recoverable: true, action: 'retry' });
      return;
    }
    const requestId = `${action}-${++reqCounter}`;
    if (!send({ type: 'action', requestId, action, frame })) {
      clearBusy();
      setError({ code: 'network', message: 'Not connected. Try again in a moment.', recoverable: true, action: 'none' });
      return;
    }
    recordFrameSent(frame);
    pendingQuestion = { at: pressAt, frameAgeMs: Math.max(0, now() - frame.capturedAt) };
    setBusy(kind, requestId);
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /** Stop capture, transmission and playback and close the socket; after this nothing is sent. */
  function teardown() {
    epoch++;
    active = false;
    if (reconnectTimer) clearTimeout(reconnectTimer);
    reconnectTimer = null;
    if (detectionTimer) clearTimeout(detectionTimer);
    detectionTimer = null;
    if (busyTimer) clearTimeout(busyTimer);
    busyTimer = null;
    busyInfo = null;
    stopWorkingCue();
    stopSampler();
    endFindLocal();
    stopCalibration();
    micReleased = false;
    micRestoreOnResume = false;
    updateDetectSampler();
    camera.stop();
    mic.stop();
    flushAllPlayback();
    const sock = detachSocket();
    if (sock) {
      sock.send({ type: 'bye' });
      sock.close(1000, 'bye');
    }
    detachVisibility();
    paused = false;
  }

  const MEDIA_RETRYABLE = new Set(['idle', 'denied', 'unavailable', 'in_use', 'disconnected', 'error', 'stopped']);

  async function retryFailedMedia() {
    const ep = epoch;
    const camRetry = MEDIA_RETRYABLE.has(camera.getState().status);
    const micRetry = MEDIA_RETRYABLE.has(mic.getState().status);
    if (!camRetry && !micRetry) return;
    await Promise.allSettled([camRetry ? camera.start() : null, micRetry ? mic.start() : null]);
    if (!isActiveEpoch(ep)) return;
    if (micRetry) mic.setMuted(muted);
    const camOk = camera.getState().status === 'active';
    const m = mic.getState().status;
    const micOk = m === 'active' || m === 'muted';
    const code = state.error?.code;
    if ((code === 'camera' && camOk) || (code === 'microphone' && micOk && camOk)) setError(null);
    else if (code === 'microphone' && micOk && !camOk) {
      setError({ code: 'camera', message: `Camera unavailable. ${camera.getState().message ?? ''}`.trim(), recoverable: true, action: 'retry' });
    }
    updateGate();
  }

  const controller: AssistantController = {
    getState: () => state,
    subscribe(l) {
      listeners.add(l);
      return () => listeners.delete(l);
    },

    async start() {
      // Unlock audio FIRST, synchronously within the user gesture (before any await).
      const unlockP = player.unlock();
      void spatial?.unlock();
      if (active) {
        if (state.connection !== 'error') {
          // Session running: treat start() as "retry" for a camera/mic that failed.
          await retryFailedMedia();
          return;
        }
        // Errored session (e.g. reconnects exhausted, session limit): tear down and start fresh.
        controller.end();
      }
      const ep = ++epoch;
      active = true;
      ready = false;
      noReconnect = false;
      reconnectAttempts = 0;
      paused = false;
      audioUnlockSettled = false;
      audioStreaming = false;
      pendingQuestion = null;
      response = null;
      delete lastDetections.yolo;
      delete lastDetections.gemini;
      sessionStartCuePlayed = false;
      detectionArrivals.length = 0;
      firstDetectionAt = null;
      framesSent = 0;
      framesDroppedLocal = 0;
      reconnects = 0;
      setState({
        connection: 'connecting',
        error: null,
        detections: null,
        find: null,
        lastEvidence: null,
        talking: false,
        metrics: EMPTY_METRICS,
      });
      setBusy('connecting', null);
      announce('Starting.');
      attachVisibility();
      // Camera and mic in parallel; either may fail without blocking the other.
      const camP = camera.start();
      const micP = mic.start();
      mic.setMuted(muted);
      openSocket(false);
      const [, camR, micR] = await Promise.allSettled([unlockP, camP, micP]);
      if (!isActiveEpoch(ep)) return;
      audioUnlockSettled = true;

      const cam = camera.getState();
      const m = mic.getState();
      const camOk = camR.status === 'fulfilled' && cam.status === 'active';
      const micOk = micR.status === 'fulfilled' && (m.status === 'active' || m.status === 'muted');
      const insecure = cam.status === 'insecure_context' || m.status === 'insecure_context';
      const denied = cam.status === 'denied' || m.status === 'denied';
      if (insecure) {
        setError({ code: 'insecure_context', message: 'Camera and microphone need a secure (HTTPS) connection.', recoverable: false, action: 'none' });
      } else if (!camOk && !micOk) {
        setError({
          code: 'microphone',
          message: 'Camera and microphone are unavailable. You can still type questions if the camera starts later.',
          recoverable: true,
          action: denied ? 'open_settings' : 'retry',
        });
      } else if (!micOk) {
        setError({
          code: 'microphone',
          message: `${m.message ?? 'Microphone unavailable.'} You can still type questions.`,
          recoverable: true,
          action: m.status === 'denied' ? 'open_settings' : 'retry',
        });
      } else if (!camOk) {
        setError({
          code: 'camera',
          message: `Camera unavailable. ${cam.message ?? ''}`.trim(),
          recoverable: true,
          action: cam.status === 'denied' ? 'open_settings' : 'retry',
        });
      } else if (player.getState().contextState === 'suspended') {
        setError({ code: 'audio_output', message: 'Sound is paused by the browser. Tap to resume.', recoverable: true, action: 'tap_to_resume' });
      }
      updateGate();
    },

    end() {
      if (!active) {
        if (state.connection !== 'idle' && state.connection !== 'ended') setConnection('ended');
        return;
      }
      cue('session_end');
      // All cues stop first: beacon, guidance speech, calibration.
      stopFindCues();
      stopCalibration();
      if (state.calibration.step !== 'idle' && state.calibration.step !== 'done') setState({ calibration: IDLE_CALIBRATION });
      teardown();
      // The user ended the session: the server drops the guide too, so nothing is left to resume.
      resumeKey = null;
      pendingGuideSpeech = null;
      setState({ connection: 'ended', busy: null, talking: false, detections: null, speaking: false, guide: IDLE_GUIDE, guideLost: false });
      announce('Session ended.');
    },

    stopSpeaking() {
      const t = Math.max(currentTurn ?? 0, player.getState().turnId ?? 0);
      // Local first: instant silence even if the socket is gone.
      if (t > 0) cancelledThrough = Math.max(cancelledThrough, t);
      player.flush(t > 0 ? t : undefined);
      cancelGuidance();
      speech.cancel();
      if (t > 0 && t > turnOffset && ready) send({ type: 'playback.stop', turnId: t - turnOffset });
    },

    setMuted(m: boolean) {
      if (muted === m) return;
      muted = m;
      mic.setMuted(m);
      updateGate();
      announce(m ? 'Microphone muted.' : 'Microphone on.');
    },

    setTalking(down: boolean) {
      if (state.talking === down) return;
      setState({ talking: down });
      const ptt = state.settings.pushToTalk || micReleased;
      if (down && ptt) cue('listening');
      if (down && ptt && state.speaking) controller.stopSpeaking();
      if (micReleased && active) {
        // findMicPolicy 'release': the mic exists only while Talk is held. start() runs inside the tap gesture.
        if (down) {
          const ep = epoch;
          void mic
            .start()
            .catch(() => undefined)
            .then(() => {
              if (!isActiveEpoch(ep)) return;
              if (micReleased && !state.talking) mic.stop(); // released before the mic came up
              else {
                mic.setMuted(muted);
                updateGate();
              }
            });
        } else {
          mic.stop();
        }
      }
      updateSuppression();
      updateGate();
    },

    readLabel: () => explicitCapture('read_label'),

    async guideInspect(goal?: string) {
      void spatial?.unlock(); // from a tap: earcons need the cue AudioContext
      if (!isUsable()) {
        announce(GUIDE_NOT_CONNECTED_TEXT, 'assertive');
        return;
      }
      if (guideInspectReq !== null && busyInfo?.kind === 'checking_view') {
        announce('Still checking the view.');
        return;
      }
      const g = goal?.trim().slice(0, GUIDE_LIMITS.maxGoalChars);
      const ep = epoch;
      setBusy('checking_view', null, false, GUIDE_INSPECT_TIMEOUT_MS);
      announce('Checking the view. Hold still.');
      let frame: CapturedFrame | null;
      try {
        frame = await captureLabelStill(); // always a FRESH still, never an older ambient frame
      } catch {
        frame = null;
      }
      if (!isActiveEpoch(ep)) return;
      if (!frame) {
        clearBusy();
        setError({ code: 'camera', message: 'Camera unavailable. Check the camera and try again.', recoverable: true, action: 'retry' });
        return;
      }
      const requestId = `guide-inspect-${++reqCounter}`;
      if (!send({ type: 'guide.inspect', requestId, ...(g ? { goal: g } : {}), frame })) {
        clearBusy();
        announce(GUIDE_NOT_CONNECTED_TEXT, 'assertive');
        return;
      }
      recordFrameSent(frame);
      guideInspectReq = requestId;
      setBusy('checking_view', requestId, false, GUIDE_INSPECT_TIMEOUT_MS);
      if (state.guideLost) setState({ guideLost: false });
    },

    guideAction(action: GuideAction, opts: { sectionId?: string } = {}) {
      // Pause / Stop: silence assistant speech locally at once, before anything else.
      if (action === 'pause' || action === 'stop') {
        pendingGuideSpeech = null;
        controller.stopSpeaking();
      }
      if (!isUsable() || !socket?.isOpen) {
        // Never queue a mutation while offline: it could apply to a stale guide later.
        announce(GUIDE_NOT_CONNECTED_TEXT, 'assertive');
        return;
      }
      const g = state.guide;
      const stepId = STEP_BOUND_ACTIONS.has(action) ? currentStep(g)?.id : undefined;
      if (action === 'confirm' && !stepId) return; // nothing to confirm
      if (action === 'choose_section' && !opts.sectionId) return;
      const requestId = `guide-${action.replace(/_/g, '-')}-${++reqCounter}`;
      const ok = send({
        type: 'guide.action',
        requestId,
        action,
        guideId: g.guideId,
        revision: g.revision,
        ...(stepId ? { stepId } : {}),
        ...(action === 'choose_section' && opts.sectionId ? { sectionId: opts.sectionId } : {}),
      });
      if (!ok) {
        announce(GUIDE_NOT_CONNECTED_TEXT, 'assertive');
        return;
      }
      guideActionReqs.set(requestId, action);
      while (guideActionReqs.size > 20) guideActionReqs.delete(guideActionReqs.keys().next().value!);
      if (action === 'stop' && state.guideLost) setState({ guideLost: false });
    },
    lookAgain: () => explicitCapture('look_again'),

    find(query: string) {
      // Resume the cue AudioContext synchronously inside the gesture, before anything else.
      void spatial?.unlock();
      const q = query.trim().slice(0, LIMITS.maxFindQueryChars);
      if (!q || !isUsable()) return Promise.resolve();
      // Old find's cues stop first (target change). The server replaces its find silently.
      if (findOn || state.find) endFindLocal(undefined, true);
      if (camera.getState().facing === 'user') {
        // Positions are about the unmirrored REAR camera picture; the selfie camera would invert left/right.
        applyFindMicPolicy();
        showLocalFindError(q, REAR_CAMERA_PROMPT);
        return Promise.resolve();
      }
      const requestId = `find-${++reqCounter}`;
      if (!send({ type: 'find', requestId, query: q })) {
        applyFindMicPolicy();
        setError({ code: 'network', message: 'Not connected. Try again in a moment.', recoverable: true, action: 'none' });
        return Promise.resolve();
      }
      findOn = true;
      findReqId = requestId;
      findStateSeq++;
      lastPromptHeard = null;
      // Best guess until the server's first find message names the source.
      const source = state.server?.detector && cocoMatch(q)?.exact ? 'yolo' : 'gemini';
      setState({
        find: {
          query: q,
          state: 'searching',
          source,
          target: null,
          description: null,
          updatedAt: now(),
          trackId: null,
          observedAt: null,
          candidates: [],
          lastPrompt: null,
        },
      });
      setBusy('finding', requestId);
      spatial?.startTracking();
      announce(`Finding ${q}.`);
      applyFindMicPolicy();
      updateSuppression();
      updateDetectSampler();
      return Promise.resolve();
    },

    stopFind() {
      // Immediate local silence FIRST (beacon + guidance speech), then tell the server.
      stopFindCues();
      if (!findOn && findReqId === null) {
        if (state.find) setState({ find: null }); // inactive final / error status
        return;
      }
      send({ type: 'find.stop' });
      endFindLocal('Stopped finding.');
    },

    selectTarget(candidateId: number) {
      void spatial?.unlock(); // from a tap
      if (!findOn || !Number.isInteger(candidateId) || candidateId < 0) return;
      send({ type: 'find.select', candidateId });
    },

    startCalibration() {
      // Unlock audio synchronously inside the tap, before anything else.
      const unlockP = player.unlock();
      void spatial?.unlock();
      return runCalibration(unlockP);
    },

    answerCalibration(heardSeparation: boolean) {
      if (state.calibration.step === 'idle') return;
      stopCalibration();
      setCalibration({ step: 'done', heardSeparation });
      if (!heardSeparation) {
        // No left/right separation reached the ears (mono route or mono accessibility setting): use words instead.
        controller.updateSettings({ guidanceMode: 'spoken' });
        announce(CALIBRATION_FALLBACK_TEXT);
      }
    },

    cancelCalibration() {
      stopCalibration();
      setState({ calibration: { ...state.calibration, step: 'idle', heardSeparation: null } });
    },

    async setTorch(on: boolean) {
      const ep = epoch;
      const ok =
        typeof camera.setTorch === 'function' ? await Promise.resolve().then(() => camera.setTorch(on)).catch(() => false) : false;
      if (ep !== epoch) return;
      setState({ camera: camera.getState() });
      announce(ok ? (on ? 'Torch on.' : 'Torch off.') : 'The torch is not available on this camera.');
    },

    repeat() {
      if (!isUsable()) return;
      const requestId = `repeat-${++reqCounter}`;
      if (send({ type: 'action', requestId, action: 'repeat' })) {
        pendingQuestion = { at: now(), frameAgeMs: null };
        setBusy('answering', requestId);
      }
    },

    async sendText(text: string) {
      const t = text.trim().slice(0, LIMITS.maxTextChars);
      if (!t || !isUsable()) return;
      const ep = epoch;
      const pressAt = now();
      const live = state.connection === 'live';
      pushEntry({ id: `typed-${++entryCounter}`, role: 'user', text: t, final: true, source: 'typed', at: pressAt });
      setBusy('answering', null);
      let frame: CapturedFrame | null;
      try {
        frame = await camera.capture(
          live
            ? { maxDim: LIMITS.liveFrameMaxDim, jpegQuality: LIMITS.liveFrameJpegQuality }
            : { maxDim: LIMITS.snapshotMaxDim, jpegQuality: LIMITS.snapshotJpegQuality },
        );
      } catch {
        frame = null;
      }
      if (!isActiveEpoch(ep)) return;
      if (!live && !frame) {
        clearBusy();
        setError({ code: 'camera', message: 'A photo is needed in snapshot mode, but the camera is unavailable.', recoverable: true, action: 'retry' });
        return;
      }
      const requestId = `text-${++reqCounter}`;
      const msg: ClientMessage = frame ? { type: 'text', requestId, text: t, frame } : { type: 'text', requestId, text: t };
      if (!send(msg)) {
        clearBusy();
        setError({ code: 'network', message: 'Not connected. Try again in a moment.', recoverable: true, action: 'none' });
        return;
      }
      if (frame) recordFrameSent(frame);
      pendingQuestion = { at: pressAt, frameAgeMs: frame ? Math.max(0, now() - frame.capturedAt) : null };
      setBusy('answering', requestId);
    },

    async switchCamera() {
      const ep = epoch;
      try {
        await camera.switchCamera();
      } catch {
        if (ep === epoch) setError({ code: 'camera', message: 'Could not switch camera.', recoverable: true, action: 'none' });
      }
    },

    async resume() {
      // Unlock audio synchronously inside the tap.
      const unlockP = player.unlock();
      void spatial?.unlock();
      if (!active) return;
      const ep = epoch;
      if (paused && doc?.visibilityState !== 'hidden') {
        paused = false;
        const camP = camera.resume().catch(() => undefined);
        send({ type: 'visibility', state: 'visible' });
        const target: ConnectionStatus = !ready
          ? socket
            ? 'reconnecting'
            : 'connecting'
          : state.mode === 'live' && state.server?.liveModel
            ? 'live'
            : 'snapshot';
        setConnection(target);
        await camP;
        if (!isActiveEpoch(ep)) return;
        if (state.connection === 'live') startSampler();
        updateDetectSampler();
      }
      if (micRestoreOnResume && !micReleased && !paused) {
        // Find ended while hidden in mic-release mode: reopen the normal mic now (from this tap).
        micRestoreOnResume = false;
        restartMic();
      }
      await unlockP.catch(() => undefined);
      if (!isActiveEpoch(ep)) return;
      if (player.getState().contextState === 'running' && state.error?.action === 'tap_to_resume') setError(null);
    },

    setMode(mode: SessionMode) {
      if (mode === state.mode) return;
      setState({ mode });
      if (!active) return;
      const sock = detachSocket();
      if (sock) {
        sock.send({ type: 'bye' });
        sock.close(1000, 'mode_change');
      }
      flushAllPlayback();
      stopSampler();
      endFindLocal();
      clearBusy();
      noReconnect = false;
      reconnectAttempts = 0;
      setConnection('connecting');
      setBusy('connecting', null);
      openSocket(false);
    },

    updateSettings(patch: Partial<AssistantSettings>) {
      const prev = state.settings;
      const next = sanitizeSettings({ ...prev, ...patch });
      setState({ settings: next });
      if ('detections' in patch && patch.detections !== undefined) detectionsChosen = patch.detections;
      if ((prev.pushToTalk !== next.pushToTalk || prev.detections !== next.detections) && ready) {
        send({ type: 'settings', settings: clientSettings() });
      }
      if (!next.detections && !findOn) setState({ detections: null });
      if (
        prev.earcons !== next.earcons ||
        prev.spatialAudio !== next.spatialAudio ||
        prev.haptics !== next.haptics ||
        prev.cueVolume !== next.cueVolume ||
        prev.guidanceMode !== next.guidanceMode
      ) {
        applySpatialConfig();
      }
      if (prev.guidanceMode !== next.guidanceMode) {
        // Switching mode mid-find: drop pending words/prompts of the old mode.
        cancelGuidance();
        lastDirectionAt = Number.NEGATIVE_INFINITY;
      }
      if (prev.findMicPolicy !== next.findMicPolicy) applyFindMicPolicy();
      updateGate();
      updateDetectSampler();
    },

    clearTranscript() {
      setState({ transcript: [] });
    },

    dismissError() {
      setState({ error: null });
    },

    attachVideo(el: HTMLVideoElement | null) {
      camera.attachVideo(el);
    },
  };

  return controller;
}
