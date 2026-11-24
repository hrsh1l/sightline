/**
 * Instruction companion state machine. Pure and deterministic (no timers, no I/O; ids injectable).
 *
 * The APPLICATION owns progress here; model history is never the only record.
 *  - Presenting/reading a step never marks it complete. Only `confirm` (an explicit user report) does.
 *  - Completion is never inferred from silence, time or images. A rescan carries confirmations only to steps whose
 *    text matches exactly or near-exactly.
 *  - Every mutation is bound to guideId + revision (+ stepId) and is idempotent by op id.
 *
 * Phases: idle -> acquiring_image -> needs_better_view | choosing_section | guiding <-> paused -> completed; error.
 * (preparing_guide is part of the shared contract but never held: extraction results are applied atomically.)
 */
import { randomBytes } from 'node:crypto';
import {
  GUIDE_LIMITS,
  IDLE_GUIDE,
  type GuideAction,
  type GuideExtraction,
  type GuidePhase,
  type GuideSection,
  type GuideSnapshot,
  type GuideStepState,
} from '../../shared/guide.js';
import {
  clip,
  DEFAULT_ADJUSTMENTS,
  joinAnd,
  matchSectionChoice,
  normalizeText,
  pickSectionsForGoal,
  sentence,
  speakableTitle,
  stepList,
  stepTextMatches,
} from './text.js';

export type GuideCode =
  | 'stale_revision'
  | 'wrong_step'
  | 'duplicate'
  | 'invalid_phase'
  | 'invalid'
  | 'unknown_section'
  | 'nothing_to_undo'
  | 'guide_active'
  | 'stale_result'
  | 'vision_failed'
  | 'vision_unavailable'
  | 'no_guide';

export interface GuideBinding {
  /** Idempotency key (client requestId or Live function-call id). */
  opId?: string | undefined;
  guideId?: string | null | undefined;
  revision?: number | undefined;
  stepId?: string | undefined;
  /** choose_section: section id, title or kind as said by the user. */
  section?: string | undefined;
}

export interface GuideResult {
  ok: boolean;
  code: GuideCode | null;
  /** Exact text to speak (null: nothing to say). */
  say: string | null;
  /** Extra instruction for the model (e.g. how to explain), or null. */
  guidance: string | null;
  /** State changed (version bumped). */
  changed: boolean;
  snapshot: GuideSnapshot;
}

export interface GuideMachineOptions {
  newGuideId?: () => string;
  /** Remembered op ids for idempotency (LRU). */
  opCacheSize?: number;
}

const OP_CACHE_SIZE = 64;
const DEFAULT_GOAL = 'instructions';

export const EXPLAIN_GUIDANCE =
  'Explain the current step in plain language, briefly, using its sourceText. Keep the printed numbers, units, temperatures, times, order and conditions exactly. Say "the packet says" for what is printed, and label anything beyond it as general information. Do not add steps or amounts, do not say whether food is safe or cooked, and do not change progress. Then ask if they are ready to continue.';

const ACTIVE: ReadonlySet<GuidePhase> = new Set(['guiding', 'paused', 'completed']);

export class GuideMachine {
  private s: GuideSnapshot = structuredClone(IDLE_GUIDE);
  /** Candidate section waiting in needs_better_view ("just read what you can"). */
  private pendingSection: GuideSection | null = null;
  /** Sections offered in choosing_section (full data, from the latest extraction). */
  private offered: GuideSection[] = [];
  /** Section the user chose for this goal; preferred on later views. */
  private chosenSectionId: string | null = null;
  private inspect: { token: number; prevPhase: GuidePhase; prevMessage: string | null } | null = null;
  private tokenCounter = 0;
  private readonly ops = new Map<string, { ok: boolean }>();
  private readonly newGuideId: () => string;
  private readonly opCacheSize: number;

  constructor(opts: GuideMachineOptions = {}) {
    this.newGuideId = opts.newGuideId ?? (() => `g-${randomBytes(6).toString('hex')}`);
    this.opCacheSize = opts.opCacheSize ?? OP_CACHE_SIZE;
  }

  // ---------------------------------------------------------------------------
  // Read-only
  // ---------------------------------------------------------------------------

  snapshot(): GuideSnapshot {
    return structuredClone(this.s);
  }

  get phase(): GuidePhase {
    return this.s.phase;
  }

  get goal(): string | null {
    return this.s.goal;
  }

  /** A guide with steps is running (guiding or paused). */
  get hasActiveGuide(): boolean {
    return (this.s.phase === 'guiding' || this.s.phase === 'paused') && this.s.steps.length > 0;
  }

  get inspecting(): boolean {
    return this.inspect !== null;
  }

  hasOp(opId: string): boolean {
    return this.ops.has(opId);
  }

  /** "Where were we?" summary. Never changes state. */
  statusText(): string {
    const s = this.s;
    switch (s.phase) {
      case 'idle':
        return 'No instructions guide is active.';
      case 'acquiring_image':
      case 'preparing_guide':
        return 'I am checking the view for the instructions.';
      case 'needs_better_view':
        return `I am still waiting for a clearer view of the instructions. ${sentence(s.adjustment ?? DEFAULT_ADJUSTMENTS.unclear)}`;
      case 'choosing_section':
        return this.choiceQuestion(s.sectionChoices.map((c) => c.title));
      case 'error':
        return s.message ?? 'Something went wrong reading the instructions. You can ask me to check the view again.';
      case 'completed':
        return `You've confirmed all ${s.steps.length} steps${s.section ? ` of the ${this.sectionName()} instructions` : ''}.`;
      case 'guiding':
      case 'paused': {
        const i = s.currentIndex ?? 0;
        const parts: string[] = [];
        if (s.phase === 'paused') parts.push('The guide is paused.');
        parts.push(`You're on step ${i + 1} of ${s.steps.length}: ${sentence(s.steps[i]?.spoken)}`);
        const confirmed = this.confirmedNumbers();
        parts.push(confirmed.length ? `You've confirmed ${stepList(confirmed)}.` : 'No steps are confirmed yet.');
        const earlier = s.steps.filter((st) => st.index < i && !st.confirmed).map((st) => st.index + 1);
        if (earlier.length) parts.push(`Not confirmed yet: ${stepList(earlier)}.`);
        return parts.join(' ');
      }
    }
  }

  /** What the current step says, as printed (basis for an explanation). */
  explainText(): string | null {
    const i = this.s.currentIndex;
    const st = i !== null ? this.s.steps[i] : undefined;
    if (!st || i === null) return null;
    const parts = [`Step ${i + 1} of ${this.s.steps.length}, as printed: ${st.sourceText.trim()}`];
    if (st.warnings.length) parts.push(`Warning: ${st.warnings.map((w) => w.trim()).join(' ')}`);
    return parts.join(' ');
  }

  /** Put a text in the UI status line (snapshot mode speaks it). Changes nothing else; bumps version if new. */
  note(text: string): GuideResult {
    const before = this.mark();
    this.s.message = clip(text, 300);
    return this.done(before, null, null);
  }

  // ---------------------------------------------------------------------------
  // Starting and inspecting
  // ---------------------------------------------------------------------------

  /**
   * Start a guide for `goal` and begin inspecting (the caller then supplies an extraction from a FRESH frame).
   * With a guide in progress and replace=false, nothing changes: 'guide_active' (ask the user first).
   */
  start(goal: string, opts: { opId?: string | undefined; replace?: boolean } = {}): { token: number | null; result: GuideResult } {
    if (opts.opId && this.ops.has(opts.opId)) return { token: null, result: this.duplicate() };
    if (this.hasActiveGuide && !opts.replace) {
      const i = this.s.currentIndex ?? 0;
      return {
        token: null,
        result: this.reject(
          'guide_active',
          `A guide${this.s.section ? ` for the ${this.sectionName()} instructions` : ''} is in progress at step ${i + 1} of ${this.s.steps.length}. Ask the user whether to replace it before starting a new one.`,
        ),
      };
    }
    const before = this.mark();
    this.resetGuide(goal);
    const token = this.beginInspectInner();
    if (opts.opId) this.remember(opts.opId, true);
    return { token, result: this.done(before, null, null) };
  }

  /**
   * Begin inspecting a fresh view for the remembered goal ("How about now?", "Check this view"). A different
   * explicit goal starts a new guide (the caller asks for confirmation first when a guide is active).
   * While guiding, the phase is kept (a rescan); otherwise -> acquiring_image.
   */
  beginInspect(goal?: string | null): { token: number; result: GuideResult } {
    const before = this.mark();
    const g = goal?.trim() || null;
    if (g && (!this.s.goal || normalizeText(g) !== normalizeText(this.s.goal))) {
      this.resetGuide(g);
    } else if (!this.s.goal) {
      this.s.goal = DEFAULT_GOAL;
    }
    if (!this.s.guideId) this.s.guideId = this.newGuideId();
    const token = this.beginInspectInner();
    return { token, result: this.done(before, null, null) };
  }

  /** Apply an extraction from a fresh frame. Results for an older inspect token are ignored ('stale_result'). */
  inspectResult(token: number, ex: GuideExtraction): GuideResult {
    if (!this.inspect || token !== this.inspect.token) return this.reject('stale_result', null);
    const before = this.mark();
    this.inspect = null;
    this.addSourceFrames(ex);
    const usable = ex.sections.filter((sec) => sec.steps.length > 0);
    const rescan = ACTIVE.has(this.s.phase) && this.s.steps.length > 0;
    const say = rescan ? this.reconcile(ex, usable) : this.applyFresh(ex, usable);
    return this.done(before, say, null);
  }

  /** The extraction failed (vision error / no vision). A running guide is kept; otherwise phase -> error. */
  inspectFailed(token: number, message: string): GuideResult {
    if (!this.inspect || token !== this.inspect.token) return this.reject('stale_result', null);
    const before = this.mark();
    this.inspect = null;
    let say: string;
    if (ACTIVE.has(this.s.phase) && this.s.steps.length > 0) {
      say = `${sentence(message)} Nothing has changed: ${this.placeText()}`;
    } else {
      this.s.phase = 'error';
      say = sentence(message);
    }
    this.setMessage(say);
    const r = this.done(before, say, null);
    return { ...r, ok: false, code: 'vision_failed' };
  }

  /** Abandon the in-flight inspect (tool cancelled, superseded by stop, socket gone). Restores the prior phase. */
  cancelInspect(token?: number): GuideResult {
    if (!this.inspect || (token !== undefined && token !== this.inspect.token)) return this.reject('stale_result', null);
    const before = this.mark();
    if (this.s.phase === 'acquiring_image') this.s.phase = this.inspect.prevPhase;
    this.s.message = this.inspect.prevMessage;
    this.inspect = null;
    return this.done(before, null, null);
  }

  // ---------------------------------------------------------------------------
  // Actions
  // ---------------------------------------------------------------------------

  act(action: GuideAction, b: GuideBinding = {}): GuideResult {
    if (b.opId && this.ops.has(b.opId)) return this.duplicate();
    const r = this.dispatch(action, b);
    if (b.opId && r.ok) this.remember(b.opId, true);
    return r;
  }

  private dispatch(action: GuideAction, b: GuideBinding): GuideResult {
    const s = this.s;
    if (action === 'status') return this.ok(this.statusText(), null, false);
    if (action === 'stop') return this.stop();

    if (b.guideId !== undefined && b.guideId !== s.guideId) return this.reject('stale_revision', this.staleGuidance());

    const allowed: Record<Exclude<GuideAction, 'status' | 'stop'>, readonly GuidePhase[]> = {
      next: ['guiding', 'completed'],
      previous: ['guiding', 'completed'],
      repeat: ['guiding', 'completed'],
      explain: ['guiding', 'completed', 'paused'],
      confirm: ['guiding'],
      undo: ['guiding', 'completed'],
      pause: ['guiding'],
      resume: ['paused'],
      choose_section: ['choosing_section'],
      continue_partial: ['needs_better_view'],
    };
    if (s.phase === 'idle') return this.reject('no_guide', this.phaseGuidance(action));
    if (!allowed[action].includes(s.phase) || (action === 'continue_partial' && !this.pendingSection)) {
      return this.reject('invalid_phase', this.phaseGuidance(action));
    }
    const checkRevision = action !== 'pause' && action !== 'resume';
    if (checkRevision && b.revision !== undefined && b.revision !== s.revision) return this.reject('stale_revision', this.staleGuidance());

    const stepBound = action === 'next' || action === 'previous' || action === 'repeat' || action === 'explain' || action === 'confirm';
    if (stepBound) {
      const cur = s.steps[s.currentIndex ?? -1];
      if (action === 'confirm' && !b.stepId) return this.reject('invalid', 'confirm needs the id of the step the user finished.');
      if (b.stepId !== undefined && (!cur || cur.id !== b.stepId)) {
        return this.reject('wrong_step', `The user is on step ${(s.currentIndex ?? 0) + 1} (id ${cur?.id ?? 'none'}), not ${b.stepId}. Progress is unchanged.`);
      }
    }

    switch (action) {
      case 'next':
        return this.next();
      case 'previous':
        return this.previous();
      case 'repeat':
        return this.repeat();
      case 'explain':
        return this.explain();
      case 'confirm':
        return this.confirm();
      case 'undo':
        return this.undo();
      case 'pause':
        return this.pause();
      case 'resume':
        return this.resume();
      case 'choose_section':
        return this.chooseSection(b.section);
      case 'continue_partial':
        return this.continuePartial();
    }
  }

  private next(): GuideResult {
    const before = this.mark();
    const s = this.s;
    const i = s.currentIndex ?? 0;
    let say: string;
    if (i + 1 < s.steps.length) {
      this.present(i + 1);
      say = this.stepSay(i + 1);
    } else {
      const unconfirmed = s.steps.filter((st) => !st.confirmed).map((st) => st.index + 1);
      say = 'That is the final instruction.';
      if (unconfirmed.length) say += ` ${this.notConfirmedText(unconfirmed)}`;
    }
    this.setMessage(say);
    return this.done(before, say, null);
  }

  private previous(): GuideResult {
    const before = this.mark();
    const i = this.s.currentIndex ?? 0;
    let say: string;
    if (i > 0) {
      this.present(i - 1);
      say = this.stepSay(i - 1);
    } else {
      say = `This is the first step. ${this.stepSay(0)}`;
    }
    this.setMessage(say);
    return this.done(before, say, null);
  }

  private repeat(): GuideResult {
    const before = this.mark();
    const i = this.s.currentIndex ?? 0;
    this.present(i);
    const say = this.stepSay(i);
    this.setMessage(say);
    return this.done(before, say, null);
  }

  private explain(): GuideResult {
    return this.ok(null, EXPLAIN_GUIDANCE, false);
  }

  private confirm(): GuideResult {
    const before = this.mark();
    const s = this.s;
    const i = s.currentIndex ?? 0;
    const st = s.steps[i]!;
    let say: string;
    if (st.confirmed) {
      say = `Step ${i + 1} is already marked done.`;
    } else {
      st.confirmed = true;
      s.confirmations.push(st.id);
      if (s.confirmations.length > GUIDE_LIMITS.maxStepsPerSection * 2) s.confirmations.shift();
      say = `Step ${i + 1} marked done.`;
    }
    const total = s.steps.length;
    if (s.steps.every((x) => x.confirmed)) {
      s.phase = 'completed';
      say = `You've confirmed all ${total} ${total === 1 ? 'step' : 'steps'}.`;
    } else if (i + 1 < total) {
      this.present(i + 1);
      say += ` ${this.stepSay(i + 1)}`;
    } else {
      const unconfirmed = s.steps.filter((x) => !x.confirmed).map((x) => x.index + 1);
      say += ` That was the final instruction. ${this.notConfirmedText(unconfirmed)}`;
    }
    this.setMessage(say);
    return this.done(before, say, null);
  }

  private undo(): GuideResult {
    const s = this.s;
    const lastId = s.confirmations[s.confirmations.length - 1];
    if (!lastId) return this.reject('nothing_to_undo', 'No step has been confirmed, so there is nothing to undo.');
    const before = this.mark();
    s.confirmations.pop();
    const st = s.steps.find((x) => x.id === lastId);
    const cur = s.currentIndex ?? 0;
    let say: string;
    if (!st) {
      say = 'Undid the last confirmation.';
    } else {
      st.confirmed = false;
      say = `Step ${st.index + 1} is no longer marked done.`;
      if (s.phase === 'completed') {
        s.phase = 'guiding';
        this.present(st.index);
        say += ` ${this.stepSay(st.index)}`;
      } else if (st.index === cur - 1) {
        this.present(st.index);
        say += ` ${this.stepSay(st.index)}`;
      } else {
        say += ` You're still on step ${cur + 1}.`;
      }
    }
    this.setMessage(say);
    return this.done(before, say, null);
  }

  private pause(): GuideResult {
    const before = this.mark();
    this.s.phase = 'paused';
    this.s.message = `Paused at step ${(this.s.currentIndex ?? 0) + 1}.`;
    return this.done(before, null, null);
  }

  private resume(): GuideResult {
    const before = this.mark();
    const i = this.s.currentIndex ?? 0;
    this.s.phase = 'guiding';
    this.present(i);
    const say = `Resuming. ${this.stepSay(i)}`;
    this.setMessage(say);
    return this.done(before, say, null);
  }

  private stop(): GuideResult {
    if (this.s.phase === 'idle' && !this.inspect) return this.ok('No instructions guide is running.', null, false);
    const before = this.mark();
    const version = this.s.version;
    const revision = this.s.revision;
    this.s = { ...structuredClone(IDLE_GUIDE), version, revision: revision + 1, message: 'Guide stopped.' };
    this.inspect = null;
    this.pendingSection = null;
    this.offered = [];
    this.chosenSectionId = null;
    return this.done(before, 'Guide stopped.', null);
  }

  private chooseSection(choice: string | undefined): GuideResult {
    const sec = choice ? matchSectionChoice(choice, this.offered) : null;
    if (!sec) {
      return this.reject('unknown_section', `Ask the user which one they want: ${joinAnd(this.offered.map((x) => speakableTitle(x.title)))}.`);
    }
    const before = this.mark();
    this.chosenSectionId = sec.id;
    this.s.sectionChoices = [];
    this.offered = [];
    this.s.revision++;
    const say = this.applySection(sec, { issue: 'none', issueEvidence: null, adjustment: null, warnings: this.s.warnings });
    return this.done(before, say, null);
  }

  private continuePartial(): GuideResult {
    const sec = this.pendingSection!;
    const before = this.mark();
    this.s.revision++;
    const say = this.beginGuide(sec, true, this.s.warnings);
    return this.done(before, say, null);
  }

  // ---------------------------------------------------------------------------
  // Extraction application
  // ---------------------------------------------------------------------------

  private applyFresh(ex: GuideExtraction, usable: GuideSection[]): string {
    this.s.revision++;
    this.s.warnings = ex.warnings.slice(0, 8);
    if (ex.readability === 'unreadable' || usable.length === 0) return this.needsView(ex, null);
    const chosen = this.chosenSectionId ? (usable.find((x) => x.id === this.chosenSectionId) ?? null) : null;
    const pick = chosen ? { single: chosen, candidates: [chosen] } : pickSectionsForGoal(this.s.goal, usable);
    if (!pick.single) return this.choosing(pick.candidates);
    return this.applySection(pick.single, ex);
  }

  private applySection(sec: GuideSection, ex: Pick<GuideExtraction, 'issue' | 'issueEvidence' | 'adjustment' | 'warnings'>): string {
    if (!sec.complete) return this.needsView(ex, sec);
    return this.beginGuide(sec, false, ex.warnings);
  }

  private needsView(ex: Pick<GuideExtraction, 'issue' | 'issueEvidence' | 'adjustment'>, sec: GuideSection | null): string {
    const s = this.s;
    s.phase = 'needs_better_view';
    s.steps = [];
    s.currentIndex = null;
    s.sectionChoices = [];
    s.confirmations = [];
    s.partial = false;
    this.offered = [];
    this.pendingSection = sec && sec.steps.length > 0 ? sec : null;
    s.section = sec ? { id: sec.id, title: sec.title, kind: sec.kind } : null;
    s.missing = sec ? sec.missing.slice(0, 6) : [];
    const adjustment = ex.adjustment?.trim() || (sec && ex.issue === 'none' ? 'Move the phone to show the rest of the instructions.' : DEFAULT_ADJUSTMENTS[ex.issue]);
    s.adjustment = clip(adjustment, 200);
    const evidence = ex.issueEvidence?.trim() || (sec ? sec.missing[0] : '') || '';
    const parts = [sec ? `I can see part of the ${speakableTitle(sec.title)} instructions.` : "I can't read the instructions yet."];
    if (evidence) parts.push(sentence(evidence));
    parts.push(sentence(adjustment));
    if (this.pendingSection) parts.push('Or say "just read what you can".');
    const say = parts.join(' ');
    this.setMessage(say);
    return say;
  }

  private choosing(candidates: GuideSection[]): string {
    const s = this.s;
    const list = candidates.slice(0, GUIDE_LIMITS.maxSections);
    s.phase = 'choosing_section';
    s.steps = [];
    s.currentIndex = null;
    s.section = null;
    s.confirmations = [];
    s.adjustment = null;
    s.partial = false;
    s.missing = [];
    this.pendingSection = null;
    this.offered = list;
    s.sectionChoices = list.map((x) => ({ id: x.id, title: x.title, stepCount: x.steps.length, complete: x.complete }));
    const say = this.choiceQuestion(list.map((x) => x.title));
    this.setMessage(say);
    return say;
  }

  private beginGuide(sec: GuideSection, partial: boolean, warnings: string[]): string {
    const s = this.s;
    s.phase = 'guiding';
    s.section = { id: sec.id, title: sec.title, kind: sec.kind };
    s.steps = sec.steps.slice(0, GUIDE_LIMITS.maxStepsPerSection).map((st, index) => ({ ...st, index, presented: false, confirmed: false }));
    s.sectionChoices = [];
    s.confirmations = [];
    s.adjustment = null;
    s.partial = partial;
    s.missing = sec.missing.slice(0, 6);
    s.warnings = warnings.slice(0, 8);
    this.pendingSection = null;
    this.offered = [];
    this.chosenSectionId = sec.id;
    this.present(0);
    const n = s.steps.length;
    const name = speakableTitle(sec.title);
    const heading = /instructions?$/i.test(name) ? name : `${name} instructions`;
    const parts = [`${heading[0]!.toUpperCase()}${heading.slice(1)}, ${n} ${n === 1 ? 'step' : 'steps'}.`];
    if (partial) parts.push(`Only part of the instructions was readable${s.missing[0] ? `: ${s.missing[0].replace(/[.]$/, '')}` : ''}.`);
    for (const w of s.warnings.slice(0, 2)) parts.push(`Printed warning: ${sentence(w)}`);
    parts.push(this.stepSay(0));
    const say = parts.join(' ');
    this.setMessage(say);
    return say;
  }

  /** Rescan while a guide is active: carry progress only to matching steps; a different document starts afresh. */
  private reconcile(ex: GuideExtraction, usable: GuideSection[]): string {
    const s = this.s;
    if (ex.readability === 'unreadable' || usable.length === 0) {
      const adjustment = ex.adjustment?.trim() || DEFAULT_ADJUSTMENTS[ex.issue];
      const say = `I couldn't read the instructions in that view, so nothing has changed. ${this.placeText()} ${sentence(adjustment)}`;
      this.setMessage(say);
      return say;
    }
    const old = s.steps;
    const candidates = [
      ...usable.filter((x) => s.section && x.id === s.section.id),
      ...usable.filter((x) => s.section && x.id !== s.section.id && normalizeText(x.title) === normalizeText(s.section.title)),
      ...usable,
    ];
    let best: { sec: GuideSection; matches: (GuideStepState | null)[]; count: number } | null = null;
    for (const sec of candidates) {
      const matches = matchSteps(old, sec.steps);
      const count = matches.filter(Boolean).length;
      if (!best || count > best.count) best = { sec, matches, count };
    }
    const related = best !== null && best.count >= 1 && best.count >= Math.ceil(0.5 * Math.min(old.length, best.sec.steps.length));
    if (!related || !best) {
      this.resetGuide(s.goal ?? DEFAULT_GOAL);
      const say = this.applyFresh(ex, usable);
      return `This looks like different instructions from before, so I've started a new guide. Earlier progress was not carried over. ${say}`;
    }
    const { sec, matches } = best;
    const oldCurrent = old[s.currentIndex ?? 0];
    const oldConfirmedCount = old.filter((x) => x.confirmed).length;
    const steps: GuideStepState[] = sec.steps.slice(0, GUIDE_LIMITS.maxStepsPerSection).map((st, index) => {
      const m = matches[index] ?? null;
      return { ...st, index, presented: m?.presented ?? false, confirmed: m?.confirmed ?? false };
    });
    const idMap = new Map<string, string>();
    matches.forEach((m, i) => {
      if (m && steps[i]) idMap.set(m.id, steps[i].id);
    });
    const confirmations = s.confirmations.map((id) => idMap.get(id)).filter((id): id is string => !!id && steps.some((x) => x.id === id && x.confirmed));
    let cur = oldCurrent ? matches.findIndex((m) => m?.id === oldCurrent.id) : -1;
    if (cur < 0) cur = steps.findIndex((x) => !x.confirmed);
    if (cur < 0) cur = steps.length - 1;

    s.revision++;
    s.section = { id: sec.id, title: sec.title, kind: sec.kind };
    s.steps = steps;
    s.confirmations = confirmations;
    s.partial = !sec.complete;
    s.missing = sec.missing.slice(0, 6);
    s.warnings = ex.warnings.slice(0, 8);
    s.adjustment = null;
    s.currentIndex = cur;
    const allConfirmed = steps.every((x) => x.confirmed);
    if (allConfirmed) s.phase = 'completed';
    else if (s.phase === 'completed') s.phase = 'guiding';

    const carried = steps.filter((x) => x.confirmed).map((x) => x.index + 1);
    const parts = ['I have updated the instructions from the new view.'];
    if (carried.length) parts.push(`Your confirmation of ${stepList(carried)} carried over.`);
    const lost = oldConfirmedCount - carried.length;
    if (lost > 0) parts.push(`${lost} earlier ${lost === 1 ? 'confirmation does' : 'confirmations do'} not match the new text, so ${lost === 1 ? 'that step starts' : 'those steps start'} unconfirmed.`);
    if (steps.length !== old.length) parts.push(`There are now ${steps.length} ${steps.length === 1 ? 'step' : 'steps'}.`);
    if (s.partial) parts.push('Part of the instructions is still not visible.');
    if (s.phase === 'completed') parts.push(`You've confirmed all ${steps.length} steps.`);
    else if (s.phase === 'paused') parts.push(`The guide is paused at step ${cur + 1}.`);
    else {
      this.present(cur);
      parts.push(this.stepSay(cur));
    }
    const say = parts.join(' ');
    this.setMessage(say);
    return say;
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  private resetGuide(goal: string) {
    const version = this.s.version;
    const revision = this.s.revision;
    this.s = {
      ...structuredClone(IDLE_GUIDE),
      goal: clip(goal.trim(), GUIDE_LIMITS.maxGoalChars),
      guideId: this.newGuideId(),
      revision: revision + 1,
      version,
    };
    this.pendingSection = null;
    this.offered = [];
    this.chosenSectionId = null;
    this.inspect = null;
  }

  private beginInspectInner(): number {
    const token = ++this.tokenCounter;
    const prevPhase = this.inspect ? this.inspect.prevPhase : this.s.phase;
    const prevMessage = this.inspect ? this.inspect.prevMessage : this.s.message;
    this.inspect = { token, prevPhase, prevMessage };
    if (!(ACTIVE.has(this.s.phase) && this.s.steps.length > 0)) {
      this.s.phase = 'acquiring_image';
    }
    this.s.message = 'Checking the view.';
    return token;
  }

  private addSourceFrames(ex: GuideExtraction) {
    const frames = ex.frameIds.map((frameId, i) => ({ frameId, capturedAt: ex.capturedAt[i] ?? ex.capturedAt[0]! }));
    this.s.sourceFrames = [...this.s.sourceFrames, ...frames].slice(-8);
  }

  private present(i: number) {
    const st = this.s.steps[i];
    if (!st) return;
    this.s.currentIndex = i;
    st.presented = true;
  }

  /**
   * "Step X of Y: <spoken>" plus printed warnings, in exactly the client's stepLine format (src/client/session/
   * guideSpeech.ts) so snapshot-mode speech de-duplicates the message against the step line.
   */
  private stepSay(i: number): string {
    const st = this.s.steps[i];
    if (!st) return '';
    let t = `Step ${i + 1} of ${this.s.steps.length}: ${st.spoken.trim()}`;
    if (!/[.!?]$/.test(t)) t += '.';
    if (st.warnings.length) t += ` Warning: ${st.warnings.map((w) => w.trim()).join(' ')}`;
    return t;
  }

  /** UI status line (<= 300 chars). When too long, drop the current step line (the client speaks it from steps). */
  private setMessage(say: string) {
    let m = say;
    if (m.length > 300 && this.s.currentIndex !== null) {
      const line = this.stepSay(this.s.currentIndex);
      if (line && m.includes(line)) m = m.replace(line, '').replace(/\s+/g, ' ').trim();
    }
    this.s.message = m ? clip(m, 300) : null;
  }

  private placeText(): string {
    const i = this.s.currentIndex ?? 0;
    return `You're on step ${i + 1} of ${this.s.steps.length}.`;
  }

  private notConfirmedText(numbers: number[]): string {
    if (!numbers.length) return '';
    return `${numbers.length === 1 ? 'One step is' : `${numbers.length} steps are`} not confirmed yet: ${stepList(numbers)}.`;
  }

  private confirmedNumbers(): number[] {
    return this.s.steps.filter((x) => x.confirmed).map((x) => x.index + 1);
  }

  private sectionName(): string {
    return this.s.section ? speakableTitle(this.s.section.title) : 'these';
  }

  private choiceQuestion(titles: string[]): string {
    const names = titles.map((t) => speakableTitle(t).replace(/\s+instructions?$/i, ''));
    return `I can see ${joinAnd(names)} instructions. Which would you like?`;
  }

  private staleGuidance(): string {
    return 'The guide has changed since that request. Use the guideId, revision and current step in this state; progress is unchanged.';
  }

  private phaseGuidance(action: GuideAction): string {
    const p = this.s.phase;
    if (p === 'paused') return 'The guide is paused. Resume it first if the user wants to continue.';
    if (p === 'idle') return 'No guide is running. Call start_guide if the user wants to be guided through instructions.';
    if (p === 'choosing_section') return 'The user has not chosen which instructions yet. Ask which one they want.';
    if (p === 'needs_better_view') return 'The instructions are not readable yet. Ask the user to adjust the view, then call inspect_current_view.';
    if (p === 'completed' && action === 'confirm') return 'Every step is already confirmed.';
    if (p === 'acquiring_image') return 'The app is still checking the view. Wait for the result.';
    return `That is not possible in the ${p.replace(/_/g, ' ')} phase.`;
  }

  /** Mark the state before a mutation (for change detection). */
  private mark(): string {
    const { version: _v, ...rest } = this.s;
    return JSON.stringify(rest);
  }

  private done(before: string, say: string | null, guidance: string | null): GuideResult {
    const changed = this.mark() !== before;
    if (changed) this.s.version++;
    return { ok: true, code: null, say, guidance, changed, snapshot: this.snapshot() };
  }

  private ok(say: string | null, guidance: string | null, changed: boolean): GuideResult {
    return { ok: true, code: null, say, guidance, changed, snapshot: this.snapshot() };
  }

  private reject(code: GuideCode, guidance: string | null): GuideResult {
    return { ok: false, code, say: null, guidance, changed: false, snapshot: this.snapshot() };
  }

  private duplicate(): GuideResult {
    return { ok: false, code: 'duplicate', say: null, guidance: 'That request was already applied. Do not repeat anything.', changed: false, snapshot: this.snapshot() };
  }

  private remember(opId: string, ok: boolean) {
    this.ops.delete(opId);
    this.ops.set(opId, { ok });
    while (this.ops.size > this.opCacheSize) this.ops.delete(this.ops.keys().next().value!);
  }
}

/** One-to-one, in-order matching of new steps to old ones: exact matches first, then near-exact. */
export function matchSteps(old: GuideStepState[], next: { sourceText: string }[]): (GuideStepState | null)[] {
  const used = new Set<number>();
  const out: (GuideStepState | null)[] = next.map(() => null);
  for (const pass of ['exact', 'near'] as const) {
    next.forEach((st, i) => {
      if (out[i]) return;
      const j = old.findIndex((o, k) => !used.has(k) && (pass === 'exact' ? stepTextMatches(o.sourceText, st.sourceText) === 'exact' : stepTextMatches(o.sourceText, st.sourceText) !== null));
      if (j >= 0) {
        used.add(j);
        out[i] = old[j]!;
      }
    });
  }
  return out;
}
