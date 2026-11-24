/**
 * Instruction companion through ClientSession. FIXTURE ONLY: fake Gemini Live connector, fake channel, fake vision
 * (extractGuide returns fixture extractions). Nothing here talks to a real provider.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LiveConnectParameters, LiveServerMessage } from '@google/genai';
import { loadConfig } from '../config.js';
import { createMemoryLogger } from '../log.js';
import type { ClientChannel, DetectorService, LiveConnector, LiveSessionLike, SessionDeps, VisionService } from '../contracts.js';
import { ServerMessage as ServerMessageSchema, type ClientMessage, type FramePayload, type ServerMessage } from '../../shared/protocol.js';
import { GUIDE_LIMITS, type GuideExtraction, type GuideSection } from '../../shared/guide.js';
import { GuideStore } from '../guide/GuideStore.js';
import { createClientSessionWithOptions } from './ClientSession.js';
import { NO_VISION_GUIDE_MESSAGE } from './guideController.js';
import { NOT_CONFIRMED_GUIDANCE, SAY_GUIDANCE } from '../live/guideTools.js';

type LiveMsg = Omit<LiveServerMessage, 'text' | 'data'>;

interface FakeConn {
  params: LiveConnectParameters;
  clientContent: Parameters<LiveSessionLike['sendClientContent']>[0][];
  toolResponses: Parameters<LiveSessionLike['sendToolResponse']>[0][];
  emit(msg: LiveMsg): void;
}

function createFakeConnector() {
  const connections: FakeConn[] = [];
  const connector: LiveConnector = vi.fn(async (params: LiveConnectParameters) => {
    const conn: FakeConn = { params, clientContent: [], toolResponses: [], emit: (msg) => params.callbacks.onmessage(msg as LiveServerMessage) };
    connections.push(conn);
    return {
      sendRealtimeInput: () => undefined,
      sendClientContent: (p) => void conn.clientContent.push(p),
      sendToolResponse: (p) => void conn.toolResponses.push(p),
      close: () => undefined,
    } satisfies LiveSessionLike;
  });
  return {
    connector,
    get last() {
      return connections[connections.length - 1]!;
    },
  };
}

const steps = (secId: string, texts: string[]) =>
  texts.map((t, i) => ({ id: `${secId}-s${i + 1}`, n: i + 1, sourceText: t, spoken: t, quantities: [], warnings: [] as string[] }));
const MICRO: GuideSection = {
  id: 'microwave',
  title: 'MICROWAVE (800W)',
  kind: 'method',
  steps: steps('microwave', ['Pierce film lid several times.', 'Heat on full power for 4 minutes.', 'Stir, then heat for a further 1 minute.']),
  complete: true,
  missing: [],
};
const OVEN: GuideSection = { ...MICRO, id: 'oven', title: 'OVEN', steps: steps('oven', ['Preheat oven to 190°C.', 'Cook for 25 minutes.']) };

function extraction(frame: Pick<FramePayload, 'frameId' | 'capturedAt'>, sections: GuideSection[] = [MICRO], over: Partial<GuideExtraction> = {}): GuideExtraction {
  return {
    frameIds: [frame.frameId],
    capturedAt: [frame.capturedAt],
    readability: 'clear',
    issue: 'none',
    issueEvidence: null,
    adjustment: null,
    title: 'FIXTURE meal',
    sections,
    warnings: [],
    model: 'fake-vision',
    latencyMs: 5,
    ...over,
  };
}

const UNREADABLE = { readability: 'unreadable', issue: 'cut_off_bottom', issueEvidence: 'steps continue below the bottom edge', adjustment: 'Move the phone down a little.' } as const;

function createFakeVision() {
  return {
    model: 'fake-vision',
    extractLabel: vi.fn(async (_i: Parameters<VisionService['extractLabel']>[0]): ReturnType<VisionService['extractLabel']> => {
      throw new Error('FIXTURE: not used');
    }),
    answer: vi.fn(async (_i: Parameters<VisionService['answer']>[0]) => ({ text: 'FIXTURE', latencyMs: 1 })),
    locate: vi.fn(async (_i: Parameters<VisionService['locate']>[0]) => ({ boxes: [], model: 'fake', latencyMs: 1 })),
    extractGuide: vi.fn(async ({ frame }: Parameters<VisionService['extractGuide']>[0]) => extraction(frame)),
  } satisfies VisionService;
}

const detectorOff: DetectorService = { enabled: false, model: 'none', detect: async () => null, health: async () => 'disabled' };

function makeFrame(frameId: number, capturedAt = Date.now()): FramePayload {
  return { frameId, capturedAt, width: 640, height: 480, mimeType: 'image/jpeg', data: 'AAAA' };
}

function harness(over: { live?: boolean; vision?: boolean; store?: GuideStore; detector?: DetectorService } = {}) {
  const fake = createFakeConnector();
  const vision = createFakeVision();
  const sent: ServerMessage[] = [];
  const channel: ClientChannel & { sent: ServerMessage[] } = {
    sent,
    isOpen: true,
    bufferedAmount: 0,
    send: (m) => {
      // Every server message must satisfy the shared protocol schema.
      expect(ServerMessageSchema.safeParse(m).success, JSON.stringify(m).slice(0, 300)).toBe(true);
      sent.push(m);
    },
    close: vi.fn(),
  };
  const store = over.store ?? new GuideStore();
  const deps: SessionDeps = {
    channel,
    config: loadConfig({ GEMINI_API_KEY: 'FIXTURE-not-a-key' }),
    vision: over.vision === false ? null : vision,
    detector: over.detector ?? detectorOff,
    liveConnector: over.live === false ? null : fake.connector,
    clock: () => new Date(Date.now()),
    log: createMemoryLogger(),
  };
  const session = createClientSessionWithOptions(deps, { guideStore: store });
  const send = (msg: ClientMessage) => session.handleRaw(JSON.stringify(msg));
  const of = <T extends ServerMessage['type']>(type: T) => sent.filter((m): m is Extract<ServerMessage, { type: T }> => m.type === type);
  const lastGuide = () => of('guide').at(-1)!;
  return { fake, vision, session, send, of, sent, store, lastGuide };
}

function hello(over: Partial<Extract<ClientMessage, { type: 'hello' }>> = {}): ClientMessage {
  return { type: 'hello', protocolVersion: 1, mode: 'live', settings: { pushToTalk: false, detections: false }, clientTime: Date.now(), ...over };
}

const flush = async () => {
  await vi.advanceTimersByTimeAsync(0);
  await vi.advanceTimersByTimeAsync(0);
};

async function connected(over: Parameters<typeof harness>[0] = {}, helloOver: Parameters<typeof hello>[0] = {}) {
  const h = harness(over);
  h.send(hello(helloOver));
  await flush();
  return h;
}

type Output = Record<string, unknown> & { say?: string | null; guidance?: string; status?: string; code?: string | null; step?: { id: string; n: number } | null };
function toolOutputs(h: ReturnType<typeof harness>) {
  return h.fake.last.toolResponses.map((r) => {
    const fr = (Array.isArray(r.functionResponses) ? r.functionResponses : [r.functionResponses])[0] as {
      id: string;
      response: { output?: Output; error?: { code: string; message: string } };
    };
    return { id: fr.id, ...fr.response };
  });
}
const call = (h: ReturnType<typeof harness>, id: string, name: string, args: Record<string, unknown> = {}) =>
  h.fake.last.emit({ toolCall: { functionCalls: [{ id, name, args }] } });
const userSays = (h: ReturnType<typeof harness>, text: string) => h.fake.last.emit({ serverContent: { inputTranscription: { text } } });
const turnComplete = (h: ReturnType<typeof harness>) => h.fake.last.emit({ serverContent: { turnComplete: true } });

/** start_guide via the tool and answer the snapshot.request with `frameId`. */
async function startGuide(h: ReturnType<typeof harness>, frameId = 10, id = 'c-start', args: Record<string, unknown> = { goal: 'cooking instructions' }) {
  call(h, id, 'start_guide', args);
  const req = h.of('snapshot.request').at(-1)!;
  h.send({ type: 'snapshot.result', requestId: req.requestId, frame: makeFrame(frameId) });
  await flush();
  return toolOutputs(h).at(-1)!;
}

const bindArgs = (h: ReturnType<typeof harness>) => {
  const g = h.lastGuide().guide;
  return { guide_id: g.guideId, revision: g.revision, step_id: g.steps[g.currentIndex ?? 0]?.id };
};
const uiBind = (h: ReturnType<typeof harness>) => {
  const g = h.lastGuide().guide;
  return { guideId: g.guideId, revision: g.revision, stepId: g.steps[g.currentIndex ?? 0]?.id };
};
const injected = (h: ReturnType<typeof harness>) =>
  h.fake.last.clientContent.map((c) => {
    const turns = c.turns as { parts: { text: string }[] }[];
    return turns[0]!.parts[0]!.text;
  });

beforeEach(() => {
  vi.useFakeTimers({ now: new Date('2026-11-24T10:00:00Z') });
});
afterEach(() => {
  vi.useRealTimers();
});

describe('tools: start_guide flow', () => {
  it('start_guide -> snapshot.request purpose guide -> extractGuide on that fresh frame -> say step 1 exactly', async () => {
    const h = await connected();
    expect(h.of('ready')[0]!.resumeKey).toHaveLength(32);
    expect(h.of('ready')[0]!.guideRestored).toBeUndefined();
    call(h, 'c1', 'start_guide', { goal: 'cooking instructions' });
    const req = h.of('snapshot.request').at(-1)!;
    expect(req).toMatchObject({ purpose: 'guide', maxDim: 4096 });
    expect(h.lastGuide().guide.phase).toBe('acquiring_image');
    h.send({ type: 'snapshot.result', requestId: req.requestId, frame: makeFrame(10) });
    await flush();
    expect(h.vision.extractGuide).toHaveBeenCalledTimes(1);
    expect(h.vision.extractGuide.mock.calls[0]![0]).toMatchObject({ goal: 'cooking instructions', frame: { frameId: 10 } });
    const out = toolOutputs(h).at(-1)!;
    expect(out.id).toBe('c1');
    expect(out.output).toMatchObject({
      status: 'ok',
      phase: 'guiding',
      step: { id: 'microwave-s1', n: 1, total: 3, spoken: 'Pierce film lid several times.', sourceText: 'Pierce film lid several times.' },
      confirmedSteps: [],
      presentedNotConfirmed: [1],
      say: 'Microwave (800W) instructions, 3 steps. Step 1 of 3: Pierce film lid several times.',
      guidance: SAY_GUIDANCE,
      frameId: 10,
    });
    expect(h.lastGuide()).toMatchObject({ requestId: null, result: null, guide: { phase: 'guiding', currentIndex: 0 } });
    expect(h.of('tool').at(-1)).toMatchObject({ callId: 'c1', name: 'start_guide', state: 'completed' });
  });

  it('"How about now?" -> inspect_current_view takes a NEW frame; the previous image is never reused', async () => {
    const h = await connected();
    h.vision.extractGuide.mockImplementationOnce(async ({ frame }) => extraction(frame, [], UNREADABLE));
    const first = await startGuide(h, 10);
    expect(first.output).toMatchObject({ phase: 'needs_better_view', say: "I can't read the instructions yet. Steps continue below the bottom edge. Move the phone down a little." });

    call(h, 'c2', 'inspect_current_view');
    const req = h.of('snapshot.request').at(-1)!;
    expect(req.purpose).toBe('guide');
    h.send({ type: 'snapshot.result', requestId: req.requestId, frame: makeFrame(10) }); // same old frame
    await flush();
    expect(toolOutputs(h).at(-1)).toMatchObject({ id: 'c2', error: { code: 'frame_not_new' } });
    expect(h.vision.extractGuide).toHaveBeenCalledTimes(1);

    call(h, 'c3', 'inspect_current_view', {});
    const req2 = h.of('snapshot.request').at(-1)!;
    expect(req2.requestId).not.toBe(req.requestId);
    h.send({ type: 'snapshot.result', requestId: req2.requestId, frame: makeFrame(11) });
    await flush();
    expect(h.vision.extractGuide).toHaveBeenCalledTimes(2);
    expect(h.vision.extractGuide.mock.calls[1]![0]).toMatchObject({ goal: 'cooking instructions', frame: { frameId: 11 } });
    expect(toolOutputs(h).at(-1)!.output).toMatchObject({ phase: 'guiding', step: { n: 1 } });
  });

  it('several methods -> the model asks; choose_section picks one (never merged)', async () => {
    const h = await connected();
    h.vision.extractGuide.mockImplementationOnce(async ({ frame }) => extraction(frame, [MICRO, OVEN]));
    const out = await startGuide(h);
    expect(out.output).toMatchObject({ phase: 'choosing_section', say: 'I can see microwave (800W) and oven instructions. Which would you like?', choices: [{ id: 'microwave' }, { id: 'oven' }] });
    call(h, 'c-choose', 'choose_section', { section: 'oven' });
    await flush();
    expect(toolOutputs(h).at(-1)!.output).toMatchObject({ phase: 'guiding', section: 'OVEN', step: { id: 'oven-s1', total: 2 } });
  });

  it('start_guide while a guide is active asks to confirm replacing it; replace true starts fresh', async () => {
    const h = await connected();
    await startGuide(h, 10);
    call(h, 'c-new', 'start_guide', { goal: 'storage instructions' });
    await flush();
    const out = toolOutputs(h).at(-1)!;
    expect(out.output).toMatchObject({ status: 'confirm_replace', phase: 'guiding', goal: 'cooking instructions' });
    expect(h.of('snapshot.request')).toHaveLength(1);
    const replaced = await startGuide(h, 11, 'c-replace', { goal: 'storage instructions', replace: true });
    expect(replaced.output).toMatchObject({ goal: 'storage instructions', phase: 'guiding' });
    expect(h.vision.extractGuide.mock.calls[1]![0]).toMatchObject({ goal: 'storage instructions' });
  });

  it('starting a guide stops an active find (the client is told)', async () => {
    const detector: DetectorService = { enabled: true, model: 'fake', detect: async () => null, health: async () => 'ok' };
    const h = await connected({ detector });
    h.send({ type: 'find', requestId: 'f1', query: 'cup' });
    expect(h.of('find').at(-1)!.state).toBe('searching');
    const out = await startGuide(h);
    expect(h.of('find').at(-1)!.state).toBe('stopped');
    expect(out.output).toMatchObject({ findStopped: true });
  });

  it('toolCallCancellation aborts the extraction, sends no response and restores the phase', async () => {
    const h = await connected();
    let signal: AbortSignal | undefined;
    h.vision.extractGuide.mockImplementationOnce(
      (input) =>
        new Promise((_, reject) => {
          signal = input.signal;
          input.signal?.addEventListener('abort', () => reject(new Error('aborted')));
        }),
    );
    call(h, 'c1', 'start_guide', { goal: 'cooking instructions' });
    h.send({ type: 'snapshot.result', requestId: h.of('snapshot.request').at(-1)!.requestId, frame: makeFrame(10) });
    await flush();
    h.fake.last.emit({ toolCallCancellation: { ids: ['c1'] } });
    await flush();
    expect(signal?.aborted).toBe(true);
    expect(h.fake.last.toolResponses).toHaveLength(0);
    expect(h.lastGuide().guide.phase).toBe('idle');
  });

  it('no vision -> honest error, never an extraction', async () => {
    const h = await connected({ vision: false });
    call(h, 'c1', 'start_guide', { goal: 'cooking instructions' });
    await flush();
    expect(toolOutputs(h).at(-1)).toMatchObject({ error: { code: 'vision_unavailable' } });
    expect(h.lastGuide().guide).toMatchObject({ phase: 'error', message: NO_VISION_GUIDE_MESSAGE });
    expect(h.of('snapshot.request')).toHaveLength(0);
    h.send({ type: 'guide.inspect', requestId: 'i1', frame: makeFrame(5) });
    await flush();
    expect(h.lastGuide()).toMatchObject({ requestId: 'i1', result: { ok: false, code: 'vision_unavailable' } });
    expect(h.vision.extractGuide).not.toHaveBeenCalled();
  });
});

describe('tools: navigation and confirmation', () => {
  it('navigate_step next presents step 2 without confirming step 1', async () => {
    const h = await connected();
    await startGuide(h);
    call(h, 'n1', 'navigate_step', { direction: 'next', ...bindArgs(h) });
    await flush();
    expect(toolOutputs(h).at(-1)!.output).toMatchObject({ say: 'Step 2 of 3: Heat on full power for 4 minutes.', confirmedSteps: [], presentedNotConfirmed: [1, 2] });
  });

  it('explain keeps the place and returns the source text with explanation guidance', async () => {
    const h = await connected();
    await startGuide(h);
    const v = h.lastGuide().guide.version;
    call(h, 'e1', 'navigate_step', { direction: 'explain', ...bindArgs(h) });
    await flush();
    const out = toolOutputs(h).at(-1)!.output!;
    expect(out).toMatchObject({ say: null, step: { n: 1, sourceText: 'Pierce film lid several times.' } });
    expect(String(out.guidance)).toContain('general information');
    expect(h.lastGuide().guide.version).toBe(v);
  });

  it('confirm_step is rejected when the user did not say they finished (negated transcript or question)', async () => {
    const h = await connected();
    await startGuide(h);
    turnComplete(h);
    userSays(h, "I'm not done yet");
    call(h, 'k1', 'confirm_step', { ...bindArgs(h), user_said: 'done' });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(toolOutputs(h).at(-1)!.output).toMatchObject({ status: 'rejected', code: 'not_confirmed', guidance: NOT_CONFIRMED_GUIDANCE, confirmedSteps: [] });
    turnComplete(h);
    userSays(h, 'Do I say done?');
    call(h, 'k2', 'confirm_step', { ...bindArgs(h), user_said: 'Do I say done?' });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(toolOutputs(h).at(-1)!.output).toMatchObject({ code: 'not_confirmed' });
    expect(h.lastGuide().guide.confirmations).toEqual([]);
  });

  it('confirm_step with "Done." records step 1 and offers step 2; a retried call advances only once', async () => {
    const h = await connected();
    await startGuide(h);
    turnComplete(h);
    userSays(h, 'Done.');
    const b = bindArgs(h);
    call(h, 'k1', 'confirm_step', { ...b, user_said: 'Done.' });
    await flush();
    expect(toolOutputs(h).at(-1)!.output).toMatchObject({ status: 'ok', confirmedSteps: [1], step: { n: 2 }, say: 'Step 1 marked done. Step 2 of 3: Heat on full power for 4 minutes.' });
    call(h, 'k1', 'confirm_step', { ...b, user_said: 'Done.' }); // same call id retried
    await flush();
    expect(toolOutputs(h).at(-1)!.output).toMatchObject({ status: 'duplicate', confirmedSteps: [1], step: { n: 2 } });
    call(h, 'k2', 'confirm_step', { ...b, user_said: 'Done.' }); // new id, stale step id
    await vi.advanceTimersByTimeAsync(1_000);
    expect(toolOutputs(h).at(-1)!.output).toMatchObject({ confirmedSteps: [1] });
    call(h, 'k3', 'confirm_step', { ...bindArgs(h), user_said: 'Done.' }); // same utterance cannot confirm step 2 too
    await vi.advanceTimersByTimeAsync(1_000);
    expect(toolOutputs(h).at(-1)!.output).toMatchObject({ code: 'not_confirmed', confirmedSteps: [1] });
    expect(h.lastGuide().guide.confirmations).toEqual(['microwave-s1']);
  });

  it('waits briefly for a lagging transcription before deciding', async () => {
    const h = await connected();
    await startGuide(h);
    turnComplete(h);
    call(h, 'k1', 'confirm_step', { ...bindArgs(h), user_said: 'finished' });
    await vi.advanceTimersByTimeAsync(200);
    userSays(h, 'Finished.');
    await flush();
    expect(toolOutputs(h).at(-1)!.output).toMatchObject({ confirmedSteps: [1] });
  });

  it('typed text counts as the user\'s words', async () => {
    const h = await connected();
    await startGuide(h);
    h.send({ type: 'text', requestId: 't1', text: "I've done it" });
    call(h, 'k1', 'confirm_step', { ...bindArgs(h), user_said: "I've done it" });
    await flush();
    expect(toolOutputs(h).at(-1)!.output).toMatchObject({ confirmedSteps: [1] });
  });

  it('stale revision from the model is rejected with the current state', async () => {
    const h = await connected();
    await startGuide(h);
    call(h, 'n1', 'navigate_step', { direction: 'next', ...bindArgs(h), revision: 0 });
    await flush();
    expect(toolOutputs(h).at(-1)!.output).toMatchObject({ status: 'rejected', code: 'stale_revision', step: { n: 1 } });
  });

  it('pause, status, resume, undo and stop via tools', async () => {
    const h = await connected();
    await startGuide(h);
    userSays(h, 'done');
    call(h, 'k1', 'confirm_step', { ...bindArgs(h), user_said: 'done' });
    await flush();
    call(h, 'p1', 'pause_guide');
    await flush();
    expect(toolOutputs(h).at(-1)!.output).toMatchObject({ phase: 'paused', say: null });
    call(h, 's1', 'get_guide_status');
    await flush();
    expect(toolOutputs(h).at(-1)!.output!.say).toBe("The guide is paused. You're on step 2 of 3: Heat on full power for 4 minutes. You've confirmed step 1.");
    call(h, 'r1', 'resume_guide');
    await flush();
    expect(toolOutputs(h).at(-1)!.output).toMatchObject({ phase: 'guiding', say: 'Resuming. Step 2 of 3: Heat on full power for 4 minutes.' });
    const { guide_id, revision } = bindArgs(h);
    call(h, 'u1', 'undo_completion', { guide_id, revision });
    await flush();
    expect(toolOutputs(h).at(-1)!.output).toMatchObject({ confirmedSteps: [], step: { n: 1 } });
    call(h, 'x1', 'stop_guide');
    await flush();
    expect(toolOutputs(h).at(-1)!.output).toMatchObject({ phase: 'idle', say: 'Guide stopped.' });
  });

  it('rejects invalid guide tool arguments without executing', async () => {
    const h = await connected();
    call(h, 'bad', 'navigate_step', { direction: 'sideways' });
    call(h, 'bad2', 'confirm_step', { step_id: 'x' });
    await flush();
    expect(toolOutputs(h).map((o) => o.error?.code)).toEqual(['invalid_arguments', 'invalid_arguments']);
  });
});

describe('UI guide.inspect and guide.action', () => {
  it('inspect is throttled per GUIDE_LIMITS.inspectMinIntervalMs', async () => {
    const h = await connected({}, { mode: 'snapshot' });
    h.send({ type: 'guide.inspect', requestId: 'i1', goal: 'cooking instructions', frame: makeFrame(1) });
    await flush();
    expect(h.lastGuide()).toMatchObject({ requestId: 'i1', result: { ok: true, code: null }, guide: { phase: 'guiding' } });
    await vi.advanceTimersByTimeAsync(1_000);
    h.send({ type: 'guide.inspect', requestId: 'i2', frame: makeFrame(2) });
    await flush();
    expect(h.lastGuide()).toMatchObject({ requestId: 'i2', result: { ok: false, code: 'throttled' } });
    await vi.advanceTimersByTimeAsync(GUIDE_LIMITS.inspectMinIntervalMs);
    h.send({ type: 'guide.inspect', requestId: 'i3', frame: makeFrame(3) });
    await flush();
    expect(h.lastGuide()).toMatchObject({ requestId: 'i3', result: { ok: true } });
    expect(h.vision.extractGuide).toHaveBeenCalledTimes(2);
  });

  it('latest wins: a newer inspect aborts the older extraction and its late result is ignored', async () => {
    const h = await connected({}, { mode: 'snapshot' });
    let firstSignal: AbortSignal | undefined;
    let resolveFirst: ((e: GuideExtraction) => void) | undefined;
    h.vision.extractGuide.mockImplementationOnce(
      (input) =>
        new Promise((resolve) => {
          firstSignal = input.signal;
          resolveFirst = resolve;
        }),
    );
    h.vision.extractGuide.mockImplementationOnce(async ({ frame }) => extraction(frame, [OVEN]));
    h.send({ type: 'guide.inspect', requestId: 'i1', goal: 'cooking instructions', frame: makeFrame(1) });
    await flush();
    await vi.advanceTimersByTimeAsync(GUIDE_LIMITS.inspectMinIntervalMs);
    h.send({ type: 'guide.inspect', requestId: 'i2', frame: makeFrame(2) });
    await flush();
    expect(firstSignal?.aborted).toBe(true);
    resolveFirst!(extraction(makeFrame(1), [MICRO]));
    await flush();
    const g = h.lastGuide();
    expect(g.guide.section?.id).toBe('oven');
    expect(h.of('guide').find((m) => m.requestId === 'i1')).toMatchObject({ result: { ok: false, code: 'superseded' } });
    expect(h.of('guide').some((m) => m.guide.section?.id === 'microwave')).toBe(false);
  });

  it('requires a fresh frame newer than the last one used', async () => {
    const h = await connected({}, { mode: 'snapshot' });
    h.send({ type: 'guide.inspect', requestId: 'i1', frame: makeFrame(1, Date.now() - 60_000) });
    await flush();
    expect(h.lastGuide()).toMatchObject({ requestId: 'i1', result: { ok: false, code: 'frame_stale' } });
    h.send({ type: 'guide.inspect', requestId: 'i2', frame: makeFrame(5) });
    await flush();
    await vi.advanceTimersByTimeAsync(GUIDE_LIMITS.inspectMinIntervalMs);
    h.send({ type: 'guide.inspect', requestId: 'i3', frame: makeFrame(5) });
    await flush();
    expect(h.lastGuide()).toMatchObject({ requestId: 'i3', result: { ok: false, code: 'frame_stale' } });
    expect(h.vision.extractGuide).toHaveBeenCalledTimes(1);
  });

  it('UI actions update state and, in Live mode, inject an ordered app event with the exact say text', async () => {
    const h = await connected();
    h.send({ type: 'guide.inspect', requestId: 'i1', goal: 'cooking instructions', frame: makeFrame(1) });
    await flush();
    expect(injected(h).at(-1)).toContain('"say":"Microwave (800W) instructions, 3 steps. Step 1 of 3: Pierce film lid several times."');
    expect(injected(h).at(-1)).toContain("Say exactly the 'say' text, then stop. Do not add steps or numbers.");
    expect(h.fake.last.clientContent.at(-1)!.turnComplete).toBe(true);

    h.send({ type: 'guide.action', requestId: 'a1', action: 'next', ...uiBind(h) });
    expect(h.lastGuide()).toMatchObject({ requestId: 'a1', result: { ok: true, code: null }, guide: { currentIndex: 1 } });
    expect(h.lastGuide().guide.steps.map((s) => s.confirmed)).toEqual([false, false, false]);
    expect(injected(h).at(-1)).toContain('"say":"Step 2 of 3: Heat on full power for 4 minutes."');

    h.send({ type: 'guide.action', requestId: 'a2', action: 'confirm', ...uiBind(h) });
    expect(h.lastGuide().guide.confirmations).toEqual(['microwave-s2']);
    expect(injected(h).at(-1)).toContain('"say":"Step 2 marked done. Step 3 of 3: Stir, then heat for a further 1 minute."');

    const count = injected(h).length;
    h.send({ type: 'guide.action', requestId: 'a3', action: 'pause', ...uiBind(h) });
    expect(h.lastGuide().guide.phase).toBe('paused');
    expect(injected(h)).toHaveLength(count); // pause never speaks

    h.send({ type: 'guide.action', requestId: 'a4', action: 'explain', ...uiBind(h) });
    expect(injected(h).at(-1)).toContain('general information');

    // A retried UI request is a no-op.
    h.send({ type: 'guide.action', requestId: 'a2', action: 'confirm', ...uiBind(h) });
    expect(h.lastGuide()).toMatchObject({ requestId: 'a2', result: { ok: false, code: 'duplicate' } });
    // Wrong step from a stale UI is rejected.
    h.send({ type: 'guide.action', requestId: 'a5', action: 'resume', ...uiBind(h) });
    h.send({ type: 'guide.action', requestId: 'a6', action: 'confirm', ...uiBind(h), stepId: 'microwave-s1' });
    expect(h.lastGuide()).toMatchObject({ requestId: 'a6', result: { ok: false, code: 'wrong_step' } });
  });

  it('snapshot mode: no Live injection; the snapshot carries the texts for the client to speak', async () => {
    const h = await connected({}, { mode: 'snapshot' });
    h.send({ type: 'guide.inspect', requestId: 'i1', goal: 'cooking instructions', frame: makeFrame(1) });
    await flush();
    expect(h.lastGuide().guide.message).toBe('Microwave (800W) instructions, 3 steps. Step 1 of 3: Pierce film lid several times.');
    const v = h.lastGuide().guide.version;
    h.send({ type: 'guide.action', requestId: 'a1', action: 'status', ...uiBind(h) });
    expect(h.lastGuide()).toMatchObject({ requestId: 'a1', result: { ok: true, code: null } });
    expect(h.lastGuide().guide.message).toBe("You're on step 1 of 3: Pierce film lid several times. No steps are confirmed yet.");
    h.send({ type: 'guide.action', requestId: 'a2', action: 'explain', ...uiBind(h) });
    expect(h.lastGuide().guide.message).toBe('Step 1 of 3, as printed: Pierce film lid several times.');
    expect(h.lastGuide().guide.version).toBeGreaterThan(v);
    expect(h.lastGuide().guide.confirmations).toEqual([]);
    expect(h.lastGuide().guide.currentIndex).toBe(0);
    expect(h.fake.connector).not.toHaveBeenCalled();
  });

  it('stop cancels an in-flight extraction; its late result is ignored', async () => {
    const h = await connected({}, { mode: 'snapshot' });
    let signal: AbortSignal | undefined;
    let resolve: ((e: GuideExtraction) => void) | undefined;
    h.vision.extractGuide.mockImplementationOnce(
      (input) =>
        new Promise((r) => {
          signal = input.signal;
          resolve = r;
        }),
    );
    h.send({ type: 'guide.inspect', requestId: 'i1', goal: 'cooking', frame: makeFrame(1) });
    await flush();
    const g = h.lastGuide().guide;
    h.send({ type: 'guide.action', requestId: 'a1', action: 'stop', guideId: g.guideId, revision: g.revision });
    expect(signal?.aborted).toBe(true);
    resolve!(extraction(makeFrame(1)));
    await flush();
    expect(h.lastGuide().guide.phase).toBe('idle');
  });

  it('dispose aborts an in-flight extraction', async () => {
    const h = await connected({}, { mode: 'snapshot' });
    let signal: AbortSignal | undefined;
    h.vision.extractGuide.mockImplementationOnce((input) => {
      signal = input.signal;
      return new Promise(() => undefined);
    });
    h.send({ type: 'guide.inspect', requestId: 'i1', goal: 'cooking', frame: makeFrame(1) });
    await flush();
    h.session.dispose('socket_closed');
    expect(signal?.aborted).toBe(true);
  });
});

describe('resume key', () => {
  it('a reconnect from the same page restores the guide without replaying anything', async () => {
    const store = new GuideStore();
    const a = await connected({ store });
    await startGuide(a);
    userSays(a, 'Done');
    call(a, 'k1', 'confirm_step', { ...bindArgs(a), user_said: 'Done' });
    await flush();
    const before = a.lastGuide().guide;
    const key = a.of('ready')[0]!.resumeKey!;
    a.session.dispose('socket_closed');

    const b = await connected({ store }, { resumeKey: key, resume: true });
    expect(b.of('ready')[0]).toMatchObject({ resumeKey: key, guideRestored: true });
    const restored = b.lastGuide();
    expect(restored).toMatchObject({ requestId: null, result: null });
    expect(restored.guide).toEqual(before);
    expect(b.vision.extractGuide).not.toHaveBeenCalled();
    expect(b.fake.last.toolResponses).toHaveLength(0);
    expect(b.fake.last.clientContent).toHaveLength(0);
    // Progress continues from the restored state.
    b.send({ type: 'guide.action', requestId: 'a1', action: 'confirm', ...uiBind(b) });
    expect(b.lastGuide().guide.confirmations).toEqual(['microwave-s1', 'microwave-s2']);
  });

  it('restores with resumeKey even without resume:true (mode switch / retry)', async () => {
    const store = new GuideStore();
    const a = await connected({ store }, { mode: 'snapshot' });
    a.send({ type: 'guide.inspect', requestId: 'i1', goal: 'cooking', frame: makeFrame(1) });
    await flush();
    const key = a.of('ready')[0]!.resumeKey!;
    a.session.dispose('socket_closed');
    const b = await connected({ store }, { resumeKey: key });
    expect(b.of('ready')[0]!.guideRestored).toBe(true);
    expect(b.lastGuide().guide.phase).toBe('guiding');
  });

  it('actions without a guide answer no_guide; the final inspect answer echoes the requestId', async () => {
    const h = await connected({}, { mode: 'snapshot' });
    h.send({ type: 'guide.action', requestId: 'a1', action: 'next', guideId: null, revision: 0 });
    expect(h.lastGuide()).toMatchObject({ requestId: 'a1', result: { ok: false, code: 'no_guide' } });
    h.vision.extractGuide.mockImplementationOnce(async ({ frame }) => extraction(frame, [], UNREADABLE));
    h.send({ type: 'guide.inspect', requestId: 'i1', goal: 'cooking', frame: makeFrame(1) });
    await flush();
    const answers = h.of('guide').filter((g) => g.requestId === 'i1');
    expect(answers).toHaveLength(1);
    expect(answers[0]).toMatchObject({ result: { ok: true, code: null }, guide: { phase: 'needs_better_view' } });
    expect(h.of('guide').filter((g) => g.guide.phase === 'acquiring_image').every((g) => g.requestId === null)).toBe(true);
  });

  it('an unknown key starts fresh and says so (guideRestored false)', async () => {
    const h = await connected({}, { resumeKey: 'U'.repeat(32) });
    expect(h.of('ready')[0]!.guideRestored).toBe(false);
    expect(h.of('ready')[0]!.resumeKey).not.toBe('U'.repeat(32));
    expect(h.of('guide')).toHaveLength(0);
  });

  it('bye deletes the entry', async () => {
    const store = new GuideStore();
    const a = await connected({ store });
    const key = a.of('ready')[0]!.resumeKey!;
    a.send({ type: 'bye' });
    expect(store.size).toBe(0);
    const b = await connected({ store }, { resumeKey: key });
    expect(b.of('ready')[0]!.guideRestored).toBe(false);
  });

  it('expires after GUIDE_LIMITS.resumeTtlMs', async () => {
    const store = new GuideStore();
    const a = await connected({ store }, { mode: 'snapshot' });
    const key = a.of('ready')[0]!.resumeKey!;
    a.session.dispose('socket_closed');
    vi.setSystemTime(Date.now() + GUIDE_LIMITS.resumeTtlMs + 1);
    const b = await connected({ store }, { resumeKey: key, mode: 'snapshot' });
    expect(b.of('ready')[0]!.guideRestored).toBe(false);
  });

  it('an inspection in flight when the socket dropped is cancelled on restore (not stuck acquiring)', async () => {
    const store = new GuideStore();
    const a = await connected({ store }, { mode: 'snapshot' });
    a.vision.extractGuide.mockImplementationOnce(() => new Promise(() => undefined));
    a.send({ type: 'guide.inspect', requestId: 'i1', goal: 'cooking', frame: makeFrame(1) });
    await flush();
    expect(a.lastGuide().guide.phase).toBe('acquiring_image');
    const key = a.of('ready')[0]!.resumeKey!;
    a.session.dispose('socket_closed');
    const b = await connected({ store }, { resumeKey: key, mode: 'snapshot' });
    expect(b.lastGuide().guide.phase).toBe('idle');
    expect(b.lastGuide().guide.goal).toBe('cooking');
  });
});
