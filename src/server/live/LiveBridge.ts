/**
 * LiveBridge: owns one logical Gemini Live conversation for one browser client.
 *
 * - Connects through the injected LiveConnector (the API key stays inside the connector on the server).
 * - Tracks the latest resumable session handle (sessionResumptionUpdate) and reconnects with it after an
 *   unexpected close or a goAway, with bounded attempts and backoff.
 * - Every provider connection gets a generation number; callbacks from an old/failed connection are ignored,
 *   so a stale socket can never deliver output after a reconnect or after close().
 * - Sends are refused (return false) unless the bridge is live. Nothing is buffered while reconnecting,
 *   so old media is never replayed into a new provider session.
 */
import type { LiveConnectConfig, LiveServerMessage } from '@google/genai';
import type { LiveConnector, LiveSessionLike, Logger } from '../contracts.js';
import { classifyClose, classifyProviderError, isPermanent, type ProviderErrorInfo } from './errors.js';

export type BridgeState = 'idle' | 'connecting' | 'live' | 'reconnecting' | 'closed';
export type ReconnectReason = 'closed' | 'go_away';

export interface LiveBridgeHandlers {
  onMessage(msg: LiveServerMessage): void;
  /** Provider connection lost (or goAway reached); the bridge is reconnecting. No sends succeed until onReconnected. */
  onReconnecting(reason: ReconnectReason): void;
  onReconnected(info: { resumed: boolean; attempts: number }): void;
  /** Reconnect attempts exhausted (or a permanent error). The bridge is closed. */
  onLost(err: ProviderErrorInfo): void;
}

export interface LiveBridgeOptions {
  connector: LiveConnector;
  model: string;
  /** Build the connect config; `handle` is the resumption handle to use, or null for a fresh session. */
  buildConfig(handle: string | null): LiveConnectConfig;
  handlers: LiveBridgeHandlers;
  log: Logger;
  /** Delay before each reconnect attempt. Length = max attempts. */
  reconnectDelaysMs?: readonly number[];
  connectTimeoutMs?: number;
  /** Reconnect this long before a goAway deadline (unless the current turn completes first). */
  goAwayMarginMs?: number;
}

export interface LiveBridge {
  readonly state: BridgeState;
  /** A goAway was received and a reconnect is scheduled. */
  readonly goAwayPending: boolean;
  readonly hasResumptionHandle: boolean;
  /** Initial connect. Rejects with LiveConnectError. */
  connect(): Promise<void>;
  sendRealtimeInput(params: Parameters<LiveSessionLike['sendRealtimeInput']>[0]): boolean;
  sendClientContent(params: Parameters<LiveSessionLike['sendClientContent']>[0]): boolean;
  sendToolResponse(params: Parameters<LiveSessionLike['sendToolResponse']>[0]): boolean;
  /** If a goAway is pending, reconnect now (e.g. at a turn boundary). */
  reconnectIfGoAwayPending(): void;
  close(): void;
}

export class LiveConnectError extends Error {
  constructor(readonly info: ProviderErrorInfo) {
    super(info.message);
    this.name = 'LiveConnectError';
  }
}

class StaleConnectionError extends Error {}

export const DEFAULT_RECONNECT_DELAYS_MS = [300, 1_000, 2_500] as const;

/** Parse a protobuf Duration string like "50s" or "1.5s" to ms. */
export function parseDurationMs(value: string | undefined): number | null {
  if (!value) return null;
  const m = /^(\d+(?:\.\d+)?)s$/.exec(value.trim());
  return m ? Math.round(Number(m[1]) * 1000) : null;
}

export function createLiveBridge(o: LiveBridgeOptions): LiveBridge {
  const delays = o.reconnectDelaysMs ?? DEFAULT_RECONNECT_DELAYS_MS;
  const connectTimeoutMs = o.connectTimeoutMs ?? 15_000;
  const goAwayMarginMs = o.goAwayMarginMs ?? 3_000;
  const { log, handlers } = o;

  let state: BridgeState = 'idle';
  let gen = 0;
  let session: LiveSessionLike | null = null;
  let handle: string | null = null;
  let goAwayPending = false;
  let goAwayTimer: ReturnType<typeof setTimeout> | null = null;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  /** Read state through a function so TypeScript does not narrow it across awaits. */
  const currentState = (): BridgeState => state;

  const safeClose = (s: LiveSessionLike | null) => {
    if (!s) return;
    try {
      s.close();
    } catch {
      /* already closed */
    }
  };

  const safeHandler = (fn: () => void) => {
    try {
      fn();
    } catch (err) {
      log.error('live_handler_failed', { error: err instanceof Error ? err.name : 'unknown' });
    }
  };

  function onProviderMessage(msg: LiveServerMessage) {
    const upd = msg.sessionResumptionUpdate;
    if (upd?.resumable && upd.newHandle) handle = upd.newHandle;
    safeHandler(() => handlers.onMessage(msg));
    if (msg.goAway && state === 'live' && !goAwayPending) {
      goAwayPending = true;
      const left = parseDurationMs(msg.goAway.timeLeft);
      const wait = left === null ? 0 : Math.max(0, left - goAwayMarginMs);
      log.info('live_go_away', { timeLeftMs: left ?? -1, reconnectInMs: wait });
      goAwayTimer = setTimeout(() => {
        goAwayTimer = null;
        startReconnect('go_away');
      }, wait);
    }
  }

  async function open(useHandle: boolean): Promise<void> {
    const myGen = ++gen;
    const isCurrent = () => myGen === gen && state !== 'closed';
    const startedAt = Date.now();
    const pending = o.connector({
      model: o.model,
      config: o.buildConfig(useHandle ? handle : null),
      callbacks: {
        onmessage: (msg: LiveServerMessage) => {
          if (isCurrent()) onProviderMessage(msg);
        },
        onerror: () => {
          if (isCurrent()) log.warn('live_socket_error', { state });
        },
        onclose: (e: CloseEvent) => {
          // While connecting, the connector's rejection reports the failure; only a live socket closing is "unexpected".
          if (!isCurrent() || state !== 'live') return;
          const info = classifyClose(e?.code, e?.reason);
          log.warn('live_closed', { closeCode: e?.code ?? null, code: info.code });
          session = null;
          if (isPermanent(info.code)) {
            lose(info);
            return;
          }
          startReconnect('closed');
        },
      },
    });
    let timer: ReturnType<typeof setTimeout> | null = null;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('Live connection timed out')), connectTimeoutMs);
    });
    try {
      const s = await Promise.race([pending, timeout]);
      if (!isCurrent()) {
        safeClose(s);
        throw new StaleConnectionError('stale');
      }
      session = s;
      log.info('live_connected', { resumed: useHandle, latencyMs: Date.now() - startedAt });
    } catch (err) {
      if (myGen === gen) gen++; // invalidate callbacks from this failed attempt
      pending.then(safeClose, () => undefined); // close a session that resolves after a timeout
      throw err;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  function clearTimers() {
    if (goAwayTimer) clearTimeout(goAwayTimer);
    if (retryTimer) clearTimeout(retryTimer);
    goAwayTimer = null;
    retryTimer = null;
  }

  function lose(info: ProviderErrorInfo) {
    clearTimers();
    gen++;
    safeClose(session);
    session = null;
    state = 'closed';
    log.warn('live_lost', { code: info.code, status: info.status });
    safeHandler(() => handlers.onLost(info));
  }

  function startReconnect(reason: ReconnectReason) {
    if (state !== 'live') return;
    clearTimers();
    goAwayPending = false;
    gen++; // ignore anything further from the old connection
    const old = session;
    session = null;
    safeClose(old);
    state = 'reconnecting';
    log.info('live_reconnecting', { reason, hasHandle: handle !== null });
    safeHandler(() => handlers.onReconnecting(reason));
    void runReconnect();
  }

  const sleep = (ms: number) =>
    new Promise<void>((resolve) => {
      retryTimer = setTimeout(() => {
        retryTimer = null;
        resolve();
      }, ms);
    });

  async function runReconnect() {
    let last: ProviderErrorInfo = classifyProviderError(new Error('Live connection lost'));
    for (let i = 0; i < delays.length; i++) {
      await sleep(delays[i] ?? 1_000);
      if (state !== 'reconnecting') return;
      // Use the handle for all but the final attempt; the last attempt starts fresh in case the handle is rejected.
      const useHandle = handle !== null && (i < delays.length - 1 || delays.length === 1);
      try {
        await open(useHandle);
      } catch (err) {
        if (state !== 'reconnecting') return;
        last = classifyProviderError(err);
        log.warn('live_reconnect_failed', { attempt: i + 1, code: last.code, status: last.status });
        if (isPermanent(last.code)) break;
        continue;
      }
      if (state !== 'reconnecting') return;
      state = 'live';
      safeHandler(() => handlers.onReconnected({ resumed: useHandle, attempts: i + 1 }));
      return;
    }
    if (state === 'reconnecting') lose(last);
  }

  function send<K extends 'sendRealtimeInput' | 'sendClientContent' | 'sendToolResponse'>(
    method: K,
    params: Parameters<LiveSessionLike[K]>[0],
  ): boolean {
    if (state !== 'live' || !session) return false;
    try {
      (session[method] as (p: typeof params) => void)(params);
      return true;
    } catch (err) {
      log.warn('live_send_failed', { method, error: err instanceof Error ? err.name : 'unknown' });
      return false;
    }
  }

  return {
    get state() {
      return state;
    },
    get goAwayPending() {
      return goAwayPending;
    },
    get hasResumptionHandle() {
      return handle !== null;
    },
    async connect() {
      if (state !== 'idle') throw new LiveConnectError(classifyProviderError(new Error('Bridge already used')));
      state = 'connecting';
      try {
        await open(false);
      } catch (err) {
        const info = classifyProviderError(err);
        state = 'closed';
        throw new LiveConnectError(info);
      }
      if (currentState() !== 'connecting') throw new LiveConnectError(classifyProviderError(new Error('Bridge closed')));
      state = 'live';
    },
    sendRealtimeInput: (p) => send('sendRealtimeInput', p),
    sendClientContent: (p) => send('sendClientContent', p),
    sendToolResponse: (p) => send('sendToolResponse', p),
    reconnectIfGoAwayPending() {
      if (goAwayPending && state === 'live') startReconnect('go_away');
    },
    close() {
      if (state === 'closed') return;
      state = 'closed';
      clearTimers();
      gen++;
      safeClose(session);
      session = null;
    },
  };
}
