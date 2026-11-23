/**
 * Plain-language text for every state the UI shows. Everything visible is text first;
 * icons and colour only reinforce it.
 */
import type {
  AppError,
  BusyKind,
  CameraState,
  ConnectionStatus,
  FindStatus,
  MicState,
  TranscriptEntry,
} from '../contracts.js';
import {
  LIMITS,
  type DateEvidence,
  type DateInterpretation,
  type DateLabelType,
  type FindState,
  type ImageIssue,
  type LabelEvidence,
  type NormalizedBox,
  type TextSection,
} from '../../shared/protocol.js';

/** Tone drives the icon shape (and colour as a secondary cue). */
export type Tone = 'ok' | 'progress' | 'warn' | 'error' | 'off';

export interface StatusText {
  text: string;
  tone: Tone;
}

export const CONNECTION_TEXT: Record<ConnectionStatus, StatusText> = {
  idle: { text: 'Not started', tone: 'off' },
  connecting: { text: 'Connecting', tone: 'progress' },
  live: { text: 'Live', tone: 'ok' },
  snapshot: { text: 'Snapshot mode', tone: 'ok' },
  reconnecting: { text: 'Reconnecting', tone: 'progress' },
  paused: { text: 'Paused — tap to resume', tone: 'warn' },
  ended: { text: 'Ended', tone: 'off' },
  error: { text: 'Error', tone: 'error' },
};

export function micText(mic: MicState, opts: { talking: boolean; pushToTalk: boolean }): StatusText {
  switch (mic.status) {
    case 'active':
      if (opts.pushToTalk) return opts.talking ? { text: 'Listening', tone: 'ok' } : { text: 'On — hold to talk', tone: 'ok' };
      return { text: 'On', tone: 'ok' };
    case 'muted':
      return { text: 'Muted', tone: 'warn' };
    case 'requesting':
      return { text: 'Asking permission', tone: 'progress' };
    case 'denied':
      return { text: 'Denied — allow microphone access', tone: 'error' };
    case 'unavailable':
      return { text: 'No microphone found', tone: 'error' };
    case 'in_use':
      return { text: 'In use by another app', tone: 'error' };
    case 'insecure_context':
      return { text: 'Blocked — page is not secure', tone: 'error' };
    case 'error':
      return { text: 'Error', tone: 'error' };
    case 'idle':
    case 'stopped':
      return { text: 'Off', tone: 'off' };
  }
}

export function cameraText(camera: CameraState): StatusText {
  switch (camera.status) {
    case 'active':
      if (camera.facing === 'environment') return { text: 'Rear camera', tone: 'ok' };
      if (camera.facing === 'user') return { text: 'Front camera', tone: 'ok' };
      return { text: 'Camera on', tone: 'ok' };
    case 'requesting':
      return { text: 'Asking permission', tone: 'progress' };
    case 'paused':
      return { text: 'Paused', tone: 'warn' };
    case 'denied':
      return { text: 'Denied — allow camera access', tone: 'error' };
    case 'unavailable':
      return { text: 'No camera found', tone: 'error' };
    case 'in_use':
      return { text: 'In use by another app', tone: 'error' };
    case 'insecure_context':
      return { text: 'Blocked — page is not secure', tone: 'error' };
    case 'disconnected':
      return { text: 'Disconnected', tone: 'error' };
    case 'error':
      return { text: 'Error', tone: 'error' };
    case 'idle':
    case 'stopped':
      return { text: 'Off', tone: 'off' };
  }
}

export const BUSY_TEXT: Record<BusyKind, string> = {
  connecting: 'Connecting…',
  reading_label: 'Reading label…',
  looking: 'Looking again…',
  answering: 'Answering…',
  finding: 'Finding…',
};

// ---------------------------------------------------------------------------
// Find mode. Positions are IMAGE-RELATIVE (where the item is in the camera picture), never distances or
// walking directions: the app only knows the picture.
// ---------------------------------------------------------------------------

/** Find states that still need a Stop button (the search is running). */
export const FIND_RUNNING: ReadonlySet<FindState> = new Set<FindState>(['searching', 'tracking', 'centered', 'lost', 'not_found']);

export function isFindRunning(find: FindStatus | null): find is FindStatus {
  return !!find && FIND_RUNNING.has(find.state);
}

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

/** The prominent status line in the Find section. */
export function findStatusText(find: FindStatus): string {
  const q = `“${find.query}”`;
  switch (find.state) {
    case 'searching':
      return `Searching for ${q}…`;
    case 'tracking':
      return `${q} is ${findWhere(find)}`;
    case 'centered':
      return `${q} centred in the picture`;
    case 'lost':
      return `Lost ${q} — move the camera slowly`;
    case 'not_found':
      return `Not found: ${q} — try moving the camera slowly or a different name`;
    case 'stopped':
      return `Stopped finding ${q}`;
    case 'timeout':
      return `Stopped finding ${q} after ${findTimeoutSeconds} seconds`;
  }
}

/** First sentence of the (visually hidden) overlay summary. */
export function findSummaryText(find: FindStatus): string {
  const where =
    find.state === 'centered'
      ? 'centred in the picture'
      : find.state === 'tracking'
        ? findWhere(find)
        : find.state === 'searching'
          ? 'searching'
          : find.state === 'lost'
            ? 'lost — move the camera slowly'
            : find.state === 'not_found'
              ? 'not found'
              : 'stopped';
  return `Finding ${find.query}: ${where}`;
}

export const DETECTION_SOURCE_TEXT: Record<'yolo' | 'gemini', string> = {
  yolo: 'YOLO · generic objects',
  gemini: 'Gemini · searched item',
};

export const ROLE_TEXT: Record<TranscriptEntry['role'], string> = {
  user: 'You',
  assistant: 'Sightline',
  system: 'App',
};

/** Source labels shown next to an entry. Live transcription is the default and gets no label. */
export function sourceText(entry: TranscriptEntry): string | null {
  switch (entry.source) {
    case 'typed':
      return 'typed';
    case 'snapshot_answer':
      return 'from a still photo';
    case 'evidence':
      return 'from label reading';
    case 'system':
    case 'live_transcription':
      return null;
  }
}

export const SECTION_TEXT: Record<TextSection, string> = {
  product_name: 'Product name',
  brand: 'Brand',
  ingredients: 'Ingredients',
  allergens: 'Allergens',
  cooking_instructions: 'Cooking instructions',
  storage: 'Storage',
  after_opening: 'After opening',
  dates: 'Dates',
  nutrition: 'Nutrition',
  warnings: 'Warnings',
  other: 'Other text',
};

export const SECTION_ORDER: TextSection[] = [
  'product_name',
  'brand',
  'cooking_instructions',
  'allergens',
  'ingredients',
  'storage',
  'after_opening',
  'dates',
  'warnings',
  'nutrition',
  'other',
];

export const DATE_LABEL_TEXT: Record<DateLabelType, string> = {
  use_by: 'Use by',
  best_before: 'Best before',
  best_before_end: 'Best before end',
  display_until: 'Display until',
  sell_by: 'Sell by',
  packed_on: 'Packed on',
  production_date: 'Production date',
  expiry_unspecified: 'Expiry date (type not stated)',
  unknown: 'Date (type unclear)',
};

export const DATE_STATUS_TEXT: Record<DateInterpretation['status'], string> = {
  parsed: 'Read clearly',
  ambiguous: 'Ambiguous — could be read more than one way',
  incomplete: 'Incomplete',
  unparseable: 'Could not interpret',
};

/** The server compares against its configured time zone (APP_TIMEZONE, Europe/London by default). */
export const DEFAULT_TIME_ZONE = 'Europe/London';

/** "Europe/London" -> "London"; falls back to the raw zone id. */
export function placeForTimeZone(timeZone: string | null | undefined): string {
  const zone = timeZone || DEFAULT_TIME_ZONE;
  const last = zone.split('/').pop() ?? zone;
  return last.replace(/_/g, ' ') || zone;
}

/** Neutral comparison only. Never a safety judgement. */
export function comparisonText(c: DateInterpretation['comparison'], timeZone?: string | null): string {
  const place = placeForTimeZone(timeZone);
  switch (c) {
    case 'past':
      return `Printed date is in the past relative to today in ${place}.`;
    case 'today':
      return `Printed date is today in ${place}.`;
    case 'future':
      return `Printed date is in the future relative to today in ${place}.`;
    case 'unknown':
      return 'Could not compare the printed date with today.';
  }
}

/** Format an ISO yyyy-mm-dd as e.g. "24 November 2026" without time-zone drift. */
export function formatIsoDate(iso: string): string {
  const d = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return iso;
  return new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC', day: 'numeric', month: 'long', year: 'numeric' }).format(d);
}

export function dateInterpretationText(d: DateEvidence): string {
  const i = d.interpretation;
  const parts: string[] = [];
  if (i.status === 'parsed' && i.isoDate) parts.push(`Read as ${formatIsoDate(i.isoDate)}.`);
  else parts.push(`${DATE_STATUS_TEXT[i.status]}.`);
  if (i.note.trim()) parts.push(i.note.trim());
  return parts.join(' ');
}

export const READABILITY_TEXT: Record<LabelEvidence['readability'], string> = {
  clear: 'Clear',
  partial: 'Partly readable',
  unreadable: 'Unreadable',
};

export const ISSUE_TEXT: Record<ImageIssue, string> = {
  text_cut_off: 'text cut off at the edge',
  glare: 'glare',
  too_far: 'too far away',
  blurry: 'blurry',
  too_dark: 'too dark',
  angled: 'at an angle',
  obstructed: 'partly covered',
  no_text_visible: 'no text visible',
};

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export const CONNECTION_HELP =
  'Open via http://localhost:3000 with adb reverse, or an https link. See docs/s25-connection.md.';

export const MISSING_CREDENTIALS_TEXT =
  'The server has no Gemini API key configured, so Sightline cannot answer yet. Add GEMINI_API_KEY to the server’s .env file, restart the server, then reload this page.';

export const ERROR_ACTION_TEXT: Record<Exclude<NonNullable<AppError['action']>, 'none'>, string> = {
  retry: 'Try again',
  tap_to_resume: 'Resume',
  use_snapshot: 'Use snapshot mode',
  open_settings: 'Open settings',
};

/** Short, concrete help for errors where the user can do something specific. */
export function errorHelp(error: AppError, camera: CameraState | null, mic: MicState | null): string | null {
  switch (error.code) {
    case 'insecure_context':
      return `Camera and microphone only work on a secure page. ${CONNECTION_HELP}`;
    case 'missing_credentials':
      return MISSING_CREDENTIALS_TEXT;
    case 'camera':
      if (camera?.status === 'denied')
        return 'Allow camera access: in Chrome, tap the icon to the left of the address, open Permissions, set Camera to Allow, then try again.';
      if (camera?.status === 'in_use') return 'Another app is using the camera. Close it, then try again.';
      if (camera?.status === 'insecure_context') return `The page is not secure. ${CONNECTION_HELP}`;
      return null;
    case 'microphone':
      if (mic?.status === 'denied')
        return 'Allow microphone access: in Chrome, tap the icon to the left of the address, open Permissions, set Microphone to Allow, then try again. You can also use snapshot mode and type questions.';
      if (mic?.status === 'in_use') return 'Another app is using the microphone. Close it, then try again.';
      if (mic?.status === 'insecure_context') return `The page is not secure. ${CONNECTION_HELP}`;
      return null;
    case 'audio_output':
      return 'Sound is blocked until you tap the screen. Tap Resume, and check the phone is not on silent.';
    case 'network':
      return `Check the phone can still reach the server. ${CONNECTION_HELP}`;
    case 'quota_exceeded':
    case 'rate_limited':
      return 'The AI provider is limiting requests. Wait a minute, then try again.';
    default:
      return null;
  }
}
