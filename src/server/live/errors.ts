/**
 * Classify provider (Gemini Live / vision) failures into protocol error codes with short, fixed,
 * client-safe messages. Raw provider payloads are never forwarded; `detail` is redacted and truncated
 * and intended for metadata logs only.
 */
import { redactSecrets } from '../log.js';
import type { ErrorCode } from '../../shared/protocol.js';

export type ProviderErrorCode = Extract<ErrorCode, 'unauthorized' | 'model_unavailable' | 'quota_exceeded' | 'provider_error'>;

export interface ProviderErrorInfo {
  code: ProviderErrorCode;
  /** Safe to show to the user. */
  message: string;
  /** HTTP status or WebSocket close code when known. */
  status: number | null;
  /** Redacted, truncated provider detail for logs. Never sent to the client. */
  detail: string;
}

export const PROVIDER_MESSAGES: Record<ProviderErrorCode, string> = {
  unauthorized: "Gemini rejected the server's API key. Check GEMINI_API_KEY in .env and restart the server.",
  model_unavailable: 'The configured Gemini Live model is not available for this API key. Check LIVE_MODEL in .env.',
  quota_exceeded: 'The Gemini quota or rate limit was exceeded. Wait a moment and try again.',
  provider_error: 'Could not reach Gemini Live.',
};

function statusFrom(err: unknown): number | null {
  if (err && typeof err === 'object') {
    const s = (err as { status?: unknown }).status;
    if (typeof s === 'number' && Number.isFinite(s)) return s;
    const c = (err as { code?: unknown }).code;
    if (typeof c === 'number' && Number.isFinite(c)) return c;
  }
  return null;
}

function textFrom(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  if (err && typeof err === 'object') {
    const reason = (err as { reason?: unknown }).reason;
    const message = (err as { message?: unknown }).message;
    if (typeof reason === 'string' && reason) return reason;
    if (typeof message === 'string') return message;
  }
  return '';
}

export function classifyByStatusAndText(status: number | null, text: string): ProviderErrorCode {
  const t = text.toLowerCase();
  if (status === 401 || status === 403 || /\b(401|403)\b|unauthori[sz]ed|unauthenticated|permission_denied|permission denied|api key not valid|invalid api key|api_key_invalid/.test(t)) {
    return 'unauthorized';
  }
  if (status === 429 || /\b429\b|resource_exhausted|resource exhausted|quota|rate limit/.test(t)) return 'quota_exceeded';
  if (status === 404 || /\b404\b|not found|not supported|unsupported model|is not available/.test(t)) return 'model_unavailable';
  return 'provider_error';
}

/** Classify a thrown error (ApiError with numeric status, SDK Error with close code text, CloseEvent-like). */
export function classifyProviderError(err: unknown): ProviderErrorInfo {
  let status = statusFrom(err);
  const text = textFrom(err);
  if (status === null) {
    const m = /\(code (\d{3,4})\)/.exec(text);
    if (m) status = Number(m[1]);
  }
  const code = classifyByStatusAndText(status, text);
  return { code, message: PROVIDER_MESSAGES[code], status, detail: redactSecrets(text).slice(0, 160) };
}

/** Classify a WebSocket close (code + reason) from the provider. */
export function classifyClose(code: number | undefined, reason: string | undefined): ProviderErrorInfo {
  const text = reason ?? '';
  const c = classifyByStatusAndText(null, text);
  return { code: c, message: PROVIDER_MESSAGES[c], status: code ?? null, detail: redactSecrets(text).slice(0, 160) };
}

/** Errors that will not be fixed by retrying the same connection. */
export function isPermanent(code: ProviderErrorCode): boolean {
  return code === 'unauthorized' || code === 'model_unavailable';
}
