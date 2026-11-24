/**
 * Instruction companion end to end through the REAL server (startServer + WebSocket), with FIXTURE Gemini Live and
 * FIXTURE guide extractions (tests/fixtures/fixtureVision.ts). Proves app-owned progress and plumbing, NOT model
 * quality (see docs/test-results.md for live-provider runs).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ServerGuide } from '../../src/shared/protocol.js';
import { GUIDE_LIMITS } from '../../src/shared/guide.js';
import { fixtureMsg } from '../fixtures/fixtureLive.js';
import { fixtureFrame } from '../fixtures/fixtureVision.js';
import { connectOk, hello, sleep, startHarness, until, type Harness, type TestClient } from './harness.js';

let seq = 0;
const rid = (p: string) => `${p}-${++seq}`;

async function act(c: TestClient, g: ServerGuide['guide'], action: string, extra: Record<string, unknown> = {}, requestId = rid(action)) {
  c.send({ type: 'guide.action', requestId, action, guideId: g.guideId, revision: g.revision, ...extra });
  return c.waitFor('guide', (m) => m.requestId === requestId);
}

const appEvents = (h: Harness) => h.live.last!.clientContent.map((c) => JSON.stringify(c.params.turns));

describe('instruction companion: thin path over the real server (FIXTURE providers)', () => {
  let h: Harness;
  beforeAll(async () => {
    h = await startHarness();
  });
  afterAll(() => h.close());

  it('frames, extracts, walks through with explicit progress, survives a reconnect, and stops cleanly', async () => {
    h.vision.guideScenarios = ['cut_off', 'two_methods'];
    const c = await connectOk(h.port);
    c.send(hello());
    const ready = await c.waitFor('ready');
    expect(ready.resumeKey).toMatch(/^[A-Za-z0-9_-]{16,64}$/);

    // 1. "Guide me through these instructions" -> cut-off view -> ONE adjustment, goal remembered.
    const r1 = rid('inspect');
    c.send({ type: 'guide.inspect', requestId: r1, goal: 'cooking instructions', frame: fixtureFrame() });
    const g1 = await c.waitFor('guide', (m) => m.requestId === r1);
    expect(g1.guide.phase).toBe('needs_better_view');
    expect(g1.guide.adjustment).toBe('The bottom of the instructions is outside the frame. Move the phone slightly back.');
    await until(() => appEvents(h).some((e) => e.includes('Move the phone slightly back')), 3_000, 'adjustment spoken via app event');

    // 2. "How about now?" -> a NEW frame, same goal -> two methods -> ask which (never merged).
    await sleep(GUIDE_LIMITS.inspectMinIntervalMs + 100);
    const r2 = rid('inspect');
    c.send({ type: 'guide.inspect', requestId: r2, frame: fixtureFrame() });
    const g2 = await c.waitFor('guide', (m) => m.requestId === r2);
    expect(h.vision.guideCalls).toHaveLength(2);
    expect(h.vision.guideCalls[1]!.goal).toBe('cooking instructions');
    expect(h.vision.guideCalls[1]!.frame.frameId).toBeGreaterThan(h.vision.guideCalls[0]!.frame.frameId);
    expect(g2.guide.phase).toBe('choosing_section');
    expect(g2.guide.sectionChoices.map((s) => s.id)).toEqual(['microwave', 'oven']);
    expect(g2.guide.steps).toHaveLength(0);

    // 3. Choose microwave -> Step 1 presented (NOT confirmed) and spoken.
    let g = (await act(c, g2.guide, 'choose_section', { sectionId: 'microwave' })).guide;
    expect(g.phase).toBe('guiding');
    expect(g.currentIndex).toBe(0);
    expect(g.steps.map((s) => [s.presented, s.confirmed])).toEqual([[true, false], [false, false], [false, false]]);
    await until(() => appEvents(h).some((e) => e.includes('Step 1 of 3')), 3_000, 'step 1 spoken');

    // 4. Explain: no progress change.
    const before = g.version;
    g = (await act(c, g, 'explain', { stepId: 'microwave-s1' })).guide;
    expect(g.currentIndex).toBe(0);
    expect(g.confirmations).toEqual([]);
    expect(g.version).toBeGreaterThanOrEqual(before);

    // 5. Next: presents step 2 WITHOUT confirming step 1.
    const nextId = rid('next');
    g = (await act(c, g, 'next', { stepId: 'microwave-s1' }, nextId)).guide;
    expect(g.currentIndex).toBe(1);
    expect(g.steps[0]!.confirmed).toBe(false);
    expect(g.steps[1]!.presented).toBe(true);

    // 6. Duplicate request id: no double advance.
    c.send({ type: 'guide.action', requestId: nextId, action: 'next', guideId: g.guideId, revision: g.revision, stepId: 'microwave-s1' });
    await until(() => c.ofType('guide').filter((m) => m.requestId === nextId).length >= 2, 3_000, 'duplicate answered');
    const dup = c.ofType('guide').filter((m) => m.requestId === nextId)[1]!;
    expect(dup.result).toMatchObject({ ok: false, code: 'duplicate' });
    expect(dup.guide.currentIndex).toBe(1);

    // 7. Confirm bound to the wrong step is rejected; confirming the current step records it and offers step 3.
    const wrong = await act(c, g, 'confirm', { stepId: 'microwave-s1' });
    expect(wrong.result).toMatchObject({ ok: false, code: 'wrong_step' });
    g = (await act(c, g, 'confirm', { stepId: 'microwave-s2' })).guide;
    expect(g.confirmations).toEqual(['microwave-s2']);
    expect(g.steps.map((s) => s.confirmed)).toEqual([false, true, false]);
    expect(g.currentIndex).toBe(2);

    // 8. Stale revision is rejected.
    const stale = await act(c, { ...g, revision: g.revision + 5 }, 'next', { stepId: 'microwave-s3' });
    expect(stale.result).toMatchObject({ ok: false, code: 'stale_revision' });

    // 9. Pause -> resume at the same step; "Where were we?" reports place + confirmed progress.
    g = (await act(c, g, 'pause')).guide;
    expect(g.phase).toBe('paused');
    g = (await act(c, g, 'resume')).guide;
    expect(g.phase).toBe('guiding');
    expect(g.currentIndex).toBe(2);
    const st = await act(c, g, 'status');
    expect(st.guide.message ?? '').toMatch(/step 3 of 3/i);
    expect(st.guide.confirmations).toEqual(['microwave-s2']);

    // 10. Network drop: reconnect with the resume key -> same place, nothing replayed.
    const confirmsBefore = g.confirmations.length;
    c.ws.terminate();
    await sleep(100);
    const c2 = await connectOk(h.port);
    c2.send(hello({ resume: true, resumeKey: ready.resumeKey! }));
    const ready2 = await c2.waitFor('ready');
    expect(ready2.guideRestored).toBe(true);
    const restored = await c2.waitFor('guide');
    expect(restored.guide.currentIndex).toBe(2);
    expect(restored.guide.confirmations).toHaveLength(confirmsBefore);
    expect(restored.guide.guideId).toBe(g.guideId);

    // 11. Stop the guide; ordinary conversation still works.
    const stopped = await act(c2, restored.guide, 'stop');
    expect(stopped.guide.phase).toBe('idle');
    c2.send({ type: 'text', requestId: rid('text'), text: 'What is this mug?' });
    await until(() => h.live.last!.texts.some((t) => t.params.text === 'What is this mug?'), 3_000, 'normal question forwarded');

    // 12. End session (bye) drops the stored guide: a later resume key is not restored.
    c2.send({ type: 'bye' });
    await c2.closed;
    const c3 = await connectOk(h.port);
    c3.send(hello({ resume: true, resumeKey: ready2.resumeKey ?? ready.resumeKey! }));
    const ready3 = await c3.waitFor('ready');
    expect(ready3.guideRestored).not.toBe(true);
    c3.close();
  }, 20_000);

  it('voice path: start_guide tool takes a fresh still; "I\'m not done" never confirms; "Done" confirms once even if retried', async () => {
    h.vision.guideScenarios = ['microwave'];
    h.vision.guideCalls.length = 0;
    const c = await connectOk(h.port);
    c.send(hello());
    await c.waitFor('ready');
    const s = h.live.last!;

    s.emit(fixtureMsg.toolCall('call-start', 'start_guide', { goal: 'microwave instructions' }));
    const req = await c.waitFor('snapshot.request', (m) => m.purpose === 'guide');
    c.send({ type: 'snapshot.result', requestId: req.requestId, frame: fixtureFrame({ width: 3000, height: 2000 }) });
    await until(() => s.toolResponses.some((t) => JSON.stringify(t.params).includes('call-start')), 5_000, 'start_guide response');
    const startResp = JSON.stringify(s.toolResponses.find((t) => JSON.stringify(t.params).includes('call-start'))!.params);
    expect(startResp).toContain('Step 1 of 3');
    const g = (await c.waitFor('guide', (m) => m.guide.phase === 'guiding')).guide;

    // Negated / questioning utterance: the model's tool call must be refused by the app.
    s.emit(fixtureMsg.inputTranscription("I'm not done yet"));
    s.emit(fixtureMsg.toolCall('call-neg', 'confirm_step', { guide_id: g.guideId, revision: g.revision, step_id: 'microwave-s1', user_said: 'done' }));
    await until(() => s.toolResponses.some((t) => JSON.stringify(t.params).includes('call-neg')), 3_000, 'negated confirm response');
    expect(JSON.stringify(s.toolResponses.find((t) => JSON.stringify(t.params).includes('call-neg'))!.params)).toContain('not_confirmed');
    s.emit(fixtureMsg.turnComplete());

    // Real confirmation; the same tool call delivered twice must not advance twice.
    s.emit(fixtureMsg.inputTranscription('Done.'));
    const call = fixtureMsg.toolCall('call-done', 'confirm_step', { guide_id: g.guideId, revision: g.revision, step_id: 'microwave-s1', user_said: 'Done.' });
    s.emit(call);
    s.emit(call);
    await until(() => s.toolResponses.filter((t) => JSON.stringify(t.params).includes('call-done')).length >= 1, 3_000, 'confirm response');
    await sleep(300);
    const last = c.ofType('guide').at(-1)!.guide;
    expect(last.confirmations).toEqual(['microwave-s1']);
    expect(last.currentIndex).toBe(1);
    c.close();
  }, 20_000);
});
