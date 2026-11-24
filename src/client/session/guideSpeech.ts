/**
 * Instruction companion: pure helpers for the controller (snapshot ordering, what to say / announce on a change).
 *
 * The server owns guide progress; these functions only decide whether a ServerGuide snapshot replaces the one we
 * have, and which short app-generated text describes the change. Nothing here marks a step complete.
 */
import type { GuideAction, GuideSnapshot, GuideStepState } from '../../shared/guide.js';

/** What the user asked for that a snapshot answers (a guide.action or a guide.inspect from this client). */
export type GuideCause = GuideAction | 'inspect' | null;

export const GUIDE_LOST_TEXT = "I lost track of the instructions after the connection dropped. Say 'guide me' to start again.";
export const GUIDE_NOT_CONNECTED_TEXT = 'Not connected. Guide controls work again once Sightline reconnects.';

/** Short, polite text for a request the server ignored (ServerGuide.result.ok === false). null = say nothing. */
export function guideRejectText(code: string | null): string | null {
  switch (code) {
    case 'duplicate':
      return null; // the same press arrived twice: the first one already counted
    case 'stale_revision':
    case 'stale':
      return 'Ignored: that was for an older view of the instructions.';
    case 'wrong_step':
      return 'Ignored: that was for a different step. Nothing changed.';
    case 'throttled':
      return 'Checking too often. Wait a moment, then try again.';
    case 'no_guide':
      return 'There are no instructions to guide yet.';
    case 'invalid':
      return 'That is not available right now. Nothing changed.';
    default:
      return 'That did not work. Nothing changed.';
  }
}

/** Apply `next` only when it is newer than `cur` (higher version), or names a different guide / newer revision. */
export function isNewerGuide(cur: GuideSnapshot, next: GuideSnapshot): boolean {
  if (next.guideId !== cur.guideId) return true;
  if (next.revision !== cur.revision) return next.revision > cur.revision;
  return next.version > cur.version;
}

export function currentStep(g: GuideSnapshot): GuideStepState | null {
  if (g.currentIndex === null) return null;
  return g.steps[g.currentIndex] ?? null;
}

/** "Step 2 of 5" for the current step, or null. */
export function stepPosition(g: GuideSnapshot): string | null {
  if (g.currentIndex === null || !g.steps[g.currentIndex]) return null;
  return `Step ${g.currentIndex + 1} of ${g.steps.length}`;
}

/** Spoken line for the current step: "Step X of Y: <spoken>" plus its printed warnings. */
export function stepLine(g: GuideSnapshot): string | null {
  const s = currentStep(g);
  const pos = stepPosition(g);
  if (!s || !pos) return null;
  let t = `${pos}: ${s.spoken.trim()}`;
  if (!/[.!?]$/.test(t)) t += '.';
  if (s.warnings.length) t += ` Warning: ${s.warnings.map((w) => w.trim()).join(' ')}`;
  return t;
}

/** The question asked in choosing_section. */
export function sectionQuestion(g: GuideSnapshot): string {
  const n = g.sectionChoices.length;
  const list = g.sectionChoices.map((c) => `${c.title}, ${c.stepCount} step${c.stepCount === 1 ? '' : 's'}`).join('; ');
  return `I can see ${n} different method${n === 1 ? '' : 's'}: ${list}. Which one?`;
}

/** "Where were we?" when the server gives no message. */
export function statusSummary(g: GuideSnapshot): string {
  if (g.phase === 'idle') return 'No instructions are being guided.';
  const done = g.steps.filter((s) => s.confirmed).length;
  const pos = stepPosition(g);
  const what = g.section?.title ?? g.title ?? 'the instructions';
  const parts = [`Guiding ${what}.`];
  if (pos) parts.push(`${pos}.`);
  if (g.steps.length) parts.push(`${done} of ${g.steps.length} confirmed done.`);
  if (g.phase === 'paused') parts.push('Paused.');
  return parts.join(' ');
}

const stepNumberOf = (g: GuideSnapshot, id: string | undefined) => {
  if (!id) return null;
  const i = g.steps.findIndex((s) => s.id === id);
  return i >= 0 ? i + 1 : null;
};

/**
 * Short status for an important change (confirmation, undo, pause, resume, completion, stop, error), or null.
 * Suitable for a polite screen-reader announcement: never the whole step text.
 */
export function guideShortStatus(prev: GuideSnapshot, next: GuideSnapshot): string | null {
  const sameGuide = prev.guideId === next.guideId && prev.revision === next.revision;
  if (next.phase !== prev.phase) {
    if (next.phase === 'completed') return `All ${next.steps.length} steps confirmed done.`;
    if (next.phase === 'idle' && prev.phase !== 'idle') return 'Guide stopped.';
    if (next.phase === 'paused') return 'Guide paused.';
    if (prev.phase === 'paused' && next.phase === 'guiding') return 'Guide resumed.';
    if (next.phase === 'error') return next.message ?? 'Something went wrong with the instructions.';
  }
  if (sameGuide && next.confirmations.length > prev.confirmations.length) {
    const n = stepNumberOf(next, next.confirmations.at(-1));
    return n ? `Step ${n} confirmed done.` : 'Step confirmed done.';
  }
  if (sameGuide && next.confirmations.length < prev.confirmations.length) {
    const n = stepNumberOf(next, prev.confirmations.at(-1));
    return n ? `Undone: step ${n} is no longer marked done.` : 'Undone: the last step is no longer marked done.';
  }
  return null;
}

function stepIdentity(g: GuideSnapshot): string {
  return `${g.guideId}|${g.revision}|${currentStep(g)?.id ?? ''}`;
}

/** True when the presented step changed (different step, section, revision or guide). */
export function presentedStepChanged(prev: GuideSnapshot, next: GuideSnapshot): boolean {
  return currentStep(next) !== null && stepIdentity(prev) !== stepIdentity(next);
}

/** Drop parts already contained in an earlier/longer part, keep order. */
function joinParts(parts: Array<string | null | undefined>): string | null {
  const clean = parts.map((p) => p?.trim() ?? '').filter(Boolean);
  const out: string[] = [];
  for (const p of clean) {
    if (out.some((o) => o.includes(p))) continue;
    for (let i = out.length - 1; i >= 0; i--) if (p.includes(out[i]!)) out.splice(i, 1);
    out.push(p);
  }
  return out.length ? out.join(' ') : null;
}

/**
 * Snapshot mode (no Gemini Live voice): the text the app speaks with local TTS for this change, or null.
 * Step changes are spoken once; messages are spoken when new or when they answer the user's own request.
 */
export function guideSpeech(prev: GuideSnapshot, next: GuideSnapshot, cause: GuideCause): string | null {
  const asked = cause !== null;
  const phaseChanged = next.phase !== prev.phase;
  const message = next.message && (next.message !== prev.message || asked) ? next.message : null;
  const status = guideShortStatus(prev, next);
  switch (next.phase) {
    case 'acquiring_image':
    case 'preparing_guide':
      return asked ? message : null; // earcons + the working tick cover these
    case 'needs_better_view': {
      const adj = next.adjustment && (phaseChanged || next.adjustment !== prev.adjustment || asked) ? next.adjustment : null;
      return joinParts([message, adj]);
    }
    case 'choosing_section':
      return phaseChanged || asked ? joinParts([message ?? sectionQuestion(next)]) : message;
    case 'guiding': {
      const speakStep = presentedStepChanged(prev, next) || cause === 'repeat' || (phaseChanged && prev.phase === 'paused');
      const extra = cause === 'status' && !message ? statusSummary(next) : null;
      return joinParts([message ?? status, extra, speakStep ? stepLine(next) : null]);
    }
    case 'paused':
      return joinParts([message ?? status, cause === 'status' && !message ? statusSummary(next) : null]);
    case 'completed':
      return joinParts([message ?? status]);
    case 'idle':
      return joinParts([message ?? status]);
    case 'error':
      return phaseChanged || asked ? joinParts([message ?? status]) : null;
  }
}

/**
 * Short polite announcement for screen-reader users when the change is NOT spoken by the app (Live mode, where the
 * model speaks; or snapshot mode without TTS). Never the whole step text.
 */
export function guideAnnouncement(prev: GuideSnapshot, next: GuideSnapshot, cause: GuideCause, spokenByModel: boolean): string | null {
  const status = guideShortStatus(prev, next);
  if (status) return status;
  if (spokenByModel) return null; // the model reads steps, adjustments and questions aloud
  if (next.phase === 'needs_better_view' && next.adjustment && (next.phase !== prev.phase || next.adjustment !== prev.adjustment || cause !== null)) {
    return next.adjustment;
  }
  if (next.phase === 'choosing_section' && (next.phase !== prev.phase || cause !== null)) {
    return `${next.sectionChoices.length} methods found. Choose one.`;
  }
  if (next.phase === 'guiding' && (presentedStepChanged(prev, next) || cause === 'repeat')) {
    const pos = stepPosition(next);
    return pos ? `${pos}.` : null;
  }
  if (cause === 'status') return statusSummary(next);
  return null;
}
