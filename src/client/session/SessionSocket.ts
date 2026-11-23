/**
 * Typed same-origin WebSocket wrapper. Inbound messages are validated with parseServerMessage;
 * invalid ones are dropped and counted (with a console warning that never includes the payload).
 */
import { parseServerMessage, WS_PATH, type ClientMessage, type ServerMessage } from '../../shared/protocol.js';
import type { Unsubscribe } from '../contracts.js';

export interface SocketCloseInfo {
  code: number;
  reason: string;
  wasClean: boolean;
}

/** What the AssistantController needs from a socket (tests provide fakes). */
export interface SessionSocketLike {
  /** Returns false if the socket is not open (message dropped). */
  send(msg: ClientMessage): boolean;
  readonly bufferedAmount: number;
  readonly isOpen: boolean;
  close(code?: number, reason?: string): void;
  onOpen(cb: () => void): Unsubscribe;
  onClose(cb: (info: SocketCloseInfo) => void): Unsubscribe;
  onMessage(cb: (msg: ServerMessage) => void): Unsubscribe;
}

export interface SessionSocket extends SessionSocketLike {
  readonly invalidCount: number;
}

/** Minimal WebSocket surface used here (lets tests inject a fake). */
export interface WebSocketLike {
  readonly readyState: number;
  readonly bufferedAmount: number;
  onopen: ((ev: Event) => unknown) | null;
  onclose: ((ev: CloseEvent) => unknown) | null;
  onerror: ((ev: Event) => unknown) | null;
  onmessage: ((ev: MessageEvent) => unknown) | null;
  send(data: string): void;
  close(code?: number, reason?: string): void;
}

const OPEN = 1;

/** ws: for http:, wss: for https:, same host and port, path WS_PATH. */
export function buildSocketUrl(loc: Pick<Location, 'protocol' | 'host'> = window.location): string {
  const scheme = loc.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${scheme}//${loc.host}${WS_PATH}`;
}

export interface SessionSocketOptions {
  url?: string;
  createWebSocket?: (url: string) => WebSocketLike;
  warn?: (msg: string) => void;
}

export function createSessionSocket(opts: SessionSocketOptions = {}): SessionSocket {
  const url = opts.url ?? buildSocketUrl();
  const ws = (opts.createWebSocket ?? ((u: string) => new WebSocket(u) as WebSocketLike))(url);
  const warn = opts.warn ?? ((m: string) => console.warn(m));
  const openListeners = new Set<() => void>();
  const closeListeners = new Set<(info: SocketCloseInfo) => void>();
  const messageListeners = new Set<(msg: ServerMessage) => void>();
  let invalidCount = 0;
  let closed = false;

  ws.onopen = () => {
    for (const l of [...openListeners]) l();
  };
  ws.onmessage = (ev: MessageEvent) => {
    if (typeof ev.data !== 'string') {
      invalidCount++;
      warn('[sightline] dropped non-text server message');
      return;
    }
    const parsed = parseServerMessage(ev.data);
    if (!parsed.ok) {
      invalidCount++;
      warn(`[sightline] dropped invalid server message (${invalidCount}): ${parsed.error.slice(0, 80)}`);
      return;
    }
    for (const l of [...messageListeners]) l(parsed.value);
  };
  ws.onerror = () => {
    /* a close event follows */
  };
  ws.onclose = (ev: CloseEvent) => {
    if (closed) return;
    closed = true;
    const info = { code: ev?.code ?? 1006, reason: ev?.reason ?? '', wasClean: ev?.wasClean ?? false };
    for (const l of [...closeListeners]) l(info);
  };

  return {
    send(msg: ClientMessage) {
      if (ws.readyState !== OPEN) return false;
      try {
        ws.send(JSON.stringify(msg));
        return true;
      } catch {
        return false;
      }
    },
    get bufferedAmount() {
      return ws.bufferedAmount;
    },
    get isOpen() {
      return ws.readyState === OPEN;
    },
    get invalidCount() {
      return invalidCount;
    },
    close(code = 1000, reason = '') {
      try {
        ws.close(code, reason);
      } catch {
        /* ignore */
      }
    },
    onOpen(cb) {
      openListeners.add(cb);
      return () => openListeners.delete(cb);
    },
    onClose(cb) {
      closeListeners.add(cb);
      return () => closeListeners.delete(cb);
    },
    onMessage(cb) {
      messageListeners.add(cb);
      return () => messageListeners.delete(cb);
    },
  };
}
