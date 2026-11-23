/**
 * Sightline server assembly. OWNER: lead.
 * One HTTP server serves the UI (Vite middleware in dev, static build in production), GET /api/health,
 * and the WebSocket endpoint /ws on the same origin and port.
 */
import dotenv from 'dotenv';
import { createServer, type IncomingMessage } from 'node:http';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { WebSocketServer, type WebSocket } from 'ws';
import { GoogleGenAI } from '@google/genai';
import { LIMITS, WS_PATH, type HealthResponse, type ServerMessage } from '../shared/protocol.js';
import { loadConfig, type AppConfig } from './config.js';
import { createLogger } from './log.js';
import type { ClientChannel, LiveConnector } from './contracts.js';
import { ACCESS_COOKIE, accessCookieValue, checkAccess, checkOrigin, isSecureRequest, safeEqual } from './http/security.js';
import { createClientSession } from './session/ClientSession.js';
import { createGeminiVision } from './vision/GeminiVision.js';
import { createDetector } from './vision/detector.js';

dotenv.config({ quiet: true });

const here = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = [path.resolve(here, '../..'), path.resolve(here, '../../..')].find((p) =>
  existsSync(path.join(p, 'package.json')),
)!;
const pkgVersion = (JSON.parse(readFileSync(path.join(projectRoot, 'package.json'), 'utf8')) as { version: string }).version;

/** Max bytes buffered on a client socket before we start dropping outbound audio (backpressure). */
const MAX_BUFFERED_BYTES = 4 * 1024 * 1024;

export function createChannel(ws: WebSocket): ClientChannel {
  return {
    send(msg: ServerMessage) {
      if (ws.readyState !== ws.OPEN) return;
      if (msg.type === 'audio' && ws.bufferedAmount > MAX_BUFFERED_BYTES) return;
      try {
        ws.send(JSON.stringify(msg));
      } catch {
        /* socket closing */
      }
    },
    close(code = 1000, reason = '') {
      try {
        ws.close(code, reason.slice(0, 120));
      } catch {
        /* ignore */
      }
    },
    get isOpen() {
      return ws.readyState === ws.OPEN;
    },
    get bufferedAmount() {
      return ws.bufferedAmount;
    },
  };
}

export async function startServer(config: AppConfig = loadConfig()) {
  const log = createLogger();
  const ai = config.geminiApiKey ? new GoogleGenAI({ apiKey: config.geminiApiKey, httpOptions: { apiVersion: 'v1beta' } }) : null;
  const liveConnector: LiveConnector | null = ai ? (params) => ai.live.connect(params) : null;
  const vision = ai ? createGeminiVision({ ai, config, log }) : null;
  const detector = createDetector({ config, log });
  const clock = () => (config.fakeNow ? new Date(config.fakeNow) : new Date());

  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', false);
  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Permissions-Policy', 'camera=(self), microphone=(self), geolocation=()');
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    if (config.production) {
      res.setHeader(
        'Content-Security-Policy',
        "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' blob:; connect-src 'self' ws: wss:; worker-src 'self' blob:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
      );
    }
    next();
  });

  // Access gate: token exchange, then every request (HTTP and WS) is checked.
  app.use((req, res, next) => {
    const token = typeof req.query.access === 'string' ? req.query.access : null;
    if (token !== null && config.accessToken && safeEqual(token, config.accessToken)) {
      res.cookie(ACCESS_COOKIE, accessCookieValue(config.accessToken), {
        httpOnly: true,
        sameSite: 'strict',
        secure: isSecureRequest(req),
        maxAge: 12 * 60 * 60 * 1000,
        path: '/',
      });
      res.redirect(302, req.path);
      return;
    }
    const decision = checkAccess(req, config);
    if (!decision.allowed) {
      res.status(decision.status).type('text/plain').send(decision.reason);
      return;
    }
    next();
  });

  app.get('/api/health', async (_req, res) => {
    const body: HealthResponse = {
      ok: true,
      version: pkgVersion,
      configured: config.geminiApiKey !== null,
      models: { live: config.liveModel, vision: config.visionModel },
      detector: await detector.health(),
      accessGate: config.accessToken !== null,
      timeZone: config.timeZone,
    };
    res.setHeader('Cache-Control', 'no-store');
    res.json(body);
  });
  app.use('/api', (_req, res) => {
    res.status(404).json({ error: 'not_found' });
  });

  const httpServer = createServer(app);

  if (!config.production) {
    const { createServer: createVite } = await import('vite');
    const vite = await createVite({
      root: projectRoot,
      configFile: path.join(projectRoot, 'vite.config.ts'),
      server: { middlewareMode: true, hmr: { server: httpServer } },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const clientDir = path.join(projectRoot, 'dist/client');
    if (!existsSync(path.join(clientDir, 'index.html'))) {
      throw new Error('dist/client not found. Run `npm run build` first.');
    }
    app.use(express.static(clientDir, { index: false, maxAge: '1h' }));
    app.get(/.*/, (_req, res) => res.sendFile(path.join(clientDir, 'index.html')));
  }

  // WebSocket endpoint. Vite HMR shares the http server but uses its own subprotocol; we only claim WS_PATH.
  const wss = new WebSocketServer({ noServer: true, maxPayload: LIMITS.maxWsMessageBytes, perMessageDeflate: false });
  let activeSessions = 0;

  const reject = (socket: import('node:stream').Duplex, status: number, text: string) => {
    socket.write(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
    socket.destroy();
  };

  httpServer.on('upgrade', (req: IncomingMessage, socket, head) => {
    const url = new URL(req.url ?? '/', 'http://placeholder');
    if (url.pathname !== WS_PATH) return; // not ours (e.g. Vite HMR)
    if (!checkOrigin(req, config)) {
      log.warn('ws_rejected', { reason: 'origin' });
      return reject(socket, 403, 'Forbidden');
    }
    const access = checkAccess(req, config);
    if (!access.allowed) {
      log.warn('ws_rejected', { reason: 'access' });
      return reject(socket, access.status, 'Unauthorized');
    }
    if (activeSessions >= config.maxConcurrentSessions) {
      log.warn('ws_rejected', { reason: 'too_many_sessions' });
      return reject(socket, 503, 'Busy');
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  });

  wss.on('connection', (ws: WebSocket) => {
    activeSessions++;
    const channel = createChannel(ws);
    const session = createClientSession({ channel, config, vision, detector, liveConnector, clock, log });
    let alive = true;
    ws.on('pong', () => (alive = true));
    const heartbeat = setInterval(() => {
      if (!alive) {
        ws.terminate();
        return;
      }
      alive = false;
      ws.ping();
    }, 20_000);
    ws.on('message', (data, isBinary) => {
      if (isBinary) {
        channel.send({ type: 'error', code: 'invalid_message', message: 'Binary frames are not accepted.', recoverable: true });
        return;
      }
      session.handleRaw(data.toString());
    });
    ws.on('close', () => {
      clearInterval(heartbeat);
      activeSessions--;
      session.dispose('socket_closed');
    });
    ws.on('error', () => {
      /* close follows */
    });
  });

  await new Promise<void>((resolve) => httpServer.listen(config.port, config.host, resolve));
  log.info('listening', {
    url: `http://${config.host === '0.0.0.0' ? 'localhost' : config.host}:${config.port}`,
    configured: config.geminiApiKey !== null,
    liveModel: config.liveModel,
    visionModel: config.visionModel,
    detector: detector.enabled,
    accessGate: config.accessToken !== null,
    mode: config.production ? 'production' : 'development',
  });
  if (!config.geminiApiKey) {
    log.warn('missing_credentials', { hint: 'Set GEMINI_API_KEY in .env (see .env.example). UI and tests still run.' });
  }

  const close = async () => {
    for (const client of wss.clients) client.close(1001, 'server_shutdown');
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
  };
  return { httpServer, close, config };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  startServer().then(
    ({ close }) => {
      const shutdown = () => {
        void close().finally(() => process.exit(0));
        setTimeout(() => process.exit(0), 3_000).unref();
      };
      process.on('SIGINT', shutdown);
      process.on('SIGTERM', shutdown);
    },
    (err: unknown) => {
      console.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    },
  );
}
