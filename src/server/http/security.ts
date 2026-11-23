/**
 * Origin validation and access gate. OWNER: lead.
 *
 * Policy:
 *  - Loopback requests (Host is localhost/127.0.0.1/[::1], socket is loopback, no proxy headers) are allowed
 *    without a token. This covers USB development via `adb reverse` / Chrome port forwarding.
 *  - Any other request (LAN IP, HTTPS tunnel, deployment) requires ACCESS_TOKEN. If ACCESS_TOKEN is unset,
 *    such requests are refused, so a tunnel can never expose an unauthenticated, billable API proxy.
 *  - The token is exchanged once via `/?access=<token>` for an HttpOnly, SameSite=Strict cookie that carries
 *    an HMAC of the token (not the token itself). WebSocket upgrades require the cookie for non-loopback hosts.
 *  - WebSocket Origin must equal the request's own origin (same-origin) or be listed in ALLOWED_ORIGINS.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import type { AppConfig } from '../config.js';

export const ACCESS_COOKIE = 'sightline_access';
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);
const PROXY_HEADERS = ['x-forwarded-for', 'x-forwarded-host', 'forwarded', 'cf-connecting-ip', 'x-real-ip'];

function headerValue(req: IncomingMessage, name: string): string | undefined {
  const v = req.headers[name];
  return Array.isArray(v) ? v[0] : v;
}

export function requestHostname(req: IncomingMessage): string {
  const host = headerValue(req, 'host') ?? '';
  try {
    return new URL(`http://${host}`).hostname;
  } catch {
    return '';
  }
}

export function isLoopbackRequest(req: IncomingMessage): boolean {
  const remote = req.socket.remoteAddress ?? '';
  const remoteIsLoopback = remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1';
  if (!remoteIsLoopback) return false;
  if (!LOOPBACK_HOSTS.has(requestHostname(req))) return false;
  return !PROXY_HEADERS.some((h) => headerValue(req, h) !== undefined);
}

export function accessCookieValue(token: string): string {
  return createHmac('sha256', token).update('sightline-access-v1').digest('base64url');
}

export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

export function parseCookies(req: IncomingMessage): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (headerValue(req, 'cookie') ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i <= 0) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

export type AccessDecision = { allowed: true } | { allowed: false; status: 401 | 403; reason: string };

export function checkAccess(req: IncomingMessage, config: AppConfig): AccessDecision {
  if (isLoopbackRequest(req)) return { allowed: true };
  if (!config.accessToken) {
    return {
      allowed: false,
      status: 403,
      reason: 'Non-localhost access is disabled. Set ACCESS_TOKEN on the server to enable HTTPS/tunnel access.',
    };
  }
  const cookie = parseCookies(req)[ACCESS_COOKIE];
  if (cookie && safeEqual(cookie, accessCookieValue(config.accessToken))) return { allowed: true };
  return { allowed: false, status: 401, reason: 'Access token required. Open the link with ?access=<token> once.' };
}

export function isSecureRequest(req: IncomingMessage): boolean {
  return headerValue(req, 'x-forwarded-proto') === 'https' || (req.socket as { encrypted?: boolean }).encrypted === true;
}

/** Same-origin check for WebSocket upgrades. */
export function checkOrigin(req: IncomingMessage, config: AppConfig): boolean {
  const origin = headerValue(req, 'origin');
  if (!origin) return false; // browsers always send Origin on WS; refuse non-browser clients without it
  if (config.allowedOrigins.includes(origin)) return true;
  let originHost: string;
  try {
    originHost = new URL(origin).host;
  } catch {
    return false;
  }
  const hosts = [headerValue(req, 'host'), headerValue(req, 'x-forwarded-host')].filter(Boolean);
  return hosts.includes(originHost);
}
