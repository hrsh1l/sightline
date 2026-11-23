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
 */
import {
  LIMITS,
  PROTOCOL_VERSION,
  type ClientMessage,
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
  CameraController,
  CapturedFrame,
  ConnectionStatus,
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
import { rmsOfPcm16Base64 } from '../audio/pcm.js';
import { cocoMatch, toCueTarget } from '../../shared/find.js';
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
  headphones: false,
};

/** Do not send detect frames when this much is queued on the socket (they are the most expendable traffic). */
export const MAX_BUFFERED_FOR_DETECT = 64 * 1024;
/** Gemini-located boxes arrive ~1x/s, so they stay on screen a little longer than YOLO boxes. */
export const GEMINI_DETECTION_TTL_MS = LIMITS.detectionTtlMs + LIMITS.locateMinIntervalMs;
const TERMINAL_FIND: ReadonlySet<FindState> = new Set<FindState>(['not_found', 'stopped', 'timeout']);

/** RMS (0..1) above which a 16 kHz mic chunk counts as speech for the questionEnd metric. */
export const SPEECH_RMS_THRESHOLD = 0.02;
/** Do not send ambient frames when this much data is already queued on the socket. */
export const MAX_BUFFERED_FOR_FRAMES = 256 * 1024;
export const LOOK_AGAIN_MAX_DIM = 1_024;

const EMPTY_METRICS: Metrics = {
  frameAgeAtQuestionMs: null,
  questionToFirstTextMs: null,
  questionToFirstAudioMs: null,
  framesSent: 0,
  framesDropped: 0,
  reconnects: 0,
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
    error: null,
    announcement: null,
    settings: { ...DEFAULT_SETTINGS, ...deps.initialSettings },
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
  let findReqId: string | null = null;
  let findLocal = false;
  let findCenteredOnce = false;
  const endedFindIds: string[] = [];
  // Working cue
  let workingTimer: ReturnType<typeof setTimeout> | null = null;
  // Metrics bookkeeping
  let lastSpeechAt: number | null = null;
  let lastResponseStartAt = Number.NEGATIVE_INFINITY;
  let pendingQuestion: { at: number; frameAgeMs: number | null } | null = null;
  let response: ResponseMetrics | null = null;
  const sentFrames: { sentAt: number; capturedAt: number }[] = [];

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
    spatial?.configure({ earcons: s.earcons, spatial: s.spatialAudio, haptics: s.haptics, headphones: s.headphones });
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

  function setBusy(kind: BusyKind, requestId: string | null, fromTool = false) {
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
      if (k !== 'connecting') announce('That is taking too long. Please try again.', 'assertive');
    }, busyTimeoutMs);
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

  mic.onChunk((b64) => {
    if (!active) return;
    if (rmsOfPcm16Base64(b64) > SPEECH_RMS_THRESHOLD) lastSpeechAt = now();
    if (!audioAllowed()) return; // dropped: never queued (e.g. while reconnecting)
    if (send({ type: 'audio', seq: audioSeq++, data: b64 })) audioStreaming = true;
  });

  // ---------------------------------------------------------------------------
  // Mirrors of the media stores
  // ---------------------------------------------------------------------------

  const refreshSpeaking = () => {
    const speaking = player.getState().playing || speech.speaking;
    setState({ speaking });
    // Cues stay audible under speech, at ~30%.
    spatial?.setDucked(speaking);
  };

  camera.subscribe(() => setState({ camera: camera.getState() }));
  mic.subscribe(() => setState({ mic: mic.getState() }));
  player.subscribe(() => {
    const p = player.getState();
    setState({ player: p });
    refreshSpeaking();
    updateGate();
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
    return (state.settings.detections && state.server?.detector === true) || state.find !== null;
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
    // Detection overlays default to on when the server has a detector, unless the user chose otherwise.
    if (msg.features.detections && detectionsChosen === null && !state.settings.detections) {
      setState({ settings: { ...state.settings, detections: true } });
      send({ type: 'settings', settings: clientSettings() });
    }
    if (paused) {
      send({ type: 'visibility', state: 'hidden' });
      setConnection('paused');
      return;
    }
    if (!sessionStartCuePlayed && target !== 'error') {
      sessionStartCuePlayed = true;
      cue('session_start');
    }
    setConnection(target);
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
        if (busyInfo && !busyInfo.fromTool && busyInfo.kind !== 'connecting' && busyInfo.kind !== 'finding') clearBusy();
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
        msg.purpose === 'read_label'
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
  async function captureLabelStill(): Promise<CapturedFrame | null> {
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

  function onDetections(msg: ServerDetections) {
    if (!state.settings.detections && !state.find) return;
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
  // Find mode (image-relative aiming help)
  // ---------------------------------------------------------------------------

  /** Forget the current find locally (no message to the server); late updates for it are ignored. */
  function endFindLocal(announceText?: string) {
    if (findReqId === null && state.find === null) return;
    if (findReqId) {
      endedFindIds.push(findReqId);
      while (endedFindIds.length > 20) endedFindIds.shift();
    }
    findReqId = null;
    findLocal = false;
    findCenteredOnce = false;
    spatial?.stopTracking();
    if (busyInfo?.kind === 'finding') clearBusy();
    setState({ find: null });
    updateDetectSampler();
    if (announceText) announce(announceText);
  }

  function onFind(msg: ServerMessageOf<'find'>) {
    if (msg.requestId && endedFindIds.includes(msg.requestId)) return; // stopped locally / replaced
    const q = msg.query;
    if (TERMINAL_FIND.has(msg.state)) {
      if (findReqId === null || msg.requestId !== findReqId) return;
      if (msg.state === 'not_found') cue('lost');
      endFindLocal(
        msg.state === 'not_found'
          ? `Could not find ${q} in the picture.`
          : msg.state === 'timeout'
            ? `Stopped finding ${q}: time limit reached.`
            : `Stopped finding ${q}.`,
      );
      return;
    }
    if (msg.requestId !== findReqId) {
      // A find started by the assistant (find_object tool), or the server's view of a new one.
      findReqId = msg.requestId;
      findLocal = false;
      findCenteredOnce = false;
    }
    const prev = state.find;
    const status: FindStatus = { query: q, state: msg.state, source: msg.source, target: msg.target, description: msg.description, updatedAt: now() };
    setState({ find: status });
    spatial?.startTracking();
    switch (msg.state) {
      case 'searching':
        if (busyInfo?.kind !== 'finding') setBusy('finding', msg.requestId);
        break;
      case 'tracking':
      case 'centered': {
        if (busyInfo?.kind === 'finding') clearBusy();
        if (msg.target) spatial?.setTarget(toCueTarget(msg.target.box, msg.state === 'centered'));
        if (msg.state === 'centered' && !findCenteredOnce) {
          findCenteredOnce = true;
          cue('found');
          // For assistant-started finds the assistant confirms by voice instead.
          if (findLocal) announce(`${q} centred.`);
        } else if (msg.state === 'tracking' && findLocal && prev && (prev.state === 'searching' || prev.state === 'lost') && msg.description) {
          announce(`${q}: ${msg.description}.`);
        }
        break;
      }
      case 'lost':
        spatial?.setTarget(null);
        if (findLocal) announce(`Lost ${q}. Move the camera slowly.`);
        break;
      default:
        break;
    }
    updateDetectSampler();
  }

  function onServerError(msg: ServerMessageOf<'error'>) {
    if (msg.requestId && msg.requestId === findReqId) endFindLocal();
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
        if (msg.name === 'find_object') return; // find messages drive busy/cues/announcements
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
        if (state.settings.speakSnapshotAnswers && !paused && speech.supported) speech.speak(msg.text);
        return;
      }
      case 'detections':
        return onDetections(msg);
      case 'find':
        return onFind(msg);
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
      spatial?.stopTracking();
      teardown();
      setState({ connection: 'ended', busy: null, talking: false, detections: null, speaking: false });
      announce('Session ended.');
    },

    stopSpeaking() {
      const t = Math.max(currentTurn ?? 0, player.getState().turnId ?? 0);
      // Local first: instant silence even if the socket is gone.
      if (t > 0) cancelledThrough = Math.max(cancelledThrough, t);
      player.flush(t > 0 ? t : undefined);
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
      if (down && state.settings.pushToTalk) cue('listening');
      if (down && state.settings.pushToTalk && state.speaking) controller.stopSpeaking();
      updateGate();
    },

    readLabel: () => explicitCapture('read_label'),
    lookAgain: () => explicitCapture('look_again'),

    find(query: string) {
      // Resume the cue AudioContext synchronously inside the gesture, before anything else.
      void spatial?.unlock();
      const q = query.trim().slice(0, LIMITS.maxFindQueryChars);
      if (!q || !isUsable()) return Promise.resolve();
      if (findReqId !== null || state.find) endFindLocal(); // the server replaces it silently
      const requestId = `find-${++reqCounter}`;
      if (!send({ type: 'find', requestId, query: q })) {
        setError({ code: 'network', message: 'Not connected. Try again in a moment.', recoverable: true, action: 'none' });
        return Promise.resolve();
      }
      findReqId = requestId;
      findLocal = true;
      findCenteredOnce = false;
      // Best guess until the server's first find message names the source.
      const source = state.server?.detector && cocoMatch(q)?.exact ? 'yolo' : 'gemini';
      setState({ find: { query: q, state: 'searching', source, target: null, description: null, updatedAt: now() } });
      setBusy('finding', requestId);
      spatial?.startTracking();
      announce(`Finding ${q}. Move the camera slowly; beeps will guide you.`);
      updateDetectSampler();
      return Promise.resolve();
    },

    stopFind() {
      if (findReqId === null && !state.find) return;
      send({ type: 'find.stop' });
      endFindLocal('Stopped finding.');
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
      const next = { ...prev, ...patch };
      setState({ settings: next });
      if ('detections' in patch && patch.detections !== undefined) detectionsChosen = patch.detections;
      if ((prev.pushToTalk !== next.pushToTalk || prev.detections !== next.detections) && ready) {
        send({ type: 'settings', settings: clientSettings() });
      }
      if (!next.detections && !state.find) setState({ detections: null });
      if (prev.earcons !== next.earcons || prev.spatialAudio !== next.spatialAudio || prev.haptics !== next.haptics || prev.headphones !== next.headphones) {
        applySpatialConfig();
      }
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
