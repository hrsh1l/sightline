/**
 * FIXTURE Gemini Live connector. NOT a real provider and NOT evidence of live-model behaviour.
 *
 * Implements the server's LiveConnector contract (src/server/contracts.ts) with a scripted fake session that
 * records every sendRealtimeInput / sendClientContent / sendToolResponse / close call and can emit
 * LiveServerMessage-shaped objects (setupComplete, audio parts, transcriptions, interrupted, turnComplete,
 * toolCall, toolCallCancellation, goAway, sessionResumptionUpdate) and provider socket closes.
 *
 * Used by tests/integration (vitest, real server) and tests/e2e/fixture-server.ts (Playwright).
 */
import type { LiveConnectParameters, LiveServerMessage } from '@google/genai';
import type { LiveConnector, LiveSessionLike } from '../../src/server/contracts.js';

/** Provider message shape without the SDK class's convenience getters. */
export type FixtureLiveMessage = Omit<LiveServerMessage, 'text' | 'data'>;

type RealtimeParams = Parameters<LiveSessionLike['sendRealtimeInput']>[0];
type ClientContentParams = Parameters<LiveSessionLike['sendClientContent']>[0];
type ToolResponseParams = Parameters<LiveSessionLike['sendToolResponse']>[0];

export interface Recorded<T> {
  at: number;
  params: T;
}

export interface FixtureLiveSession {
  /** 0-based index of this provider connection (one per connector call). */
  readonly index: number;
  readonly params: LiveConnectParameters;
  readonly openedAt: number;
  realtime: Recorded<RealtimeParams>[];
  clientContent: Recorded<ClientContentParams>[];
  toolResponses: Recorded<ToolResponseParams>[];
  closed: boolean;
  closedAt: number | null;
  /** Any send attempted after close() (must stay 0). */
  sendsAfterClose: number;
  /** Deliver a provider message to the server (FIXTURE). Ignored after close. */
  emit(msg: FixtureLiveMessage): void;
  /** Simulate the provider closing the socket (FIXTURE). */
  serverClose(code?: number, reason?: string): void;
  readonly frames: Recorded<RealtimeParams>[];
  readonly audio: Recorded<RealtimeParams>[];
  readonly texts: Recorded<RealtimeParams>[];
}

export type FixtureConnectBehaviour = 'ok' | { reject: unknown } | 'hang';

export interface FixtureLive {
  connector: LiveConnector;
  sessions: FixtureLiveSession[];
  readonly last: FixtureLiveSession | undefined;
  /** Queue behaviours for the next connector calls (default 'ok'). */
  queue(...b: FixtureConnectBehaviour[]): void;
  setDefault(b: FixtureConnectBehaviour): void;
  /** Resolves with the next session to be opened (or the n-th, 0-based). */
  waitForSession(index?: number, timeoutMs?: number): Promise<FixtureLiveSession>;
  /** Called whenever a session records any realtime input (lets scripts react, e.g. auto-reply). */
  onRealtime?: (s: FixtureLiveSession, p: RealtimeParams) => void;
}

export function createFixtureLive(): FixtureLive {
  const sessions: FixtureLiveSession[] = [];
  const behaviours: FixtureConnectBehaviour[] = [];
  let defaultBehaviour: FixtureConnectBehaviour = 'ok';
  const waiters: { index: number; resolve: (s: FixtureLiveSession) => void }[] = [];

  const fixture: FixtureLive = {
    connector: (params: LiveConnectParameters) => {
      const index = sessions.length;
      const s: FixtureLiveSession = {
        index,
        params,
        openedAt: Date.now(),
        realtime: [],
        clientContent: [],
        toolResponses: [],
        closed: false,
        closedAt: null,
        sendsAfterClose: 0,
        emit: (msg) => {
          if (s.closed) return;
          params.callbacks.onmessage(msg as LiveServerMessage);
        },
        serverClose: (code = 1006, reason = '') => {
          if (s.closed) return;
          s.closed = true;
          s.closedAt = Date.now();
          params.callbacks.onclose?.({ code, reason } as CloseEvent);
        },
        get frames() {
          return s.realtime.filter((r) => r.params.video !== undefined);
        },
        get audio() {
          return s.realtime.filter((r) => r.params.audio !== undefined);
        },
        get texts() {
          return s.realtime.filter((r) => r.params.text !== undefined);
        },
      };
      const record = <T>(list: Recorded<T>[], p: T) => {
        if (s.closed) {
          s.sendsAfterClose++;
          throw new Error('FIXTURE: send on closed session');
        }
        list.push({ at: Date.now(), params: p });
      };
      const session: LiveSessionLike = {
        sendRealtimeInput: (p) => {
          record(s.realtime, p);
          fixture.onRealtime?.(s, p);
        },
        sendClientContent: (p) => record(s.clientContent, p),
        sendToolResponse: (p) => record(s.toolResponses, p),
        close: () => {
          if (s.closed) return;
          s.closed = true;
          s.closedAt = Date.now();
        },
      };
      sessions.push(s);
      const b = behaviours.shift() ?? defaultBehaviour;
      if (b === 'hang') return new Promise<LiveSessionLike>(() => undefined);
      if (b !== 'ok') return Promise.reject(b.reject);
      for (const w of [...waiters]) {
        if (w.index === index) {
          waiters.splice(waiters.indexOf(w), 1);
          // Resolve after the connector promise settles so the bridge is live first.
          setTimeout(() => w.resolve(s), 0);
        }
      }
      return Promise.resolve(session).then((x) => {
        // Real Live sends setupComplete first; mirror that.
        setTimeout(() => s.emit({ setupComplete: {} }), 0);
        return x;
      });
    },
    sessions,
    get last() {
      return sessions[sessions.length - 1];
    },
    queue: (...b) => {
      behaviours.push(...b);
    },
    setDefault: (b) => {
      defaultBehaviour = b;
    },
    waitForSession(index = sessions.length, timeoutMs = 5_000) {
      const existing = sessions[index];
      if (existing) return Promise.resolve(existing);
      return new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error(`FIXTURE: no live session #${index} within ${timeoutMs} ms`)), timeoutMs);
        waiters.push({
          index,
          resolve: (s) => {
            clearTimeout(t);
            resolve(s);
          },
        });
      });
    },
  };
  return fixture;
}

// ---------------------------------------------------------------------------
// Scripted provider messages (FIXTURE)
// ---------------------------------------------------------------------------

export const fixtureMsg = {
  audio: (base64Pcm16: string): FixtureLiveMessage => ({
    serverContent: { modelTurn: { parts: [{ inlineData: { data: base64Pcm16, mimeType: 'audio/pcm;rate=24000' } }] } },
  }),
  outputTranscription: (text: string): FixtureLiveMessage => ({ serverContent: { outputTranscription: { text } } }),
  inputTranscription: (text: string): FixtureLiveMessage => ({ serverContent: { inputTranscription: { text } } }),
  interrupted: (): FixtureLiveMessage => ({ serverContent: { interrupted: true } }),
  generationComplete: (): FixtureLiveMessage => ({ serverContent: { generationComplete: true } }),
  turnComplete: (): FixtureLiveMessage => ({ serverContent: { turnComplete: true } }),
  toolCall: (id: string, name: string, args: Record<string, unknown> = {}): FixtureLiveMessage => ({
    toolCall: { functionCalls: [{ id, name, args }] },
  }),
  toolCallCancellation: (...ids: string[]): FixtureLiveMessage => ({ toolCallCancellation: { ids } }),
  goAway: (timeLeft = '0s'): FixtureLiveMessage => ({ goAway: { timeLeft } }),
  resumption: (newHandle: string): FixtureLiveMessage => ({ sessionResumptionUpdate: { resumable: true, newHandle } }),
};

/** PCM16 LE mono sine tone, base64 (FIXTURE audio). */
export function toneBase64(ms: number, sampleRate = 24_000, freq = 440, amplitude = 0.2): string {
  const n = Math.round((sampleRate * ms) / 1000);
  const buf = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) {
    const v = Math.round(Math.sin((2 * Math.PI * freq * i) / sampleRate) * amplitude * 32767);
    buf.writeInt16LE(v, i * 2);
  }
  return buf.toString('base64');
}
