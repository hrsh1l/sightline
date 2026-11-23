/**
 * Integration harness: starts the REAL Sightline HTTP/WS server (src/server/index.ts startServer) with FIXTURE
 * providers injected through the test-only overrides, and talks to it with a real `ws` client.
 * Nothing here reaches Google: the live connector and vision service are FIXTURES.
 */
import { createServer as createNetServer } from 'node:net';
import { request as httpRequest, type IncomingHttpHeaders } from 'node:http';
import WebSocket from 'ws';
import { startServer, type ServerOverrides } from '../../src/server/index.js';
import { loadConfig } from '../../src/server/config.js';
import { createMemoryLogger } from '../../src/server/log.js';
import { PROTOCOL_VERSION, type ClientMessage, type ServerMessage } from '../../src/shared/protocol.js';
import { createFixtureLive, type FixtureLive } from '../fixtures/fixtureLive.js';
import { createFixtureVision, disabledDetector, type FixtureVision } from '../fixtures/fixtureVision.js';

/** A recognisable fake key: it must never appear in any HTTP/WS response. */
export const FIXTURE_API_KEY = 'AIzaFIXTURE-not-a-real-key-0000000000000';

export async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createNetServer();
    s.unref();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const addr = s.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      s.close(() => resolve(port));
    });
  });
}

export interface Harness {
  port: number;
  origin: string;
  live: FixtureLive;
  vision: FixtureVision;
  log: ReturnType<typeof createMemoryLogger>;
  close(): Promise<void>;
}

export async function startHarness(
  env: Record<string, string> = {},
  overrides: Partial<ServerOverrides> & { noLive?: boolean; noVision?: boolean } = {},
): Promise<Harness> {
  const port = await freePort();
  const live = createFixtureLive();
  const vision = createFixtureVision();
  const log = createMemoryLogger();
  // Development mode (no static build needed): the Vite middleware is mounted but the WS/HTTP paths under test
  // are the same code as production.
  const config = loadConfig({ NODE_ENV: 'test', GEMINI_API_KEY: FIXTURE_API_KEY, PORT: String(port), HOST: '127.0.0.1', ...env });
  const { noLive, noVision, ...rest } = overrides;
  const server = await startServer(config, {
    liveConnector: noLive ? null : live.connector,
    vision: noVision ? null : vision,
    detector: disabledDetector,
    log,
    ...rest,
  });
  return { port, origin: `http://127.0.0.1:${port}`, live, vision, log, close: server.close };
}

export interface HttpResult {
  status: number;
  headers: IncomingHttpHeaders;
  body: string;
}

/** Plain node:http GET so the Host header can be set (fetch forbids it). */
export function httpGet(port: number, path: string, headers: Record<string, string> = {}): Promise<HttpResult> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: '127.0.0.1', port, path, method: 'GET', headers }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c: string) => (body += c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

export interface TestClient {
  ws: WebSocket;
  received: ServerMessage[];
  /** Raw text of every message received (for secret scans). */
  raw: string[];
  send(msg: ClientMessage | Record<string, unknown>): void;
  sendRaw(data: string): void;
  waitFor<T extends ServerMessage['type']>(
    type: T,
    pred?: (m: Extract<ServerMessage, { type: T }>) => boolean,
    timeoutMs?: number,
  ): Promise<Extract<ServerMessage, { type: T }>>;
  ofType<T extends ServerMessage['type']>(type: T): Extract<ServerMessage, { type: T }>[];
  closed: Promise<{ code: number; reason: string }>;
  close(): void;
}

export type ConnectOutcome = { ok: true; client: TestClient } | { ok: false; status: number };

export function connectWs(
  port: number,
  opts: { origin?: string | null; headers?: Record<string, string> } = {},
): Promise<ConnectOutcome> {
  const headers: Record<string, string> = { ...(opts.headers ?? {}) };
  const origin = opts.origin === undefined ? `http://127.0.0.1:${port}` : opts.origin;
  if (origin) headers.Origin = origin;
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers });
  const received: ServerMessage[] = [];
  const raw: string[] = [];
  const listeners = new Set<() => void>();
  ws.on('message', (data) => {
    const text = data.toString();
    raw.push(text);
    received.push(JSON.parse(text) as ServerMessage);
    for (const l of [...listeners]) l();
  });
  const closed = new Promise<{ code: number; reason: string }>((resolve) => {
    ws.on('close', (code, reason) => resolve({ code, reason: reason.toString() }));
  });
  const client: TestClient = {
    ws,
    received,
    raw,
    send: (msg) => ws.send(JSON.stringify(msg)),
    sendRaw: (data) => ws.send(data),
    ofType: (type) => received.filter((m) => m.type === type) as never,
    waitFor(type, pred, timeoutMs = 4_000) {
      return new Promise((resolve, reject) => {
        const check = () => {
          const m = received.find((x) => x.type === type && (!pred || pred(x as never)));
          if (m) {
            listeners.delete(check);
            clearTimeout(timer);
            resolve(m as never);
            return true;
          }
          return false;
        };
        const timer = setTimeout(() => {
          listeners.delete(check);
          reject(new Error(`timed out waiting for ${type}; got ${received.map((r) => r.type).join(',')}`));
        }, timeoutMs);
        if (!check()) listeners.add(check);
      });
    },
    closed,
    close: () => ws.close(),
  };
  return new Promise((resolve, reject) => {
    ws.once('open', () => resolve({ ok: true, client }));
    ws.once('unexpected-response', (_req, res) => {
      resolve({ ok: false, status: res.statusCode ?? 0 });
      ws.terminate();
    });
    ws.once('error', (err) => {
      // 'unexpected-response' resolves first for HTTP refusals; anything else is a test failure.
      if (ws.readyState !== WebSocket.CLOSED) reject(err);
    });
  });
}

export async function connectOk(port: number, opts?: Parameters<typeof connectWs>[1]): Promise<TestClient> {
  const r = await connectWs(port, opts);
  if (!r.ok) throw new Error(`ws refused with ${r.status}`);
  return r.client;
}

export const hello = (over: Partial<Extract<ClientMessage, { type: 'hello' }>> = {}): ClientMessage => ({
  type: 'hello',
  protocolVersion: PROTOCOL_VERSION,
  mode: 'live',
  settings: { pushToTalk: false, detections: false },
  clientTime: Date.now(),
  ...over,
});

/** Connect, say hello and wait until the server reports ready (live). */
export async function liveClient(h: Harness) {
  const client = await connectOk(h.port);
  client.send(hello());
  const ready = await client.waitFor('ready');
  const session = h.live.last!;
  return { client, ready, session };
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function until(cond: () => boolean, timeoutMs = 3_000, what = 'condition'): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${what}`);
    await sleep(10);
  }
}
