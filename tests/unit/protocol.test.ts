/**
 * Shared payload validation (src/shared/protocol.ts): every ClientMessage and ServerMessage variant has a valid
 * FIXTURE that is accepted, and representative invalid / oversize / data:-prefixed payloads that are rejected.
 */
import { describe, expect, it } from 'vitest';
import {
  ClientMessage,
  HealthResponse,
  LIMITS,
  PROTOCOL_VERSION,
  ServerMessage,
  parseClientMessage,
  parseServerMessage,
  type FramePayload,
  type LabelEvidence,
} from '../../src/shared/protocol.js';
import { IDLE_GUIDE } from '../../src/shared/guide.js';

const frame: FramePayload = { frameId: 3, capturedAt: 1_795_000_000_000, width: 640, height: 480, mimeType: 'image/jpeg', data: 'AAAA' };
const evidence: LabelEvidence = {
  frameId: 3,
  capturedAt: frame.capturedAt,
  readability: 'partial',
  exactText: [{ section: 'product_name', text: 'Soup' }],
  instructions: [{ method: 'Hob', steps: ['Heat'] }],
  dates: [
    {
      printedText: 'USE BY 24 NOV',
      labelType: 'use_by',
      interpretation: { status: 'incomplete', isoDate: null, comparison: 'unknown', note: 'Year not printed' },
    },
  ],
  batchCodes: ['L123'],
  itemGuess: null,
  issues: ['glare'],
  suggestion: 'Tilt the pack.',
  model: 'm',
  latencyMs: 5,
};

const validClient: Record<ClientMessage['type'], ClientMessage> = {
  hello: { type: 'hello', protocolVersion: PROTOCOL_VERSION, mode: 'live', settings: { pushToTalk: false, detections: true }, clientTime: 1_795_000_000_000, resume: true },
  audio: { type: 'audio', seq: 0, data: 'AAAA' },
  'audio.end': { type: 'audio.end' },
  frame: { type: 'frame', frame: { ...frame, quality: { meanLuma: 120, sharpness: 30 } } },
  'detect.frame': { type: 'detect.frame', frame },
  find: { type: 'find', requestId: 'find-1', query: 'salt' },
  'find.stop': { type: 'find.stop' },
  'find.select': { type: 'find.select', candidateId: 2 },
  'guide.inspect': { type: 'guide.inspect', requestId: 'guide-1', goal: 'cooking instructions', frame },
  'guide.action': { type: 'guide.action', requestId: 'guide-2', action: 'confirm', guideId: 'g1', revision: 1, stepId: 'microwave-s1' },
  text: { type: 'text', requestId: 'text-1', text: 'What is this?', frame },
  action: { type: 'action', requestId: 'read_label-1', action: 'read_label', frame },
  'snapshot.result': { type: 'snapshot.result', requestId: 'snap-1', frame },
  'snapshot.unavailable': { type: 'snapshot.unavailable', requestId: 'snap-1', reason: 'camera_denied' },
  'playback.stop': { type: 'playback.stop', turnId: 4 },
  visibility: { type: 'visibility', state: 'hidden' },
  settings: { type: 'settings', settings: { pushToTalk: true, detections: false } },
  bye: { type: 'bye' },
};

const validServer: Record<ServerMessage['type'], ServerMessage> = {
  ready: {
    type: 'ready',
    sessionId: 'abc',
    mode: 'live',
    models: { live: 'l', vision: null },
    features: { live: true, snapshot: false, detections: false },
    serverTime: 1,
    maxSessionMs: 1_200_000,
    timeZone: 'Europe/London',
  },
  status: { type: 'status', state: 'reconnecting', detail: 'connection lost' },
  guide: { type: 'guide', guide: IDLE_GUIDE, requestId: null, result: null },
  find: {
    type: 'find',
    requestId: 'find-1',
    query: 'salt',
    state: 'tracking',
    source: 'gemini',
    target: { label: 'salt', score: 0.8, box: { x: 0.1, y: 0.2, w: 0.2, h: 0.3 } },
    frameId: 9,
    description: 'left of the picture, small',
    at: 1,
  },
  audio: { type: 'audio', turnId: 1, seq: 0, data: 'AAAA' },
  transcript: { type: 'transcript', role: 'assistant', turnId: 1, text: 'Hi', final: false },
  turn: { type: 'turn', turnId: 1, event: 'interrupted', at: 1 },
  'snapshot.request': { type: 'snapshot.request', requestId: 'snap-1', purpose: 'read_label', maxDim: 1600 },
  tool: { type: 'tool', callId: 'c1', name: 'look_again', state: 'cancelled' },
  evidence: { type: 'evidence', requestId: null, evidence },
  answer: { type: 'answer', requestId: 'text-1', text: 'A mug.', frameId: 3, model: 'v', latencyMs: 10 },
  detections: {
    type: 'detections',
    frameId: 3,
    capturedAt: 1,
    sourceWidth: 640,
    sourceHeight: 480,
    detectedAt: 2,
    model: 'yolo',
    detections: [{ label: 'cup', score: 0.5, box: { x: 0, y: 0, w: 1, h: 1 } }],
  },
  error: { type: 'error', code: 'model_unavailable', message: 'x', recoverable: true, fallback: 'snapshot', requestId: 'r-1' },
  notice: { type: 'notice', code: 'go_away', message: 'Refreshing.' },
};

describe('ClientMessage schemas', () => {
  it('covers every variant of the discriminated union', () => {
    const variants = ClientMessage.options.map((o) => o.shape.type.value).sort();
    expect(Object.keys(validClient).sort()).toEqual(variants);
  });

  it.each(Object.entries(validClient))('accepts a valid %s (object and JSON string)', (_type, msg) => {
    expect(parseClientMessage(msg)).toEqual({ ok: true, value: msg });
    expect(parseClientMessage(JSON.stringify(msg)).ok).toBe(true);
  });

  const bad: Array<[string, unknown]> = [
    ['invalid JSON', '{"type":'],
    ['unknown type', { type: 'shell', cmd: 'ls' }],
    ['hello with wrong protocol version', { ...validClient.hello, protocolVersion: 2 }],
    ['hello without clientTime', { type: 'hello', protocolVersion: 1, mode: 'live', settings: { pushToTalk: false, detections: false } }],
    ['audio with data: prefix', { type: 'audio', seq: 0, data: 'data:audio/pcm;base64,AAAA' }],
    ['audio over the chunk limit', { type: 'audio', seq: 0, data: 'A'.repeat(LIMITS.maxAudioChunkBase64Chars + 4) }],
    ['audio with negative seq', { type: 'audio', seq: -1, data: 'AAAA' }],
    ['audio with empty data', { type: 'audio', seq: 0, data: '' }],
    ['frame with data: prefix', { type: 'frame', frame: { ...frame, data: 'data:image/jpeg;base64,AAAA' } }],
    ['frame over the size limit', { type: 'frame', frame: { ...frame, data: 'A'.repeat(LIMITS.maxFrameBase64Chars + 4) } }],
    ['frame with png mime', { type: 'frame', frame: { ...frame, mimeType: 'image/png' } }],
    ['frame with fractional capturedAt', { type: 'frame', frame: { ...frame, capturedAt: 1.5 } }],
    ['frame too wide', { type: 'frame', frame: { ...frame, width: 9000 } }],
    ['frame with impossible luma', { type: 'frame', frame: { ...frame, quality: { meanLuma: 300, sharpness: 1 } } }],
    ['text too long', { type: 'text', requestId: 't', text: 'a'.repeat(LIMITS.maxTextChars + 1) }],
    ['text whitespace only', { type: 'text', requestId: 't', text: '   ' }],
    ['requestId with spaces', { type: 'text', requestId: 'a b', text: 'hi' }],
    ['requestId too long', { type: 'text', requestId: 'a'.repeat(LIMITS.maxRequestIdChars + 1), text: 'hi' }],
    ['unknown action', { type: 'action', requestId: 'r', action: 'fetch_url' }],
    ['snapshot.result without frame', { type: 'snapshot.result', requestId: 'snap-1' }],
    ['snapshot.unavailable bad reason', { type: 'snapshot.unavailable', requestId: 'snap-1', reason: 'because' }],
    ['playback.stop fractional turn', { type: 'playback.stop', turnId: 1.5 }],
    ['visibility bad state', { type: 'visibility', state: 'gone' }],
    ['settings missing field', { type: 'settings', settings: { pushToTalk: true } }],
    ['non-object', 42],
  ];
  it.each(bad)('rejects %s', (_name, raw) => {
    const r = parseClientMessage(raw);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.length).toBeGreaterThan(0);
  });

  it('accepts a frame exactly at the size limit', () => {
    const data = 'A'.repeat(LIMITS.maxFrameBase64Chars);
    expect(parseClientMessage({ type: 'frame', frame: { ...frame, data } }).ok).toBe(true);
  });

  it('a max-size frame message fits within the WebSocket payload cap', () => {
    const msg = JSON.stringify({ type: 'snapshot.result', requestId: 'r'.repeat(64), frame: { ...frame, data: 'A'.repeat(LIMITS.maxFrameBase64Chars) } });
    expect(Buffer.byteLength(msg)).toBeLessThan(LIMITS.maxWsMessageBytes);
  });
});

describe('ServerMessage schemas', () => {
  it('covers every variant of the discriminated union', () => {
    const variants = ServerMessage.options.map((o) => o.shape.type.value).sort();
    expect(Object.keys(validServer).sort()).toEqual(variants);
  });

  it.each(Object.entries(validServer))('accepts a valid %s', (_type, msg) => {
    expect(parseServerMessage(JSON.stringify(msg))).toEqual({ ok: true, value: msg });
  });

  const bad: Array<[string, unknown]> = [
    ['unknown type', { type: 'eval', code: '1' }],
    ['ready with unknown mode', { ...validServer.ready, mode: 'video' }],
    ['status with unknown state', { type: 'status', state: 'thinking' }],
    ['transcript text over 4000 chars', { type: 'transcript', role: 'assistant', turnId: 1, text: 'a'.repeat(4_001), final: false }],
    ['turn with unknown event', { type: 'turn', turnId: 1, event: 'paused', at: 1 }],
    ['snapshot.request maxDim too large', { type: 'snapshot.request', requestId: 's', purpose: 'read_label', maxDim: 5_000 }],
    ['tool with unknown name', { type: 'tool', callId: 'c', name: 'run_shell', state: 'started' }],
    ['evidence with too many batch codes', { type: 'evidence', requestId: null, evidence: { ...evidence, batchCodes: Array(7).fill('L1') } }],
    ['evidence with bad iso date', {
      type: 'evidence',
      requestId: null,
      evidence: { ...evidence, dates: [{ ...evidence.dates[0]!, interpretation: { ...evidence.dates[0]!.interpretation, isoDate: '24/11/2026' } }] },
    }],
    ['answer with negative latency', { ...validServer.answer, latencyMs: -1 }],
    ['detections with box out of range', { ...validServer.detections, detections: [{ label: 'cup', score: 0.5, box: { x: 0, y: 0, w: 2, h: 1 } }] }],
    ['detections over the cap', {
      ...validServer.detections,
      detections: Array(LIMITS.maxDetections + 1).fill({ label: 'cup', score: 0.5, box: { x: 0, y: 0, w: 1, h: 1 } }),
    }],
    ['error with unknown code', { type: 'error', code: 'oops', message: 'x', recoverable: true }],
    ['error message over 500 chars', { type: 'error', code: 'internal', message: 'x'.repeat(501), recoverable: true }],
    ['notice with unknown code', { type: 'notice', code: 'ad', message: 'x' }],
  ];
  it.each(bad)('rejects %s', (_name, raw) => {
    expect(parseServerMessage(raw).ok).toBe(false);
  });
});

describe('HealthResponse', () => {
  it('has no field that could carry a secret', () => {
    expect(Object.keys(HealthResponse.shape).sort()).toEqual(['accessGate', 'configured', 'detector', 'models', 'ok', 'timeZone', 'version']);
  });
});
