/**
 * Plain-language text for every state the UI shows. Everything visible is text first;
 * icons and colour only reinforce it.
 */
import type {
  AppError,
  BusyKind,
  CameraState,
  ConnectionStatus,
  MicState,
  TranscriptEntry,
} from '../contracts.js';
import type { DateEvidence, DateInterpretation, DateLabelType, ImageIssue, LabelEvidence, TextSection } from '../../shared/protocol.js';

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

/**
 * The server compares against its configured time zone (APP_TIMEZONE, Europe/London by default).
 * ServerInfo does not yet expose it; see contract change request in the interface report.
 */
export const COMPARISON_PLACE = 'London';

/** Neutral comparison only. Never a safety judgement. */
export function comparisonText(c: DateInterpretation['comparison']): string {
  switch (c) {
    case 'past':
      return `Printed date is in the past relative to today in ${COMPARISON_PLACE}.`;
    case 'today':
      return `Printed date is today in ${COMPARISON_PLACE}.`;
    case 'future':
      return `Printed date is in the future relative to today in ${COMPARISON_PLACE}.`;
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
