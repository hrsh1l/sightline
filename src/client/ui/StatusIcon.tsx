import type { Tone } from './labels.js';

/**
 * Decorative shape that reinforces a status. Every tone has a distinct shape so state is never
 * conveyed by colour alone; the adjacent text is always the primary signal.
 */
export function StatusIcon({ tone }: { tone: Tone }) {
  return (
    <svg
      className={`status-icon status-icon--${tone}`}
      viewBox="0 0 20 20"
      aria-hidden="true"
      focusable="false"
      data-tone={tone}
    >
      {tone === 'ok' && <circle cx="10" cy="10" r="7" fill="currentColor" />}
      {tone === 'progress' && (
        <>
          <circle cx="10" cy="10" r="6.5" fill="none" stroke="currentColor" strokeWidth="2" />
          <path d="M10 3.5 A6.5 6.5 0 0 1 10 16.5 Z" fill="currentColor" />
        </>
      )}
      {tone === 'warn' && <rect x="4" y="4" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2.5" />}
      {tone === 'error' && (
        <path d="M10 2 L18.5 17.5 H1.5 Z" fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" />
      )}
      {tone === 'off' && (
        <circle cx="10" cy="10" r="6.5" fill="none" stroke="currentColor" strokeWidth="2" strokeDasharray="3 2.5" />
      )}
    </svg>
  );
}
