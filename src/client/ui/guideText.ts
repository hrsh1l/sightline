/**
 * Plain-language text for the "Instructions" guide panel. Text is always primary; icons and colour reinforce it.
 */
import type { GuidePhase, GuideSnapshot, GuideStepState } from '../../shared/guide.js';
import { GUIDE_LOST_TEXT } from '../session/guideSpeech.js';

export const GUIDE_INTRO = "Point the camera at the instructions. I'll tell you how to adjust the phone.";
export const GUIDE_START_LABEL = 'Guide me through instructions';
/** Same words the controller announces when a guide could not be restored. */
export const GUIDE_LOST_BANNER = GUIDE_LOST_TEXT;
export const GUIDE_DONE_NOTE = 'Only you mark a step done. Reading a step out never marks it done.';

export function isGuideActive(g: GuideSnapshot): boolean {
  return g.phase !== 'idle';
}

/** Status line text per phase (not a live region). */
export function guidePhaseText(g: GuideSnapshot): string {
  switch (g.phase) {
    case 'idle':
      return 'Not guiding any instructions.';
    case 'acquiring_image':
      return 'Checking the view…';
    case 'needs_better_view':
      return 'The view needs adjusting.';
    case 'choosing_section':
      return 'Several methods are visible. Choose one.';
    case 'preparing_guide':
      return 'Preparing the steps…';
    case 'guiding': {
      const pos = stepPositionText(g);
      return pos ? `Guiding — ${pos.toLowerCase()}.` : 'Guiding.';
    }
    case 'paused':
      return 'Paused. Tap Resume to continue.';
    case 'completed':
      return `You've confirmed all ${g.steps.length} steps.`;
    case 'error':
      return g.message ?? 'Something went wrong with the instructions.';
  }
}

/** Tone for the status shape. */
export const PHASE_TONE: Record<GuidePhase, 'ok' | 'progress' | 'warn' | 'error' | 'off'> = {
  idle: 'off',
  acquiring_image: 'progress',
  needs_better_view: 'warn',
  choosing_section: 'warn',
  preparing_guide: 'progress',
  guiding: 'ok',
  paused: 'warn',
  completed: 'ok',
  error: 'error',
};

export function stepPositionText(g: GuideSnapshot): string | null {
  if (g.currentIndex === null || !g.steps[g.currentIndex]) return null;
  return `Step ${g.currentIndex + 1} of ${g.steps.length}`;
}

export type StepStatus = 'confirmed' | 'read' | 'unread';

export function stepStatus(s: GuideStepState): StepStatus {
  if (s.confirmed) return 'confirmed';
  if (s.presented) return 'read';
  return 'unread';
}

export const STEP_STATUS_TEXT: Record<StepStatus, string> = {
  confirmed: 'Confirmed done',
  read: 'Read',
  unread: 'Not read yet',
};

export function sectionChoiceLabel(c: GuideSnapshot['sectionChoices'][number]): string {
  return `${c.title} (${c.stepCount} step${c.stepCount === 1 ? '' : 's'})`;
}

/** "12:30:05" in the device's locale/time zone. */
export function captureTimeText(ms: number): string {
  return new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' }).format(new Date(ms));
}

/** Adjustment block for needs_better_view: the server's message and its one adjustment, without repeating. */
export function adjustmentText(g: GuideSnapshot): string | null {
  const parts = [g.message?.trim(), g.adjustment?.trim()].filter((p): p is string => !!p);
  if (parts.length === 2 && parts[0]!.includes(parts[1]!)) return parts[0]!;
  if (parts.length === 2 && parts[1]!.includes(parts[0]!)) return parts[1]!;
  return parts.length ? parts.join(' ') : null;
}
