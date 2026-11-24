/**
 * FIXTURE for UI tests only — no AI, never used in the app.
 *
 * A scriptable in-memory Store implementing AssistantController. Every method is a vi.fn spy that
 * does nothing except record the call (no camera, no audio, no network). Tests drive the UI by
 * calling `setState(patch)`.
 */
import { vi } from 'vitest';
import type { AssistantController, AssistantState, FindStatus, Listener } from '../../contracts.js';
import type { FindCandidate, LabelEvidence, ServerDetections } from '../../../shared/protocol.js';
import { IDLE_GUIDE, type GuideAction, type GuideSnapshot, type GuideStepState } from '../../../shared/guide.js';

export function makeState(overrides: Partial<AssistantState> = {}): AssistantState {
  return {
    connection: 'idle',
    mode: 'live',
    camera: {
      status: 'idle',
      facing: 'unknown',
      deviceLabel: '',
      videoWidth: 0,
      videoHeight: 0,
      canSwitch: false,
      torch: { supported: false, on: false },
      stillCapture: false,
      message: null,
    },
    mic: { status: 'idle', level: 0, echoCancellation: null, message: null },
    player: { playing: false, turnId: null, contextState: 'uninitialized' },
    speaking: false,
    talking: false,
    busy: null,
    transcript: [],
    lastEvidence: null,
    detections: null,
    find: null,
    calibration: { step: 'idle', heardSeparation: null, micActive: false },
    guide: IDLE_GUIDE,
    guideLost: false,
    error: null,
    announcement: null,
    settings: {
      pushToTalk: false,
      detections: false,
      showPreview: true,
      micDuringReplies: 'barge_in',
      speakSnapshotAnswers: true,
      showDiagnostics: false,
      earcons: true,
      spatialAudio: true,
      haptics: true,
      cueVolume: 0.7,
      guidanceMode: 'stereo',
      findMicPolicy: 'keep',
    },
    server: { configured: true, liveModel: 'fixture-live', visionModel: 'fixture-vision', detector: false, sessionId: null, timeZone: 'Europe/London' },
    metrics: {
      frameAgeAtQuestionMs: null,
      questionToFirstTextMs: null,
      questionToFirstAudioMs: null,
      framesSent: 0,
      framesDropped: 0,
      reconnects: 0,
      detectionAgeMs: null,
      detectionRate: null,
    },
    ...overrides,
  };
}

/** A live, fully working session state (camera + mic active). */
export function liveState(overrides: Partial<AssistantState> = {}): AssistantState {
  const base = makeState();
  return makeState({
    connection: 'live',
    camera: {
      ...base.camera,
      status: 'active',
      facing: 'environment',
      videoWidth: 1280,
      videoHeight: 720,
      canSwitch: true,
      torch: { supported: true, on: false },
      stillCapture: true,
    },
    mic: { ...base.mic, status: 'active', echoCancellation: true },
    player: { ...base.player, contextState: 'running' },
    server: { ...(base.server ?? { configured: true, liveModel: null, visionModel: null, detector: false, timeZone: 'Europe/London' }), sessionId: 'fixture-session' },
    ...overrides,
  });
}

export function makeEvidence(overrides: Partial<LabelEvidence> = {}): LabelEvidence {
  return {
    frameId: 7,
    capturedAt: Date.UTC(2026, 10, 23, 12, 30),
    readability: 'partial',
    exactText: [
      { section: 'product_name', text: 'Tomato Soup' },
      { section: 'cooking_instructions', text: 'Microwave 800W: 2 mins, stir, 1 min' },
    ],
    instructions: [{ method: 'Microwave', steps: ['Pierce film', 'Heat on full power for 2 minutes'] }],
    dates: [
      {
        printedText: 'BEST BEFORE END 03 2027',
        labelType: 'best_before_end',
        interpretation: { status: 'parsed', isoDate: '2027-03-31', comparison: 'future', note: 'Month and year only' },
      },
    ],
    batchCodes: ['L2417A'],
    itemGuess: 'A carton of soup',
    issues: ['glare'],
    suggestion: 'Tilt the pack away from the light.',
    model: 'fixture-vision',
    latencyMs: 900,
    ...overrides,
  };
}

export function makeDetections(overrides: Partial<ServerDetections> = {}): ServerDetections {
  return {
    type: 'detections',
    frameId: 3,
    capturedAt: Date.UTC(2026, 10, 23, 12, 0),
    sourceWidth: 768,
    sourceHeight: 432,
    detectedAt: Date.UTC(2026, 10, 23, 12, 0),
    model: 'fixture-detector',
    detections: [
      { label: 'cup', score: 0.61, box: { x: 0.6, y: 0.2, w: 0.2, h: 0.3 } },
      { label: 'bottle', score: 0.82, box: { x: 0.1, y: 0.1, w: 0.2, h: 0.6 } },
    ],
    ...overrides,
  };
}

export function makeFind(overrides: Partial<FindStatus> = {}): FindStatus {
  return {
    query: 'bottle',
    state: 'tracking',
    source: 'yolo',
    target: { label: 'bottle', score: 0.9, box: { x: 0.05, y: 0.05, w: 0.2, h: 0.2 } },
    description: 'left of the picture',
    updatedAt: Date.UTC(2026, 10, 23, 12, 0),
    trackId: 4,
    observedAt: Date.UTC(2026, 10, 23, 12, 0),
    candidates: [],
    lastPrompt: null,
    ...overrides,
  };
}

/** Two or three cups to choose between (needs_selection). */
export function makeCandidates(positions: Array<FindCandidate['position']> = ['left', 'middle', 'right']): FindCandidate[] {
  const x: Record<FindCandidate['position'], number> = { left: 0.05, middle: 0.4, right: 0.75 };
  return positions.map((position, i) => ({
    id: 10 + i,
    label: 'cup',
    score: 0.9 - i * 0.1,
    box: { x: x[position], y: 0.3, w: 0.2, h: 0.3 },
    position,
  }));
}

/** FIXTURE: one guide step (verbatim text invented for tests; no AI). */
export function makeStep(n: number, overrides: Partial<GuideStepState> = {}): GuideStepState {
  return {
    id: `microwave-s${n}`,
    n,
    index: n - 1,
    sourceText: `FIXTURE source text for step ${n}.`,
    spoken: `Fixture spoken step ${n}.`,
    quantities: [],
    warnings: [],
    presented: false,
    confirmed: false,
    ...overrides,
  };
}

/**
 * FIXTURE guide snapshot (invented text, no AI): a 4-step "Microwave" method guiding at step 2, with step 1
 * presented + confirmed and step 2 presented (not confirmed). Override anything.
 */
export function makeGuide(overrides: Partial<GuideSnapshot> = {}): GuideSnapshot {
  const steps = [
    makeStep(1, { sourceText: 'Pierce film lid several times.', spoken: 'Pierce the film lid several times.', presented: true, confirmed: true }),
    makeStep(2, {
      sourceText: 'Heat on full power (800W) for 3 minutes.',
      spoken: 'Heat on full power, 800W, for 3 minutes.',
      quantities: [
        { text: '800W', kind: 'power' },
        { text: '3 minutes', kind: 'duration' },
      ],
      warnings: ['Caution: contents will be hot.'],
      presented: true,
    }),
    makeStep(3, { sourceText: 'Stir and re-cover.', spoken: 'Stir, then re-cover.' }),
    makeStep(4, { sourceText: 'Stand for 1 minute before serving.', spoken: 'Let it stand for 1 minute before serving.' }),
  ];
  return {
    ...IDLE_GUIDE,
    phase: 'guiding',
    goal: 'cooking instructions',
    guideId: 'g-fixture',
    revision: 1,
    title: 'Tomato Soup',
    section: { id: 'microwave', title: 'MICROWAVE (800W)', kind: 'method' },
    steps,
    currentIndex: 1,
    sourceFrames: [{ frameId: 7, capturedAt: Date.UTC(2026, 10, 24, 12, 30, 5) }],
    version: 5,
    confirmations: ['microwave-s1'],
    ...overrides,
  };
}

export class FakeController implements AssistantController {
  private state: AssistantState;
  private listeners = new Set<Listener>();

  constructor(initial: AssistantState = makeState()) {
    this.state = initial;
  }

  /** Replace part of the state and notify subscribers (new reference, as a real store must). */
  setState(patch: Partial<AssistantState>): void {
    this.state = { ...this.state, ...patch };
    for (const l of [...this.listeners]) l();
  }

  getState = (): AssistantState => this.state;

  subscribe = (listener: Listener) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  start = vi.fn(async (): Promise<void> => {});
  end = vi.fn((): void => {});
  stopSpeaking = vi.fn((): void => {});
  setMuted = vi.fn((_muted: boolean): void => {});
  setTalking = vi.fn((_down: boolean): void => {});
  readLabel = vi.fn(async (): Promise<void> => {});
  find = vi.fn(async (_query: string): Promise<void> => {});
  stopFind = vi.fn((): void => {});
  selectTarget = vi.fn((_candidateId: number): void => {});
  startCalibration = vi.fn(async (): Promise<void> => {});
  answerCalibration = vi.fn((_heardSeparation: boolean): void => {});
  cancelCalibration = vi.fn((): void => {});
  setTorch = vi.fn(async (_on: boolean): Promise<void> => {});
  guideInspect = vi.fn(async (_goal?: string): Promise<void> => {});
  guideAction = vi.fn((_action: GuideAction, _opts?: { sectionId?: string }): void => {});
  lookAgain = vi.fn(async (): Promise<void> => {});
  repeat = vi.fn((): void => {});
  sendText = vi.fn(async (_text: string): Promise<void> => {});
  switchCamera = vi.fn(async (): Promise<void> => {});
  resume = vi.fn(async (): Promise<void> => {});
  setMode = vi.fn((_mode: AssistantState['mode']): void => {});
  updateSettings = vi.fn((_patch: Partial<AssistantState['settings']>): void => {});
  clearTranscript = vi.fn((): void => {});
  dismissError = vi.fn((): void => {});
  attachVideo = vi.fn((_el: HTMLVideoElement | null): void => {});
}
