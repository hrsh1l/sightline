/**
 * Plain-language text for Find mode. Positions are IMAGE-RELATIVE (where the object is in the phone's camera
 * view), never distances or walking directions: the app only knows the picture.
 */
import type { FindStatus } from '../contracts.js';
import { LIMITS, type FindCandidate, type FindState, type NormalizedBox } from '../../shared/protocol.js';
import { SUPPORTED_FIND_SENTENCE, findTargetByCoco, resolveFindTarget, type FindTarget } from '../../shared/findTargets.js';

export const FIND_INTRO = 'Sounds indicate where the object is in your phone’s camera view. Move the phone toward the sound.';
export const FIND_INTRO_DETAIL = 'Works with the rear camera. Headphones or earbuds recommended.';
export const FIND_ONLY_THESE = 'Only these for now. You can still ask me about anything else.';
export const FIND_UNSUPPORTED_TEXT = `I can only find ${SUPPORTED_FIND_SENTENCE}.`;
export const FIND_ERROR_FALLBACK = 'Find is not available right now. You can still ask me questions.';

/** Find states in which guidance is running (Stop guidance is offered). */
export const FIND_RUNNING: ReadonlySet<FindState> = new Set<FindState>([
  'searching',
  'needs_selection',
  'tracking',
  'centered',
  'lost',
  'not_found',
]);

export function isFindRunning(find: FindStatus | null): find is FindStatus {
  return !!find && FIND_RUNNING.has(find.state);
}

/** The supported target for a find status: from the query ("Find a mug" -> cup), else the target's COCO label. */
export function findTargetOf(find: FindStatus): FindTarget | null {
  return resolveFindTarget(find.query) ?? (find.target ? findTargetByCoco(find.target.label) : null);
}

/** Singular noun used in find texts ("bottle"); falls back to the raw query. */
export function findNoun(find: FindStatus): string {
  return findTargetOf(find)?.noun ?? (find.query.trim() || 'object');
}

function findPlural(find: FindStatus): string {
  return findTargetOf(find)?.plural ?? `${findNoun(find)}s`;
}

const capitalise = (s: string) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);
const withArticle = (noun: string) => `${/^[aeiou]/i.test(noun) ? 'an' : 'a'} ${noun}`;

/** "left of the picture, near the top" from a normalised box (box centre thirds-ish, with a wide middle). */
export function describeBoxPosition(box: NormalizedBox): string {
  const cx = box.x + box.w / 2;
  const cy = box.y + box.h / 2;
  const h = cx < 0.4 ? 'left' : cx > 0.6 ? 'right' : 'middle';
  const v = cy < 0.4 ? 'top' : cy > 0.6 ? 'bottom' : 'middle';
  if (h === 'middle' && v === 'middle') return 'near the centre of the picture';
  if (h === 'middle') return `in the middle of the picture, near the ${v}`;
  if (v === 'middle') return `${h} of the picture, at mid-height`;
  return `${h} of the picture, near the ${v}`;
}

/** Where the target is in the picture: the server's description first, else computed from the box. */
export function findWhere(find: FindStatus): string {
  const d = find.description?.trim();
  if (d) return d;
  if (find.target) return describeBoxPosition(find.target.box);
  return 'in the picture';
}

const findTimeoutSeconds = Math.round(LIMITS.findTimeoutMs / 1000);

const POSITION_TEXT: Record<FindCandidate['position'], string> = { left: 'Left', middle: 'Middle', right: 'Right' };

/** Overlay chip for a candidate box: "Left" / "Middle" / "Right". */
export function candidatePositionText(c: FindCandidate): string {
  return POSITION_TEXT[c.position];
}

/**
 * Accessible names for the candidate buttons: "Left cup", "Middle cup", "Right cup". If two candidates share a
 * position they are numbered ("Left cup 1", "Left cup 2") so every name stays unique.
 */
export function candidateNames(find: FindStatus): string[] {
  const noun = findNoun(find);
  const counts = new Map<string, number>();
  const candidates = find.candidates ?? [];
  for (const c of candidates) counts.set(c.position, (counts.get(c.position) ?? 0) + 1);
  const seen = new Map<string, number>();
  return candidates.map((c) => {
    const base = `${POSITION_TEXT[c.position]} ${noun}`;
    if ((counts.get(c.position) ?? 0) < 2) return base;
    const n = (seen.get(c.position) ?? 0) + 1;
    seen.set(c.position, n);
    return `${base} ${n}`;
  });
}

/** Accessible description of a candidate button (the score is not part of the name). */
export function candidateDescription(c: FindCandidate): string {
  return `Detector confidence ${Math.round(c.score * 100)}%`;
}

/** The prominent status line in the Find section. */
export function findStatusText(find: FindStatus): string {
  const noun = findNoun(find);
  switch (find.state) {
    case 'searching':
      return `Looking for ${withArticle(noun)}…`;
    case 'needs_selection': {
      const n = (find.candidates ?? []).length;
      return n > 1 ? `I see ${n} ${findPlural(find)}. Choose one:` : `I see more than one ${noun}. Choose one:`;
    }
    case 'tracking':
      return `${capitalise(noun)}: ${findWhere(find)}`;
    case 'centered':
      return `${capitalise(noun)} centred in the camera`;
    case 'lost':
      return `Lost the ${noun} — move the camera back slowly`;
    case 'not_found':
      return `No ${noun} in view yet — move the camera slowly across the area`;
    case 'stopped':
      return `Stopped finding the ${noun}`;
    case 'timeout':
      return `Stopped finding the ${noun} after ${findTimeoutSeconds} seconds`;
    case 'unsupported':
      return FIND_UNSUPPORTED_TEXT;
    case 'error':
      return find.lastPrompt?.text.trim() || FIND_ERROR_FALLBACK;
  }
}

/** First sentence of the (visually hidden) overlay summary. */
export function findSummaryText(find: FindStatus): string {
  const noun = findNoun(find);
  switch (find.state) {
    case 'centered':
      return `Finding ${noun}: centred in the camera`;
    case 'tracking':
      return `Finding ${noun}: ${findWhere(find)}`;
    case 'needs_selection':
      return `Finding ${noun}: choose one of ${(find.candidates ?? []).length} (${(find.candidates ?? []).map((c) => c.position).join(', ')})`;
    case 'searching':
      return `Finding ${noun}: searching`;
    case 'lost':
      return `Finding ${noun}: lost — move the camera back slowly`;
    case 'not_found':
      return `Finding ${noun}: not in view yet`;
    default:
      return `Finding ${noun}: stopped`;
  }
}

// Stereo check (calibration) ------------------------------------------------------------------------------------

export const CALIBRATION_STEP_TEXT: Record<'left' | 'right' | 'centre', string> = {
  left: 'Playing a tone in your LEFT ear…',
  right: 'Playing a tone in your RIGHT ear…',
  centre: 'Playing a tone in both ears (centre)…',
};
export const CALIBRATION_QUESTION =
  'Did you hear the first tone on the left, the second on the right, and the third in the middle?';
export const CALIBRATION_YES = 'Yes, I heard left, right, centre';
export const CALIBRATION_NO = 'No / only one side / no difference';
export const CALIBRATION_MIC_ADVICE = 'If stereo only fails while the microphone is on, choose ‘Release microphone for stereo’.';
export const SAMSUNG_360_NOTE =
  'For a predictable left/right baseline, turn off Samsung 360 Audio / head tracking in the Galaxy Wearable app. Sightline cannot change or read that setting.';

export function calibrationMicText(micActive: boolean): string {
  return micActive ? 'The microphone was on during this check.' : 'The microphone was off during this check.';
}
