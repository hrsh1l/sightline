import { describe, expect, it } from 'vitest';
import type { IncomingMessage } from 'node:http';
import { loadConfig } from '../config.js';
import { accessCookieValue, checkAccess, checkOrigin, isLoopbackRequest, ACCESS_COOKIE } from './security.js';

function req(headers: Record<string, string>, remoteAddress = '127.0.0.1'): IncomingMessage {
  return { headers, socket: { remoteAddress } } as unknown as IncomingMessage;
}
const base = loadConfig({});
const withToken = loadConfig({ ACCESS_TOKEN: 'demo-token-123' });

describe('access gate', () => {
  it('allows loopback requests (adb reverse / Chrome port forwarding) without a token', () => {
    expect(isLoopbackRequest(req({ host: 'localhost:3000' }))).toBe(true);
    expect(checkAccess(req({ host: 'localhost:3000' }), base)).toEqual({ allowed: true });
  });
  it('refuses tunnel/LAN hosts when no ACCESS_TOKEN is configured', () => {
    const d = checkAccess(req({ host: 'abc.trycloudflare.com', 'x-forwarded-for': '1.2.3.4' }), base);
    expect(d.allowed).toBe(false);
    expect(d.allowed === false && d.status).toBe(403);
    expect(checkAccess(req({ host: '192.168.1.20:3000' }, '192.168.1.30'), base).allowed).toBe(false);
  });
  it('treats proxied requests claiming Host: localhost as non-local', () => {
    expect(isLoopbackRequest(req({ host: 'localhost:3000', 'cf-connecting-ip': '1.2.3.4' }))).toBe(false);
  });
  it('requires the HMAC cookie for non-local hosts when a token is configured', () => {
    expect(checkAccess(req({ host: 'abc.trycloudflare.com', 'x-forwarded-for': '1.2.3.4' }), withToken).allowed).toBe(false);
    const cookie = `${ACCESS_COOKIE}=${accessCookieValue('demo-token-123')}`;
    expect(checkAccess(req({ host: 'abc.trycloudflare.com', 'x-forwarded-for': '1.2.3.4', cookie }), withToken)).toEqual({ allowed: true });
    const bad = `${ACCESS_COOKIE}=${accessCookieValue('wrong')}`;
    expect(checkAccess(req({ host: 'abc.trycloudflare.com', cookie: bad }, '10.0.0.2'), withToken).allowed).toBe(false);
  });
  it('cookie value is not the raw token', () => {
    expect(accessCookieValue('demo-token-123')).not.toContain('demo-token-123');
  });
});

describe('websocket origin check', () => {
  it('accepts same-origin and rejects others or missing origin', () => {
    expect(checkOrigin(req({ host: 'localhost:3000', origin: 'http://localhost:3000' }), base)).toBe(true);
    expect(checkOrigin(req({ host: 'localhost:3000', origin: 'https://evil.example' }), base)).toBe(false);
    expect(checkOrigin(req({ host: 'localhost:3000' }), base)).toBe(false);
    expect(checkOrigin(req({ host: 'localhost:3000', origin: 'http://localhost:3001' }), base)).toBe(false);
  });
  it('accepts explicitly allowed origins', () => {
    const cfg = loadConfig({ ALLOWED_ORIGINS: 'https://demo.example.com' });
    expect(checkOrigin(req({ host: 'localhost:3000', origin: 'https://demo.example.com' }), cfg)).toBe(true);
  });
});

describe('config', () => {
  it('treats a blank key as missing and defaults models', () => {
    const c = loadConfig({ GEMINI_API_KEY: '  ' });
    expect(c.geminiApiKey).toBeNull();
    expect(c.liveModel).toBe('gemini-3.8-live');
    expect(c.timeZone).toBe('Europe/London');
  });
  it('rejects a non-local detector URL', () => {
    expect(() => loadConfig({ DETECTOR_URL: 'http://example.com:8765' })).toThrow(/private local/);
  });
  it('rejects an invalid timezone', () => {
    expect(() => loadConfig({ APP_TIMEZONE: 'Mars/Olympus' })).toThrow(/APP_TIMEZONE/);
  });
});
