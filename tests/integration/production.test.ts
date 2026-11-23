/**
 * Production-mode integration (NODE_ENV=production): the real server serves the static client build.
 * Requires `npm run build` first (dist/client); skipped with a visible reason otherwise.
 * FIXTURE providers only.
 */
import { existsSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { connectOk, hello, httpGet, startHarness, type Harness } from './harness.js';

const built = existsSync(path.resolve('dist/client/index.html'));

describe.runIf(built)('production static build (real server, FIXTURE providers)', () => {
  let h: Harness;
  beforeAll(async () => {
    h = await startHarness({ NODE_ENV: 'production' });
  });
  afterAll(() => h.close());

  it('serves index.html for / and SPA routes even when the project path contains a dot-directory (regression)', async () => {
    // This worktree lives under .claude/worktrees/, which made res.sendFile(absolutePath) return 404.
    for (const p of ['/', '/some/route']) {
      const r = await httpGet(h.port, p, { Host: `127.0.0.1:${h.port}` });
      expect(r.status, p).toBe(200);
      expect(r.body).toContain('<div id="root"');
    }
  });

  it('sets a strict CSP and serves hashed assets', async () => {
    const r = await httpGet(h.port, '/', { Host: `127.0.0.1:${h.port}` });
    const csp = String(r.headers['content-security-policy']);
    expect(csp).toContain("script-src 'self'");
    expect(csp).toContain("frame-ancestors 'none'");
    const asset = /src="(\/assets\/[^"]+\.js)"/.exec(r.body)?.[1];
    expect(asset).toBeTruthy();
    const js = await httpGet(h.port, asset!, { Host: `127.0.0.1:${h.port}` });
    expect(js.status).toBe(200);
    expect(js.body).not.toMatch(/AIza[0-9A-Za-z_-]{20,}/);
  });

  it('WebSocket hello -> ready works in production mode', async () => {
    const c = await connectOk(h.port);
    c.send(hello());
    expect(await c.waitFor('ready')).toMatchObject({ mode: 'live' });
    c.close();
  });
});

if (!built) {
  // Visible in the report instead of silently disappearing.
  describe('production static build', () => {
    it.skip('skipped: dist/client not built (run `npm run build` first)', () => undefined);
  });
}
