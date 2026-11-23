/**
 * FIXTURE e2e server for Playwright. Starts the REAL Sightline server (startServer, production static build)
 * with a scripted FIXTURE Live connector and FIXTURE vision. NOTHING here talks to Google; results obtained
 * against this server are desktop-Chromium + FIXTURE evidence only, never live-model or S25 validation.
 *
 * Ports (override with env):
 *   E2E_PORT          (3101) app with FIXTURE Live + FIXTURE vision
 *   E2E_NOKEY_PORT    (3102) app with no credentials (no connector, no vision) -> honest missing_credentials
 *   E2E_CONTROL_PORT  (3109) test-only control API on 127.0.0.1:
 *       GET  /health          -> {ok:true}
 *       GET  /stats           -> what the FIXTURE provider received, per provider session (counts + timestamps)
 *       POST /reply?ms=N      -> stream an N ms FIXTURE tone reply (+ "FIXTURE long reply" transcript) on the newest session
 *       POST /tool            -> FIXTURE provider calls read_label on the newest session
 *
 * Auto reply: once a provider session has received >= 1 video frame and >= 10 audio chunks, the FIXTURE
 * replies once with a 600 ms 24 kHz PCM16 tone, output transcription "FIXTURE reply" and turnComplete.
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { startServer } from '../../src/server/index.js';
import { loadConfig } from '../../src/server/config.js';
import { createMemoryLogger } from '../../src/server/log.js';
import { createFixtureLive, fixtureMsg, toneBase64, type FixtureLiveSession } from '../fixtures/fixtureLive.js';
import { createFixtureVision, disabledDetector } from '../fixtures/fixtureVision.js';

const PORT = Number(process.env.E2E_PORT ?? 3101);
const NOKEY_PORT = Number(process.env.E2E_NOKEY_PORT ?? 3102);
const CONTROL_PORT = Number(process.env.E2E_CONTROL_PORT ?? 3109);

const live = createFixtureLive();
const vision = createFixtureVision();
const log = createMemoryLogger();
const replied = new Set<number>();
let replyTimers: ReturnType<typeof setTimeout>[] = [];

const CHUNK_MS = 200;
const chunk = toneBase64(CHUNK_MS, 24_000, 440, 0.15);

/** Stream `ms` of FIXTURE audio in 200 ms parts, every `everyMs`, then transcript + turnComplete. */
function streamReply(s: FixtureLiveSession, ms: number, text: string, everyMs: number) {
  const parts = Math.max(1, Math.round(ms / CHUNK_MS));
  s.emit(fixtureMsg.outputTranscription(text));
  for (let i = 0; i < parts; i++) {
    replyTimers.push(setTimeout(() => s.emit(fixtureMsg.audio(chunk)), i * everyMs));
  }
  replyTimers.push(
    setTimeout(() => {
      s.emit(fixtureMsg.generationComplete());
      s.emit(fixtureMsg.turnComplete());
    }, parts * everyMs + 10),
  );
}

live.onRealtime = (s) => {
  if (replied.has(s.index) || s.closed) return;
  if (s.frames.length >= 1 && s.audio.length >= 10) {
    replied.add(s.index);
    setTimeout(() => {
      s.emit(fixtureMsg.inputTranscription('FIXTURE heard you'));
      streamReply(s, 600, 'FIXTURE reply', 0);
    }, 50);
  }
};

function stats() {
  return {
    fixture: true,
    sessions: live.sessions.map((s) => ({
      index: s.index,
      openedAt: s.openedAt,
      closed: s.closed,
      closedAt: s.closedAt,
      sendsAfterClose: s.sendsAfterClose,
      frames: s.frames.length,
      frameTimes: s.frames.map((f) => f.at),
      audio: s.audio.length,
      audioTimes: s.audio.map((a) => a.at),
      audioMimes: [...new Set(s.audio.map((a) => a.params.audio?.mimeType ?? null))],
      audioStreamEnds: s.realtime.filter((r) => r.params.audioStreamEnd).length,
      texts: s.texts.map((t) => t.params.text),
      clientContent: s.clientContent.map((c) => JSON.stringify(c.params.turns).slice(0, 300)),
      toolResponses: s.toolResponses.map((t) => JSON.stringify(t.params.functionResponses).slice(0, 2_000)),
    })),
    vision: {
      extractCalls: vision.extractCalls.map((c) => ({
        frameId: c.frame.frameId,
        width: c.frame.width,
        height: c.frame.height,
        capturedAt: c.frame.capturedAt,
        receivedAt: Date.now(),
      })),
      answerCalls: vision.answerCalls.map((c) => ({ frameId: c.frame.frameId, question: c.question })),
    },
    log: log.events.map((e) => ({ level: e.level, event: e.event, fields: e.fields ?? {} })),
  };
}

function json(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

function newestOpen(): FixtureLiveSession | undefined {
  return [...live.sessions].reverse().find((s) => !s.closed);
}

function control(req: IncomingMessage, res: ServerResponse) {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1');
  if (req.method === 'GET' && url.pathname === '/health') return json(res, 200, { ok: true, fixture: true });
  if (req.method === 'GET' && url.pathname === '/stats') return json(res, 200, stats());
  if (req.method === 'POST' && url.pathname === '/reply') {
    const s = newestOpen();
    if (!s) return json(res, 409, { error: 'no open FIXTURE session' });
    const ms = Math.min(20_000, Number(url.searchParams.get('ms') ?? 4_000));
    // Real-time pacing (one 200 ms part every 200 ms) keeps the provider emitting after a client Stop.
    streamReply(s, ms, url.searchParams.get('text') ?? 'FIXTURE long reply', CHUNK_MS);
    return json(res, 200, { ok: true, session: s.index });
  }
  if (req.method === 'POST' && url.pathname === '/tool') {
    const s = newestOpen();
    if (!s) return json(res, 409, { error: 'no open FIXTURE session' });
    const id = `fixture-call-${Date.now()}`;
    s.emit(fixtureMsg.toolCall(id, 'read_label', {}));
    return json(res, 200, { ok: true, id, session: s.index });
  }
  return json(res, 404, { error: 'not_found' });
}

async function main() {
  const base = { NODE_ENV: 'production', HOST: '127.0.0.1', LOG_DEBUG: '0' };
  const app = await startServer(loadConfig({ ...base, PORT: String(PORT), MAX_CONCURRENT_SESSIONS: '4' }), {
    liveConnector: live.connector,
    vision,
    detector: disabledDetector,
    log,
  });
  const noKey = await startServer(loadConfig({ ...base, PORT: String(NOKEY_PORT), GEMINI_API_KEY: '' }), {
    liveConnector: null,
    vision: null,
    detector: disabledDetector,
    log: createMemoryLogger(),
  });
  const ctl = createServer(control);
  await new Promise<void>((r) => ctl.listen(CONTROL_PORT, '127.0.0.1', r));
  console.info(`[FIXTURE e2e] app http://127.0.0.1:${PORT}  no-key http://127.0.0.1:${NOKEY_PORT}  control http://127.0.0.1:${CONTROL_PORT}`);
  const shutdown = () => {
    for (const t of replyTimers) clearTimeout(t);
    replyTimers = [];
    void Promise.allSettled([app.close(), noKey.close(), new Promise((r) => ctl.close(r))]).finally(() => process.exit(0));
    setTimeout(() => process.exit(0), 2_000).unref();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
