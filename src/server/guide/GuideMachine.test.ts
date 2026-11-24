/** GuideMachine tests. FIXTURE extractions only (no vision provider). */
import { describe, expect, it } from 'vitest';
import { GuideSnapshot, type GuideExtraction, type GuideSection } from '../../shared/guide.js';
import { EXPLAIN_GUIDANCE, GuideMachine, type GuideResult } from './GuideMachine.js';

const steps = (secId: string, texts: string[]) =>
  texts.map((t, i) => ({ id: `${secId}-s${i + 1}`, n: i + 1, sourceText: t, spoken: t, quantities: [], warnings: [] as string[] }));

function section(id: string, title: string, kind: GuideSection['kind'], texts: string[], over: Partial<GuideSection> = {}): GuideSection {
  return { id, title, kind, steps: steps(id, texts), complete: true, missing: [], ...over };
}

function extraction(frameId: number, sections: GuideSection[], over: Partial<GuideExtraction> = {}): GuideExtraction {
  return {
    frameIds: [frameId],
    capturedAt: [1_800_000_000_000 + frameId],
    readability: 'clear',
    issue: 'none',
    issueEvidence: null,
    adjustment: null,
    title: 'FIXTURE ready meal',
    sections,
    warnings: [],
    model: 'fake-vision',
    latencyMs: 5,
    ...over,
  };
}

const MICRO_TEXT = ['Pierce film lid several times.', 'Heat on full power for 4 minutes.', 'Stir, then heat for a further 1 minute.', 'Leave to stand for 1 minute.'];
const MICRO = section('microwave', 'MICROWAVE (800W)', 'method', MICRO_TEXT);
const OVEN = section('oven', 'OVEN', 'method', ['Preheat oven to 190°C, Fan 170°C, Gas 5.', 'Remove sleeve and pierce film.', 'Cook for 25 minutes.']);
const ASSEMBLY = section('assembly', 'Assembly', 'assembly', ['Attach the legs using 4 x M6 bolts.', 'Tighten with the 5 mm Allen key.', 'Turn the table upright.']);

function machine() {
  let n = 0;
  return new GuideMachine({ newGuideId: () => `g${++n}` });
}

function guiding(sections: GuideSection[] = [MICRO], goal = 'cooking instructions') {
  const m = machine();
  const { token } = m.start(goal);
  const r = m.inspectResult(token!, extraction(1, sections));
  return { m, r };
}

const bind = (m: GuideMachine, extra: { opId?: string; stepId?: string } = {}) => {
  const s = m.snapshot();
  return { guideId: s.guideId, revision: s.revision, stepId: s.steps[s.currentIndex ?? 0]?.id, ...extra };
};
const progress = (s: GuideSnapshot) => ({ confirmed: s.steps.map((x) => x.confirmed), confirmations: s.confirmations });
const valid = (r: GuideResult) => expect(GuideSnapshot.safeParse(r.snapshot).success).toBe(true);

describe('starting a guide', () => {
  it('start -> acquiring_image -> one complete section -> guiding at step 1, presented but NOT confirmed', () => {
    const m = machine();
    const { token, result } = m.start('cooking instructions');
    expect(token).not.toBeNull();
    expect(result.snapshot).toMatchObject({ phase: 'acquiring_image', goal: 'cooking instructions', guideId: 'g1' });
    const r = m.inspectResult(token!, extraction(7, [MICRO]));
    valid(r);
    expect(r.snapshot.phase).toBe('guiding');
    expect(r.snapshot.currentIndex).toBe(0);
    expect(r.snapshot.steps[0]).toMatchObject({ presented: true, confirmed: false });
    expect(r.snapshot.steps.every((x) => !x.confirmed)).toBe(true);
    expect(r.snapshot.sourceFrames).toEqual([{ frameId: 7, capturedAt: 1_800_000_000_007 }]);
    expect(r.say).toBe('Microwave (800W) instructions, 4 steps. Step 1 of 4: Pierce film lid several times.');
    expect(r.snapshot.message).toBe(r.say);
  });

  it('reads printed step warnings and general warnings verbatim', () => {
    const withWarn = section('oven', 'OVEN', 'method', ['Cook for 25 minutes.', 'Remove carefully.']);
    withWarn.steps[0]!.warnings = ['Contents will be hot'];
    const m = machine();
    const { token } = m.start('oven instructions');
    const r = m.inspectResult(token!, extraction(1, [withWarn], { warnings: ['Caution: steam may escape.'] }));
    expect(r.say).toBe('Oven instructions, 2 steps. Printed warning: Caution: steam may escape. Step 1 of 2: Cook for 25 minutes. Warning: Contents will be hot');
  });

  it('unreadable -> needs_better_view with ONE adjustment from the extraction; the goal is remembered', () => {
    const m = machine();
    const { token } = m.start('cooking instructions');
    const r = m.inspectResult(
      token!,
      extraction(1, [], { readability: 'unreadable', issue: 'cut_off_bottom', issueEvidence: 'steps continue below the bottom edge', adjustment: 'Move the phone down a little.' }),
    );
    valid(r);
    expect(r.snapshot.phase).toBe('needs_better_view');
    expect(r.snapshot.adjustment).toBe('Move the phone down a little.');
    expect(r.say).toBe("I can't read the instructions yet. Steps continue below the bottom edge. Move the phone down a little.");
    expect(r.snapshot.goal).toBe('cooking instructions');
    // "How about now?": a new view for the same goal.
    const next = m.beginInspect();
    expect(next.result.snapshot.phase).toBe('acquiring_image');
    expect(next.result.snapshot.goal).toBe('cooking instructions');
    const ok = m.inspectResult(next.token, extraction(2, [MICRO]));
    expect(ok.snapshot.phase).toBe('guiding');
    expect(ok.snapshot.guideId).toBe('g1');
  });

  it('falls back to a single default adjustment when the extraction gives none', () => {
    const m = machine();
    const { token } = m.start('instructions');
    const r = m.inspectResult(token!, extraction(1, [], { readability: 'unreadable', issue: 'too_far' }));
    expect(r.say).toBe("I can't read the instructions yet. Move the phone a little closer.");
  });

  it('several relevant sections and a generic goal -> choosing_section (never merged); choice -> that section only', () => {
    const { m, r } = guiding([MICRO, OVEN]);
    valid(r);
    expect(r.snapshot.phase).toBe('choosing_section');
    expect(r.snapshot.steps).toEqual([]);
    expect(r.snapshot.sectionChoices.map((c) => c.id)).toEqual(['microwave', 'oven']);
    expect(r.say).toBe('I can see microwave (800W) and oven instructions. Which would you like?');
    const bad = m.act('choose_section', { guideId: 'g1', section: 'grill' });
    expect(bad).toMatchObject({ ok: false, code: 'unknown_section' });
    const chosen = m.act('choose_section', { guideId: 'g1', section: 'the oven one' });
    valid(chosen);
    expect(chosen.snapshot.phase).toBe('guiding');
    expect(chosen.snapshot.section?.id).toBe('oven');
    expect(chosen.snapshot.steps.map((x) => x.sourceText)).toEqual(OVEN.steps.map((x) => x.sourceText));
    expect(chosen.say).toBe('Oven instructions, 3 steps. Step 1 of 3: Preheat oven to 190°C, Fan 170°C, Gas 5.');
  });

  it('a goal naming one section goes straight to it', () => {
    const { r } = guiding([MICRO, OVEN], 'microwave instructions');
    expect(r.snapshot.phase).toBe('guiding');
    expect(r.snapshot.section?.id).toBe('microwave');
  });

  it('incomplete section -> needs_better_view asking for the missing part; "just read what you can" -> partial guide', () => {
    const partial = section('microwave', 'MICROWAVE (800W)', 'method', MICRO_TEXT.slice(0, 2), {
      complete: false,
      missing: ['Text below step 2 is cut off at the bottom of the photo.'],
    });
    const m = machine();
    const { token } = m.start('microwave instructions');
    const r = m.inspectResult(token!, extraction(1, [partial], { readability: 'partial', issue: 'cut_off_bottom', adjustment: 'Move the phone down a little.' }));
    valid(r);
    expect(r.snapshot.phase).toBe('needs_better_view');
    expect(r.snapshot.section?.id).toBe('microwave');
    expect(r.snapshot.missing).toEqual(['Text below step 2 is cut off at the bottom of the photo.']);
    expect(r.say).toBe(
      'I can see part of the microwave (800W) instructions. Text below step 2 is cut off at the bottom of the photo. Move the phone down a little. Or say "just read what you can".',
    );
    const go = m.act('continue_partial', { guideId: r.snapshot.guideId, revision: r.snapshot.revision });
    valid(go);
    expect(go.snapshot).toMatchObject({ phase: 'guiding', partial: true, currentIndex: 0 });
    expect(go.snapshot.steps).toHaveLength(2);
    expect(go.say).toBe(
      'Microwave (800W) instructions, 2 steps. Only part of the instructions was readable: Text below step 2 is cut off at the bottom of the photo. Step 1 of 2: Pierce film lid several times.',
    );
  });

  it('continue_partial is invalid when nothing partial is waiting', () => {
    const m = machine();
    const { token } = m.start('x');
    m.inspectResult(token!, extraction(1, [], { readability: 'unreadable', issue: 'not_visible' }));
    expect(m.act('continue_partial')).toMatchObject({ ok: false, code: 'invalid_phase' });
  });

  it('start while a guide is active needs replace; replace starts a fresh guide', () => {
    const { m } = guiding();
    m.act('confirm', bind(m));
    const before = m.snapshot();
    const blocked = m.start('storage instructions');
    expect(blocked.token).toBeNull();
    expect(blocked.result).toMatchObject({ ok: false, code: 'guide_active' });
    expect(m.snapshot()).toEqual(before);
    const replaced = m.start('storage instructions', { replace: true });
    expect(replaced.result.snapshot).toMatchObject({ phase: 'acquiring_image', goal: 'storage instructions', guideId: 'g2', confirmations: [], steps: [] });
  });

  it('vision failure: error phase when nothing is running; a running guide is kept', () => {
    const m = machine();
    const { token } = m.start('cooking');
    const f = m.inspectFailed(token!, 'The vision service failed. Please try again.');
    expect(f).toMatchObject({ ok: false, code: 'vision_failed' });
    expect(f.snapshot.phase).toBe('error');
    expect(f.snapshot.goal).toBe('cooking');

    const { m: g } = guiding();
    g.act('confirm', bind(g));
    const t = g.beginInspect().token;
    expect(g.phase).toBe('guiding');
    const kept = g.inspectFailed(t, 'The vision service failed.');
    expect(kept.snapshot.phase).toBe('guiding');
    expect(kept.snapshot.confirmations).toEqual(['microwave-s1']);
    expect(kept.say).toBe("The vision service failed. Nothing has changed: You're on step 2 of 4.");
  });

  it('cancelInspect restores the previous phase; stale tokens are ignored', () => {
    const m = machine();
    const { token } = m.start('cooking');
    m.inspectResult(token!, extraction(1, [], { readability: 'unreadable', issue: 'glare', adjustment: 'Tilt the pack.' }));
    const a = m.beginInspect();
    const b = m.beginInspect();
    expect(m.inspectResult(a.token, extraction(2, [MICRO]))).toMatchObject({ ok: false, code: 'stale_result', changed: false });
    expect(m.cancelInspect(b.token).snapshot.phase).toBe('needs_better_view');
    expect(m.inspectResult(b.token, extraction(3, [MICRO])).code).toBe('stale_result');
  });
});

describe('navigation vs completion', () => {
  it('next presents the next step WITHOUT confirming the current one', () => {
    const { m } = guiding();
    const r = m.act('next', bind(m));
    valid(r);
    expect(r.say).toBe('Step 2 of 4: Heat on full power for 4 minutes.');
    expect(r.snapshot.currentIndex).toBe(1);
    expect(r.snapshot.steps.map((x) => x.confirmed)).toEqual([false, false, false, false]);
    expect(r.snapshot.steps.map((x) => x.presented)).toEqual([true, true, false, false]);
    expect(r.snapshot.confirmations).toEqual([]);
  });

  it('confirm marks only the CURRENT step, records it, and offers the next', () => {
    const { m } = guiding();
    m.act('next', bind(m));
    const r = m.act('confirm', bind(m));
    expect(r.say).toBe('Step 2 marked done. Step 3 of 4: Stir, then heat for a further 1 minute.');
    expect(r.snapshot.steps.map((x) => x.confirmed)).toEqual([false, true, false, false]);
    expect(r.snapshot.confirmations).toEqual(['microwave-s2']);
    expect(r.snapshot.currentIndex).toBe(2);
  });

  it('previous / repeat / explain leave completion unchanged; explain and status change nothing at all', () => {
    const { m } = guiding();
    m.act('confirm', bind(m));
    m.act('confirm', bind(m));
    const p0 = progress(m.snapshot());
    const prev = m.act('previous', bind(m));
    expect(prev.say).toBe('Step 2 of 4: Heat on full power for 4 minutes.');
    expect(progress(prev.snapshot)).toEqual(p0);
    const rep = m.act('repeat', bind(m));
    expect(rep.say).toBe('Step 2 of 4: Heat on full power for 4 minutes.');
    expect(progress(rep.snapshot)).toEqual(p0);
    const v = m.snapshot().version;
    const ex = m.act('explain', bind(m));
    expect(ex).toMatchObject({ ok: true, say: null, guidance: EXPLAIN_GUIDANCE, changed: false });
    expect(ex.snapshot.version).toBe(v);
    const st = m.act('status');
    expect(st.changed).toBe(false);
    expect(st.snapshot.version).toBe(v);
    expect(st.say).toBe("You're on step 2 of 4: Heat on full power for 4 minutes. You've confirmed steps 1 and 2.");
    // previous at the first step stays there
    m.act('previous', bind(m));
    expect(m.act('previous', bind(m)).say).toBe('This is the first step. Step 1 of 4: Pierce film lid several times.');
  });

  it('final step: "That is the final instruction." and lists unconfirmed steps; never completes by navigation', () => {
    const { m } = guiding();
    m.act('confirm', bind(m)); // 1
    m.act('next', bind(m)); // 3
    m.act('next', bind(m)); // 4
    const r = m.act('next', bind(m));
    expect(r.say).toBe('That is the final instruction. 3 steps are not confirmed yet: steps 2, 3 and 4.');
    expect(r.snapshot.phase).toBe('guiding');
    expect(r.snapshot.currentIndex).toBe(3);
    const c = m.act('confirm', bind(m));
    expect(c.say).toBe('Step 4 marked done. That was the final instruction. 2 steps are not confirmed yet: steps 2 and 3.');
    expect(c.snapshot.phase).toBe('guiding');
  });

  it('completed only after every step is confirmed, phrased as what the user reported', () => {
    const { m } = guiding();
    for (let i = 0; i < 3; i++) expect(m.act('confirm', bind(m)).snapshot.phase).toBe('guiding');
    const r = m.act('confirm', bind(m));
    valid(r);
    expect(r.snapshot.phase).toBe('completed');
    expect(r.say).toBe("You've confirmed all 4 steps.");
    expect(r.say).not.toMatch(/success/i);
    expect(m.act('confirm', bind(m))).toMatchObject({ ok: false, code: 'invalid_phase' });
    expect(m.act('status').say).toBe("You've confirmed all 4 steps of the microwave (800W) instructions.");
  });

  it('undo reverses the latest confirmation; moves back only when it was the step before the current one', () => {
    const { m } = guiding();
    expect(m.act('undo', bind(m))).toMatchObject({ ok: false, code: 'nothing_to_undo' });
    m.act('confirm', bind(m)); // confirm 1 -> on 2
    const u = m.act('undo', bind(m));
    expect(u.say).toBe('Step 1 is no longer marked done. Step 1 of 4: Pierce film lid several times.');
    expect(u.snapshot.currentIndex).toBe(0);
    expect(u.snapshot.confirmations).toEqual([]);
    m.act('confirm', bind(m)); // 1 -> on 2
    m.act('next', bind(m)); // on 3
    const u2 = m.act('undo', bind(m));
    expect(u2.say).toBe("Step 1 is no longer marked done. You're still on step 3.");
    expect(u2.snapshot.currentIndex).toBe(2);
  });

  it('undo after completion returns to guiding at the un-confirmed step', () => {
    const { m } = guiding();
    for (let i = 0; i < 4; i++) m.act('confirm', bind(m));
    const u = m.act('undo', bind(m));
    expect(u.snapshot.phase).toBe('guiding');
    expect(u.snapshot.currentIndex).toBe(3);
    expect(u.snapshot.steps[3]!.confirmed).toBe(false);
  });

  it('pause keeps everything; actions wait; resume re-presents the same step from the beginning', () => {
    const { m } = guiding();
    m.act('confirm', bind(m));
    const p = m.act('pause', bind(m));
    expect(p).toMatchObject({ ok: true, say: null });
    expect(p.snapshot).toMatchObject({ phase: 'paused', currentIndex: 1, message: 'Paused at step 2.' });
    expect(m.act('next', bind(m))).toMatchObject({ ok: false, code: 'invalid_phase' });
    expect(m.act('confirm', bind(m))).toMatchObject({ ok: false, code: 'invalid_phase' });
    expect(m.act('status').say).toBe("The guide is paused. You're on step 2 of 4: Heat on full power for 4 minutes. You've confirmed step 1.");
    const r = m.act('resume', bind(m));
    expect(r.snapshot).toMatchObject({ phase: 'guiding', currentIndex: 1 });
    expect(r.say).toBe('Resuming. Step 2 of 4: Heat on full power for 4 minutes.');
    expect(progress(r.snapshot)).toEqual({ confirmed: [true, false, false, false], confirmations: ['microwave-s1'] });
  });

  it('stop clears the guide; later actions bound to it are stale', () => {
    const { m } = guiding();
    const old = bind(m);
    const s = m.act('stop');
    valid(s);
    expect(s.say).toBe('Guide stopped.');
    expect(s.snapshot).toMatchObject({ phase: 'idle', guideId: null, steps: [], goal: null, confirmations: [] });
    expect(m.act('next', old)).toMatchObject({ ok: false, code: 'stale_revision' });
    expect(m.act('status').say).toBe('No instructions guide is active.');
    expect(m.act('next', {})).toMatchObject({ ok: false, code: 'no_guide' });
    expect(m.act('choose_section', { section: 'oven' })).toMatchObject({ ok: false, code: 'no_guide' });
    expect(m.act('stop')).toMatchObject({ ok: true, changed: false, say: 'No instructions guide is running.' });
  });
});

describe('binding and idempotency', () => {
  it('a duplicate op id is a no-op returning "duplicate" with the current state', () => {
    const { m } = guiding();
    const b = bind(m, { opId: 'op-1' });
    const first = m.act('confirm', b);
    expect(first.ok).toBe(true);
    const again = m.act('confirm', b);
    expect(again).toMatchObject({ ok: false, code: 'duplicate', changed: false, say: null });
    expect(again.snapshot.confirmations).toEqual(['microwave-s1']);
    expect(again.snapshot.version).toBe(first.snapshot.version);
  });

  it('stale revision / other guide id -> stale_revision; wrong step -> wrong_step; confirm needs a step id', () => {
    const { m } = guiding();
    const s = m.snapshot();
    expect(m.act('next', { guideId: s.guideId, revision: s.revision - 1 })).toMatchObject({ ok: false, code: 'stale_revision' });
    expect(m.act('confirm', { guideId: 'g-other', revision: s.revision, stepId: 'microwave-s1' })).toMatchObject({ ok: false, code: 'stale_revision' });
    expect(m.act('confirm', { guideId: s.guideId, revision: s.revision, stepId: 'microwave-s3' })).toMatchObject({ ok: false, code: 'wrong_step' });
    expect(m.act('confirm', { guideId: s.guideId, revision: s.revision })).toMatchObject({ ok: false, code: 'invalid' });
    expect(m.snapshot()).toEqual(s);
  });

  it('out-of-order duplicate commands bound to the same step advance only once', () => {
    const { m } = guiding();
    const b1 = bind(m, { opId: 'call-a' });
    const b2 = bind(m, { opId: 'call-b' });
    expect(m.act('next', b1).snapshot.currentIndex).toBe(1);
    expect(m.act('next', b2)).toMatchObject({ ok: false, code: 'wrong_step' });
    expect(m.snapshot().currentIndex).toBe(1);
    // confirm for step 2 arriving after a UI "next" moved on is rejected rather than confirming step 3.
    const stale = bind(m, { opId: 'call-c' });
    m.act('next', bind(m));
    expect(m.act('confirm', stale)).toMatchObject({ ok: false, code: 'wrong_step' });
    expect(m.snapshot().confirmations).toEqual([]);
  });

  it('a rescan bumps the revision: commands bound to the old revision are rejected', () => {
    const { m } = guiding();
    const old = bind(m);
    const t = m.beginInspect().token;
    m.inspectResult(t, extraction(2, [MICRO]));
    expect(m.snapshot().revision).toBe(old.revision + 1);
    expect(m.act('confirm', old)).toMatchObject({ ok: false, code: 'stale_revision' });
  });

  it('a long message drops the step line (the client speaks it from the steps); note() only sets the message', () => {
    const long = section('oven', 'OVEN', 'method', ['x'.repeat(280), 'Second.']);
    const m = machine();
    const { token } = m.start('oven');
    const r = m.inspectResult(token!, extraction(1, [long]));
    expect(r.say!.length).toBeGreaterThan(300);
    expect(r.snapshot.message).toBe('Oven instructions, 2 steps.');
    const before = m.snapshot();
    const n = m.note(m.explainText()!);
    expect(n.snapshot.message).toMatch(/^Step 1 of 2, as printed: x+/);
    expect({ ...n.snapshot, message: null, version: 0 }).toEqual({ ...before, message: null, version: 0 });
    expect(n.snapshot.version).toBe(before.version + 1);
  });

  it('every change bumps version; rejected and read-only operations do not', () => {
    const { m } = guiding();
    let v = m.snapshot().version;
    for (const a of ['next', 'confirm', 'previous'] as const) {
      const r = m.act(a, bind(m));
      expect(r.snapshot.version).toBeGreaterThan(v);
      v = r.snapshot.version;
    }
    m.act('status');
    m.act('next', { revision: 999 });
    expect(m.snapshot().version).toBe(v);
  });
});

describe('rescan reconciliation', () => {
  it('carries confirmation only to exactly or near-exactly matching steps', () => {
    const { m } = guiding();
    m.act('confirm', bind(m)); // 1
    m.act('confirm', bind(m)); // 2
    m.act('confirm', bind(m)); // 3 -> on 4
    const rescanned = section('microwave', 'MICROWAVE (800W)', 'method', [
      'PIERCE FILM LID SEVERAL TIMES', // exact after normalisation
      'Heat on full power for 5 minutes.', // number changed -> no carry
      'Stir then heat for a further 1 minute', // punctuation only
      'Leave to stand for 1 minute.',
    ]);
    const t = m.beginInspect().token;
    const r = m.inspectResult(t, extraction(2, [rescanned]));
    valid(r);
    expect(r.snapshot.guideId).toBe('g1');
    expect(r.snapshot.steps.map((x) => x.confirmed)).toEqual([true, false, true, false]);
    expect(r.snapshot.confirmations).toEqual(['microwave-s1', 'microwave-s3']);
    expect(r.snapshot.currentIndex).toBe(3); // the old current step still matches
    expect(r.say).toBe(
      'I have updated the instructions from the new view. Your confirmation of steps 1 and 3 carried over. 1 earlier confirmation does not match the new text, so that step starts unconfirmed. Step 4 of 4: Leave to stand for 1 minute.',
    );
  });

  it('when the current step no longer matches, the first unconfirmed step becomes current', () => {
    const { m } = guiding();
    m.act('confirm', bind(m)); // on 2
    const t = m.beginInspect().token;
    const r = m.inspectResult(t, extraction(2, [section('microwave', 'MICROWAVE (800W)', 'method', [MICRO_TEXT[0]!, 'Heat for 6 minutes.', MICRO_TEXT[2]!])]));
    expect(r.snapshot.currentIndex).toBe(1);
    expect(r.snapshot.steps.map((x) => x.confirmed)).toEqual([true, false, false]);
    expect(r.say).toContain('There are now 3 steps.');
  });

  it('a different document starts a new guide with fresh progress and says so', () => {
    const { m } = guiding();
    m.act('confirm', bind(m));
    const t = m.beginInspect().token;
    const r = m.inspectResult(t, extraction(2, [ASSEMBLY]));
    valid(r);
    expect(r.snapshot.guideId).toBe('g2');
    expect(r.snapshot.confirmations).toEqual([]);
    expect(r.snapshot.steps.every((x) => !x.confirmed)).toBe(true);
    expect(r.say).toMatch(/^This looks like different instructions from before, so I've started a new guide\. Earlier progress was not carried over\. /);
    expect(r.say).toContain('Step 1 of 3: Attach the legs using 4 x M6 bolts.');
  });

  it('an unreadable rescan keeps the guide and the place', () => {
    const { m } = guiding();
    m.act('confirm', bind(m));
    const before = progress(m.snapshot());
    const rev = m.snapshot().revision;
    const t = m.beginInspect().token;
    const r = m.inspectResult(t, extraction(2, [], { readability: 'unreadable', issue: 'glare', adjustment: 'Tilt the pack slightly away from the light.' }));
    expect(r.snapshot.phase).toBe('guiding');
    expect(r.snapshot.revision).toBe(rev);
    expect(progress(r.snapshot)).toEqual(before);
    expect(r.say).toBe("I couldn't read the instructions in that view, so nothing has changed. You're on step 2 of 4. Tilt the pack slightly away from the light.");
  });

  it('rescan while paused stays paused; rescan after completion stays completed when all steps still match', () => {
    const { m } = guiding();
    m.act('pause', bind(m));
    const t = m.beginInspect().token;
    expect(m.inspectResult(t, extraction(2, [MICRO])).snapshot.phase).toBe('paused');
    m.act('resume', bind(m));
    for (let i = 0; i < 4; i++) m.act('confirm', bind(m));
    const t2 = m.beginInspect().token;
    const r = m.inspectResult(t2, extraction(3, [MICRO]));
    expect(r.snapshot.phase).toBe('completed');
  });
});
