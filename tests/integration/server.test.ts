/**
 * Integration tests: the REAL HTTP + WebSocket server (startServer) with FIXTURE Live connector and FIXTURE vision,
 * driven by a real `ws` client. These prove the server plumbing (security, validation, forwarding, turn filtering,
 * tool loop, fallback, cleanup). They do NOT prove anything about the real Gemini models.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { HealthResponse, INPUT_AUDIO_MIME, LIMITS, LabelEvidence } from '../../src/shared/protocol.js';
import { LIVE_READ_LABEL_PREFIX, MISSING_CREDENTIALS_MESSAGE } from '../../src/server/session/ClientSession.js';
import { accessCookieValue } from '../../src/server/http/security.js';
import { fixtureMsg, toneBase64 } from '../fixtures/fixtureLive.js';
import { FIXTURE_ANSWER, FIXTURE_VISION_MODEL, fixtureFrame } from '../fixtures/fixtureVision.js';
import {
  FIXTURE_API_KEY,
  connectOk,
  connectWs,
  hello,
  httpGet,
  liveClient,
  sleep,
  startHarness,
  until,
  type Harness,
} from './harness.js';

const pcm16k = toneBase64(100, 16_000); // 100 ms FIXTURE mic chunk
const pcm24k = toneBase64(100, 24_000); // 100 ms FIXTURE model audio

describe('HTTP: health and access gate (real server, FIXTURE providers)', () => {
  let h: Harness;
  beforeAll(async () => {
    h = await startHarness();
  });
  afterAll(() => h.close());

  it('GET /api/health returns the contract shape and no secrets', async () => {
    const r = await httpGet(h.port, '/api/health', { Host: `127.0.0.1:${h.port}` });
    expect(r.status).toBe(200);
    expect(r.headers['cache-control']).toBe('no-store');
    const body = HealthResponse.parse(JSON.parse(r.body));
    expect(body).toMatchObject({ ok: true, configured: true, detector: 'disabled', accessGate: false, timeZone: 'Europe/London' });
    expect(body.models.live).toBe('gemini-3.8-live');
    expect(r.body).not.toContain(FIXTURE_API_KEY);
    expect(r.body.toLowerCase()).not.toMatch(/apikey|api_key|secret|token/);
  });

  it('sets security headers', async () => {
    const r = await httpGet(h.port, '/api/health', { Host: `localhost:${h.port}` });
    expect(r.headers['x-content-type-options']).toBe('nosniff');
    expect(r.headers['permissions-policy']).toContain('camera=(self)');
    expect(r.headers['x-powered-by']).toBeUndefined();
  });

  it('refuses a non-localhost Host when ACCESS_TOKEN is unset (HTTP 403 and WS 403)', async () => {
    const r = await httpGet(h.port, '/api/health', { Host: 'sightline.example.test' });
    expect(r.status).toBe(403);
    expect(r.body).not.toContain(FIXTURE_API_KEY);
    const ws = await connectWs(h.port, { origin: 'https://sightline.example.test', headers: { Host: 'sightline.example.test' } });
    expect(ws).toEqual({ ok: false, status: 403 });
  });

  it('rejects a cross-origin WebSocket with 403, and a missing Origin with 403', async () => {
    expect(await connectWs(h.port, { origin: 'https://evil.example' })).toEqual({ ok: false, status: 403 });
    expect(await connectWs(h.port, { origin: null })).toEqual({ ok: false, status: 403 });
    expect(h.log.events.filter((e) => e.event === 'ws_rejected' && e.fields?.reason === 'origin').length).toBeGreaterThanOrEqual(2);
    expect(h.live.sessions).toHaveLength(0);
  });
});

describe('HTTP: access token cookie for tunnel hosts', () => {
  const TOKEN = 'fixture-access-token-0123456789abcdef';
  let h: Harness;
  beforeAll(async () => {
    h = await startHarness({ ACCESS_TOKEN: TOKEN });
  });
  afterAll(() => h.close());

  it('/?access=<token> sets an HttpOnly cookie and redirects without the token; the cookie then allows HTTP and WS', async () => {
    const host = 'sightline.example.test';
    expect((await httpGet(h.port, '/api/health', { Host: host })).status).toBe(401);
    expect((await httpGet(h.port, '/?access=wrong', { Host: host })).status).toBe(401);

    const ex = await httpGet(h.port, `/?access=${TOKEN}`, { Host: host });
    expect(ex.status).toBe(302);
    expect(ex.headers.location).toBe('/');
    const setCookie = (ex.headers['set-cookie'] ?? []).join(';');
    expect(setCookie).toMatch(/sightline_access=/);
    expect(setCookie).toMatch(/HttpOnly/i);
    expect(setCookie).toMatch(/SameSite=Strict/i);
    expect(setCookie).not.toContain(TOKEN);
    const cookie = setCookie.split(';')[0]!;
    expect(cookie).toBe(`sightline_access=${accessCookieValue(TOKEN)}`);

    const health = await httpGet(h.port, '/api/health', { Host: host, Cookie: cookie });
    expect(health.status).toBe(200);
    expect(JSON.parse(health.body)).toMatchObject({ accessGate: true });

    const denied = await connectWs(h.port, { origin: `https://${host}`, headers: { Host: host } });
    expect(denied).toEqual({ ok: false, status: 401 });
    const allowed = await connectWs(h.port, { origin: `https://${host}`, headers: { Host: host, Cookie: cookie } });
    expect(allowed.ok).toBe(true);
    if (allowed.ok) allowed.client.close();
  });
});

describe('WebSocket session (real server, FIXTURE Live + FIXTURE vision)', () => {
  let h: Harness;
  beforeAll(async () => {
    h = await startHarness({ MAX_CONCURRENT_SESSIONS: '20' });
  });
  afterAll(() => h.close());
  const open: { close(): void }[] = [];
  afterEach(() => {
    for (const c of open.splice(0)) c.close();
  });
  const start = async () => {
    const r = await liveClient(h);
    open.push(r.client);
    return r;
  };

  it('hello -> status connecting/live -> ready; first message must be hello', async () => {
    const { client, ready, session } = await start();
    expect(ready).toMatchObject({ mode: 'live', features: { live: true, snapshot: true, detections: false }, timeZone: 'Europe/London' });
    expect(ready.models).toEqual({ live: 'gemini-3.8-live', vision: FIXTURE_VISION_MODEL });
    expect(client.ofType('status').map((s) => s.state)).toEqual(['connecting', 'live']);
    // Connect config reached the FIXTURE connector: model, audio modality, transcription, tools.
    expect(session.params.model).toBe('gemini-3.8-live');
    expect(JSON.stringify(session.params.config)).toContain('read_label');

    const other = await connectOk(h.port);
    open.push(other);
    other.send({ type: 'audio', seq: 0, data: pcm16k });
    const err = await other.waitFor('error');
    expect(err).toMatchObject({ code: 'invalid_message', recoverable: false });
    expect((await other.closed).code).toBe(1008);
  });

  it('forwards mic audio with mime audio/pcm;rate=16000 and frames as image/jpeg', async () => {
    const { client, session } = await start();
    for (let i = 0; i < 5; i++) client.send({ type: 'audio', seq: i, data: pcm16k });
    client.send({ type: 'audio.end' });
    const f = fixtureFrame();
    client.send({ type: 'frame', frame: f });
    await until(() => session.audio.length === 5 && session.frames.length === 1 && session.realtime.some((r) => r.params.audioStreamEnd));
    expect(session.audio.every((a) => a.params.audio?.mimeType === INPUT_AUDIO_MIME)).toBe(true);
    expect(INPUT_AUDIO_MIME).toBe('audio/pcm;rate=16000');
    expect(session.audio[0]!.params.audio?.data).toBe(pcm16k);
    expect(session.frames[0]!.params.video).toEqual({ data: f.data, mimeType: 'image/jpeg' });
  });

  it('1 FPS guard: frames sent every 200 ms for 3 s reach the provider at most once per ~second', async () => {
    const { client, session } = await start();
    const t0 = Date.now();
    while (Date.now() - t0 < 3_000) {
      client.send({ type: 'frame', frame: fixtureFrame() });
      await sleep(200);
    }
    await sleep(100);
    const n = session.frames.length;
    expect(n).toBeGreaterThanOrEqual(3);
    expect(n).toBeLessThanOrEqual(4);
    const gaps = session.frames.slice(1).map((f, i) => f.at - session.frames[i]!.at);
    expect(Math.min(...gaps)).toBeGreaterThanOrEqual(900);
  });

  it('drops stale (old capturedAt) and out-of-order (lower frameId) frames', async () => {
    const { client, session } = await start();
    const newer = fixtureFrame();
    const older = fixtureFrame({ frameId: newer.frameId - 1 });
    client.send({ type: 'frame', frame: newer });
    await until(() => session.frames.length === 1);
    await sleep(1_000); // past the 1 FPS guard so only staleness/order can reject
    client.send({ type: 'frame', frame: older });
    client.send({ type: 'frame', frame: fixtureFrame({ capturedAt: Date.now() - LIMITS.frameMaxAgeMs - 500 }) });
    await sleep(150);
    expect(session.frames).toHaveLength(1);
    const fresh = fixtureFrame();
    client.send({ type: 'frame', frame: fresh });
    await until(() => session.frames.length === 2);
    expect(session.frames[1]!.params.video?.data).toBe(fresh.data);
  });

  it('streams model audio and transcripts with server turn ids; interrupted -> turn interrupted and no more audio of that turn', async () => {
    const { client, session } = await start();
    session.emit(fixtureMsg.inputTranscription('what is this'));
    session.emit(fixtureMsg.audio(pcm24k));
    session.emit(fixtureMsg.outputTranscription('FIXTURE reply'));
    await client.waitFor('turn', (t) => t.event === 'start' && t.turnId === 1);
    await client.waitFor('audio', (a) => a.turnId === 1);
    session.emit(fixtureMsg.interrupted());
    await client.waitFor('turn', (t) => t.event === 'interrupted' && t.turnId === 1);
    const before = client.ofType('audio').length;
    // Late output of the interrupted turn (provider keeps draining) must be discarded by the server.
    session.emit(fixtureMsg.audio(pcm24k));
    session.emit(fixtureMsg.outputTranscription(' more of the cancelled turn'));
    session.emit(fixtureMsg.turnComplete());
    await client.waitFor('turn', (t) => t.event === 'complete' && t.turnId === 1);
    expect(client.ofType('audio')).toHaveLength(before);
    expect(client.ofType('transcript').some((t) => t.text.includes('cancelled turn'))).toBe(false);
    // The next turn flows normally with a new id.
    session.emit(fixtureMsg.audio(pcm24k));
    const next = await client.waitFor('audio', (a) => a.turnId === 2);
    expect(next.seq).toBe(0);
  });

  it('playback.stop cancels the turn on the server and discards its remaining audio', async () => {
    const { client, session } = await start();
    session.emit(fixtureMsg.audio(pcm24k));
    await client.waitFor('audio', (a) => a.turnId === 1);
    client.send({ type: 'playback.stop', turnId: 1 });
    await client.waitFor('turn', (t) => t.event === 'cancelled' && t.turnId === 1);
    session.emit(fixtureMsg.audio(pcm24k));
    session.emit(fixtureMsg.audio(pcm24k));
    session.emit(fixtureMsg.turnComplete());
    await client.waitFor('turn', (t) => t.event === 'complete' && t.turnId === 1);
    expect(client.ofType('audio').filter((a) => a.turnId === 1)).toHaveLength(1);
  });

  it('read_label tool: toolCall -> snapshot.request -> snapshot.result -> evidence -> sendToolResponse', async () => {
    const { client, session } = await start();
    session.emit(fixtureMsg.toolCall('call-7', 'read_label', { focus: 'dates' }));
    await client.waitFor('tool', (t) => t.state === 'started' && t.name === 'read_label');
    const req = await client.waitFor('snapshot.request');
    expect(req).toMatchObject({ purpose: 'read_label', maxDim: LIMITS.snapshotMaxDim });
    const frame = fixtureFrame({ width: 1200, height: 1600 });
    client.send({ type: 'snapshot.result', requestId: req.requestId, frame });
    const ev = await client.waitFor('evidence');
    expect(ev.requestId).toBe(req.requestId);
    expect(LabelEvidence.parse(ev.evidence).frameId).toBe(frame.frameId);
    expect(h.vision.extractCalls.at(-1)).toMatchObject({ frame: { frameId: frame.frameId, width: 1200 }, focus: 'dates' });
    await client.waitFor('tool', (t) => t.state === 'completed');
    await until(() => session.toolResponses.length === 1);
    const fr = session.toolResponses[0]!.params.functionResponses;
    const first = Array.isArray(fr) ? fr[0] : fr;
    expect(first).toMatchObject({ id: 'call-7', name: 'read_label', response: { output: { status: 'ok' } } });
    expect(JSON.stringify(first)).toContain('BEST BEFORE END 03 2027');
    expect(JSON.stringify(first)).toContain('L4471 B2');
  });

  it('toolCallCancellation cancels the tool; a late snapshot.result produces no tool response', async () => {
    const { client, session } = await start();
    session.emit(fixtureMsg.toolCall('call-9', 'read_label'));
    const req = await client.waitFor('snapshot.request');
    session.emit(fixtureMsg.toolCallCancellation('call-9'));
    await client.waitFor('tool', (t) => t.state === 'cancelled' && t.callId === 'call-9');
    client.send({ type: 'snapshot.result', requestId: req.requestId, frame: fixtureFrame() });
    await sleep(200);
    expect(session.toolResponses).toHaveLength(0);
    expect(client.ofType('evidence')).toHaveLength(0);
  });

  it('Read label button in live mode: fresh high-res frame -> evidence -> ordered client content to Live', async () => {
    const { client, session } = await start();
    const frame = fixtureFrame({ width: 1200, height: 1600 });
    client.send({ type: 'action', requestId: 'read_label-1', action: 'read_label', frame });
    const ev = await client.waitFor('evidence');
    expect(ev).toMatchObject({ requestId: 'read_label-1', evidence: { batchCodes: ['L4471 B2'] } });
    await until(() => session.clientContent.length === 1);
    const turns = session.clientContent[0]!.params.turns;
    expect(JSON.stringify(turns)).toContain(LIVE_READ_LABEL_PREFIX.slice(0, 40));
    // A stale frame is refused honestly.
    client.send({ type: 'action', requestId: 'read_label-2', action: 'read_label', frame: fixtureFrame({ capturedAt: Date.now() - 10_000 }) });
    expect(await client.waitFor('error', (e) => e.requestId === 'read_label-2')).toMatchObject({ code: 'frame_stale', recoverable: true });
  });

  it('goAway -> reconnect with the resumption handle; old provider session closed; media flows to the new one only', async () => {
    const { client, session } = await start();
    session.emit(fixtureMsg.resumption('fixture-handle-1'));
    session.emit(fixtureMsg.goAway('0s'));
    await client.waitFor('notice', (n) => n.code === 'go_away');
    const second = await h.live.waitForSession(session.index + 1);
    await client.waitFor('notice', (n) => n.code === 'session_resumed');
    expect(session.closed).toBe(true);
    expect(JSON.stringify(second.params.config)).toContain('fixture-handle-1');
    client.send({ type: 'audio', seq: 0, data: pcm16k });
    await until(() => second.audio.length === 1);
    expect(session.sendsAfterClose).toBe(0);
    expect(session.audio).toHaveLength(0);
  });

  it('rejects invalid messages after hello as recoverable and keeps the session', async () => {
    const { client, session } = await start();
    client.sendRaw('{not json');
    client.send({ type: 'frame', frame: { ...fixtureFrame(), data: `data:image/jpeg;base64,${fixtureFrame().data}` } });
    client.send({ type: 'nope' });
    await until(() => client.ofType('error').length === 3);
    expect(client.ofType('error').every((e) => e.code === 'invalid_message' && e.recoverable)).toBe(true);
    expect(session.frames).toHaveLength(0);
    client.send({ type: 'audio', seq: 0, data: pcm16k });
    await until(() => session.audio.length === 1);
  });

  it('bye -> socket closed 1000, provider session closed, nothing further reaches the provider', async () => {
    const { client, session } = await start();
    client.send({ type: 'audio', seq: 0, data: pcm16k });
    await until(() => session.audio.length === 1);
    client.send({ type: 'bye' });
    expect((await client.closed).code).toBe(1000);
    await until(() => session.closed, 2_000, 'provider session closed');
    const calls = session.realtime.length + session.clientContent.length + session.toolResponses.length;
    // Provider output after the client left goes nowhere and triggers nothing.
    session.emit(fixtureMsg.toolCall('late', 'read_label'));
    session.emit(fixtureMsg.audio(pcm24k));
    await sleep(300);
    expect(session.realtime.length + session.clientContent.length + session.toolResponses.length).toBe(calls);
    expect(session.sendsAfterClose).toBe(0);
    expect(h.log.events.some((e) => e.event === 'session_disposed' && e.fields?.reason === 'bye')).toBe(true);
  });

  it('abrupt socket close (no bye) disposes the session and closes the provider session', async () => {
    const { client, session } = await start();
    client.ws.terminate();
    await until(() => session.closed, 2_000, 'provider session closed');
    await until(() => h.log.events.some((e) => e.event === 'session_disposed' && e.fields?.reason === 'socket_closed'));
  });

  it('a message larger than maxPayload closes the socket (1009) and disposes the session', async () => {
    const { client, session } = await start();
    client.sendRaw('x'.repeat(LIMITS.maxWsMessageBytes + 1_000));
    const { code } = await client.closed;
    expect(code).toBe(1009);
    await until(() => session.closed, 2_000, 'provider session closed');
  });

  it('never sends the API key to the client', async () => {
    const { client, session } = await start();
    session.emit(fixtureMsg.audio(pcm24k));
    await client.waitFor('audio');
    expect(client.raw.join('\n')).not.toContain(FIXTURE_API_KEY);
  });
});

describe('provider failures, missing credentials and fallback (real server, FIXTURE providers)', () => {
  it('Live connect failure -> typed error with fallback snapshot -> ready(snapshot) -> snapshot answer from FIXTURE vision', async () => {
    const h = await startHarness();
    try {
      h.live.queue({ reject: Object.assign(new Error('models/gemini-3.8-live is not found for API version v1beta'), { status: 404 }) });
      const client = await connectOk(h.port);
      client.send(hello());
      const err = await client.waitFor('error');
      expect(err).toMatchObject({ code: 'model_unavailable', fallback: 'snapshot', recoverable: true });
      expect(err.message).toMatch(/snapshot mode/i);
      expect(err.message).not.toContain('v1beta'); // raw provider detail is not forwarded
      const ready = await client.waitFor('ready');
      expect(ready).toMatchObject({ mode: 'snapshot', features: { live: false, snapshot: true } });
      expect(client.ofType('status').map((s) => s.state)).toContain('snapshot');

      // Typed question with a fresh still photo is answered by the (FIXTURE) vision service.
      client.send({ type: 'text', requestId: 'text-1', text: 'What is this?', frame: fixtureFrame() });
      const answer = await client.waitFor('answer');
      expect(answer).toMatchObject({ requestId: 'text-1', text: FIXTURE_ANSWER, model: FIXTURE_VISION_MODEL });
      // Snapshot mode requires a fresh frame; no frame -> honest error, no answer.
      client.send({ type: 'text', requestId: 'text-2', text: 'And now?' });
      expect(await client.waitFor('error', (e) => e.requestId === 'text-2')).toMatchObject({ code: 'frame_missing' });
      // Media is not forwarded anywhere in snapshot mode.
      client.send({ type: 'audio', seq: 0, data: pcm16k });
      await sleep(100);
      expect(h.live.sessions[0]!.realtime).toHaveLength(0);
      client.close();
    } finally {
      await h.close();
    }
  });

  it('unauthorized connect failure without vision -> non-recoverable error, fallback none, status closed', async () => {
    const h = await startHarness({}, { noVision: true });
    try {
      h.live.queue({ reject: Object.assign(new Error('API key not valid'), { status: 403 }) });
      const client = await connectOk(h.port);
      client.send(hello());
      const err = await client.waitFor('error');
      expect(err).toMatchObject({ code: 'unauthorized', fallback: 'none', recoverable: false });
      await client.waitFor('status', (s) => s.state === 'closed');
      expect(client.ofType('ready')).toHaveLength(0);
      client.close();
    } finally {
      await h.close();
    }
  });

  it('missing credentials (no connector, no vision): health configured=false, ready(snapshot, nothing available) + honest error, no answers', async () => {
    const h = await startHarness({ GEMINI_API_KEY: '' }, { noLive: true, noVision: true });
    try {
      const health = JSON.parse((await httpGet(h.port, '/api/health', { Host: `127.0.0.1:${h.port}` })).body);
      expect(health.configured).toBe(false);
      const client = await connectOk(h.port);
      client.send(hello());
      const ready = await client.waitFor('ready');
      expect(ready).toMatchObject({ mode: 'snapshot', features: { live: false, snapshot: false }, models: { live: null, vision: null } });
      const err = await client.waitFor('error');
      expect(err).toEqual({ type: 'error', code: 'missing_credentials', message: MISSING_CREDENTIALS_MESSAGE, recoverable: false });
      client.send({ type: 'text', requestId: 'text-1', text: 'What is this?', frame: fixtureFrame() });
      client.send({ type: 'action', requestId: 'read_label-1', action: 'read_label', frame: fixtureFrame() });
      await until(() => client.ofType('error').length >= 3);
      expect(client.ofType('answer')).toHaveLength(0);
      expect(client.ofType('evidence')).toHaveLength(0);
      expect(client.ofType('error').slice(1).every((e) => e.code === 'missing_credentials')).toBe(true);
      client.close();
    } finally {
      await h.close();
    }
  });
});

describe('concurrency limit', () => {
  it('MAX_CONCURRENT_SESSIONS=1: second socket gets 503; a slot frees after close', async () => {
    const h = await startHarness({ MAX_CONCURRENT_SESSIONS: '1' });
    try {
      const first = await connectOk(h.port);
      expect(await connectWs(h.port)).toEqual({ ok: false, status: 503 });
      expect(h.log.events.some((e) => e.event === 'ws_rejected' && e.fields?.reason === 'too_many_sessions')).toBe(true);
      first.close();
      await first.closed;
      await sleep(50);
      const again = await connectWs(h.port);
      expect(again.ok).toBe(true);
      if (again.ok) again.client.close();
    } finally {
      await h.close();
    }
  });
});
