/** Metadata-only structured logger. OWNER: lead. Never log media, transcripts, prompts or keys. */
import type { Logger } from './contracts.js';

const SECRETISH = /(key|token|secret|authorization|password)/i;

export function createLogger(scope = 'sightline'): Logger {
  const emit = (level: 'info' | 'warn' | 'error', event: string, fields?: Record<string, unknown>) => {
    const safe: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(fields ?? {})) {
      if (SECRETISH.test(k)) continue;
      // Truncate strings defensively so accidental content cannot flood logs.
      safe[k] = typeof v === 'string' && v.length > 160 ? `${v.slice(0, 160)}…` : v;
    }
    const line = JSON.stringify({ t: new Date().toISOString(), level, scope, event, ...safe });
    if (level === 'error') console.error(line);
    else if (level === 'warn') console.warn(line);
    else console.info(line);
  };
  return {
    info: (e, f) => emit('info', e, f),
    warn: (e, f) => emit('warn', e, f),
    error: (e, f) => emit('error', e, f),
  };
}

/** Logger that records events in memory (tests). */
export function createMemoryLogger(): Logger & { events: { level: string; event: string; fields?: Record<string, unknown> }[] } {
  const events: { level: string; event: string; fields?: Record<string, unknown> }[] = [];
  const push = (level: string) => (event: string, fields?: Record<string, unknown>) => {
    events.push({ level, event, ...(fields ? { fields } : {}) });
  };
  return { events, info: push('info'), warn: push('warn'), error: push('error') };
}

/** Redact anything that looks like a Google API key from an error message before it reaches a client. */
export function redactSecrets(text: string): string {
  return text.replace(/AIza[0-9A-Za-z_-]{20,}/g, '[redacted]').replace(/(key=)[^&\s]+/gi, '$1[redacted]');
}
