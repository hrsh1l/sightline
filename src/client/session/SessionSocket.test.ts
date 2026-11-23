import { describe, expect, it, vi } from 'vitest';
import { buildSocketUrl, createSessionSocket, type WebSocketLike } from './SessionSocket.js';

/** FIXTURE: fake WebSocket. */
function fakeWs() {
  const ws: WebSocketLike & { sent: string[] } = {
    readyState: 0,
    bufferedAmount: 0,
    onopen: null,
    onclose: null,
    onerror: null,
    onmessage: null,
    sent: [],
    send(d: string) {
      ws.sent.push(d);
    },
    close: vi.fn(),
  };
  return ws;
}

describe('SessionSocket', () => {
  it('builds a same-origin URL', () => {
    expect(buildSocketUrl({ protocol: 'http:', host: 'localhost:3000' })).toBe('ws://localhost:3000/ws');
    expect(buildSocketUrl({ protocol: 'https:', host: 'phone.example:3443' })).toBe('wss://phone.example:3443/ws');
  });

  it('validates inbound messages and drops invalid ones with a count', () => {
    const ws = fakeWs();
    const warn = vi.fn();
    const s = createSessionSocket({ url: 'ws://x/ws', createWebSocket: () => ws, warn });
    const got = vi.fn();
    s.onMessage(got);
    ws.onmessage?.({ data: JSON.stringify({ type: 'turn', turnId: 1, event: 'start', at: 1 }) } as MessageEvent);
    ws.onmessage?.({ data: JSON.stringify({ type: 'bogus' }) } as MessageEvent);
    ws.onmessage?.({ data: 'not json' } as MessageEvent);
    expect(got).toHaveBeenCalledTimes(1);
    expect(s.invalidCount).toBe(2);
    expect(warn).toHaveBeenCalledTimes(2);
  });

  it('only sends while open and reports close once', () => {
    const ws = fakeWs();
    const s = createSessionSocket({ url: 'ws://x/ws', createWebSocket: () => ws });
    expect(s.send({ type: 'bye' })).toBe(false);
    (ws as { readyState: number }).readyState = 1;
    const opened = vi.fn();
    s.onOpen(opened);
    ws.onopen?.({} as Event);
    expect(opened).toHaveBeenCalled();
    expect(s.send({ type: 'audio.end' })).toBe(true);
    expect(JSON.parse(ws.sent[0]!)).toEqual({ type: 'audio.end' });
    const closed = vi.fn();
    s.onClose(closed);
    ws.onclose?.({ code: 1006, reason: '', wasClean: false } as CloseEvent);
    ws.onclose?.({ code: 1006, reason: '', wasClean: false } as CloseEvent);
    expect(closed).toHaveBeenCalledTimes(1);
  });
});
