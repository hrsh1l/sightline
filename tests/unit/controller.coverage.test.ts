// @vitest-environment jsdom
/**
 * Verification-gap tests for the AssistantController (FIXTURE camera/mic/player/socket; no real media or server).
 * Complements src/client/session/AssistantController.test.ts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ServerDetections } from '../../src/shared/protocol.js';
import { LIMITS } from '../../src/shared/protocol.js';
import { deferred, frame, loud, readyMsg, resetFrameIds, setup, started } from '../helpers/clientFakes.js';
import type { CapturedFrame } from '../../src/client/contracts.js';

beforeEach(() => {
  resetFrameIds();
  vi.useFakeTimers({ now: new Date('2026-11-23T10:00:00Z') });
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
});
afterEach(() => {
  vi.useRealTimers();
});

const det = (frameId: number, capturedAt: number): ServerDetections => ({
  type: 'detections',
  frameId,
  capturedAt,
  sourceWidth: 640,
  sourceHeight: 480,
  detectedAt: capturedAt + 50,
  model: 'FIXTURE',
  detections: [{ label: 'cup', score: 0.9, box: { x: 0, y: 0, w: 0.5, h: 0.5 } }],
});

describe('(a) stale / out-of-order detection results', () => {
  it('drops a result that is already older than the TTL when it arrives', async () => {
    const h = await started();
    h.controller.updateSettings({ detections: true });
    h.socket.receive(det(5, Date.now() - LIMITS.detectionTtlMs - 1));
    expect(h.controller.getState().detections).toBeNull();
  });

  it('rejects a lower frameId, and the same frameId with an older-or-equal capture time', async () => {
    const h = await started();
    h.controller.updateSettings({ detections: true });
    const t = Date.now();
    h.socket.receive(det(5, t));
    h.socket.receive(det(4, t + 10));
    expect(h.controller.getState().detections?.frameId).toBe(5);
    h.socket.receive(det(5, t));
    expect(h.controller.getState().detections?.capturedAt).toBe(t);
    h.socket.receive(det(6, t + 20));
    expect(h.controller.getState().detections?.frameId).toBe(6);
  });

  it('expires relative to capture time, not arrival time', async () => {
    const h = await started();
    h.controller.updateSettings({ detections: true });
    h.socket.receive(det(1, Date.now() - 2_000)); // 500 ms of TTL left
    expect(h.controller.getState().detections).not.toBeNull();
    await vi.advanceTimersByTimeAsync(499);
    expect(h.controller.getState().detections).not.toBeNull();
    await vi.advanceTimersByTimeAsync(2);
    expect(h.controller.getState().detections).toBeNull();
  });

  it('ignores detections while the setting is off, and clears them when it is turned off', async () => {
    const h = await started();
    h.socket.receive(det(1, Date.now()));
    expect(h.controller.getState().detections).toBeNull();
    h.controller.updateSettings({ detections: true });
    h.socket.receive(det(2, Date.now()));
    expect(h.controller.getState().detections).not.toBeNull();
    h.controller.updateSettings({ detections: false });
    expect(h.controller.getState().detections).toBeNull();
  });

  it('frames are never queued: a frame sampled while reconnecting is dropped, not sent later', async () => {
    const h = await started();
    h.sampler.emit(frame());
    expect(h.socket.types().filter((t) => t === 'frame')).toHaveLength(1);
    h.socket.serverClose();
    h.sampler.emit(frame());
    await vi.advanceTimersByTimeAsync(100);
    h.socket.open();
    h.socket.receive(readyMsg());
    expect(h.socket.types().filter((t) => t === 'frame')).toHaveLength(0);
    expect(h.controller.getState().metrics.framesSent).toBe(1);
  });
});

describe('(b) camera / microphone denial and disconnected camera', () => {
  it('microphone denied: error with open_settings, the camera keeps working and frames still flow', async () => {
    const h = setup();
    h.mic.start.mockImplementationOnce(async () => {
      h.mic.set({ status: 'denied', message: 'Microphone permission was denied.' });
    });
    const p = h.controller.start();
    h.socket.open();
    h.socket.receive(readyMsg());
    await p;
    const st = h.controller.getState();
    expect(st.connection).toBe('live');
    expect(st.error).toMatchObject({ code: 'microphone', action: 'open_settings' });
    expect(st.error?.message).toMatch(/You can still type questions/);
    expect(st.camera.status).toBe('active');
    h.sampler.emit(frame());
    expect(h.socket.types()).toContain('frame');
  });

  it('camera and microphone both denied: one combined, honest message', async () => {
    const h = setup();
    h.camera.start.mockImplementationOnce(async () => h.camera.set({ status: 'denied', message: 'Camera permission denied.' }));
    h.mic.start.mockImplementationOnce(async () => h.mic.set({ status: 'denied', message: 'Microphone permission denied.' }));
    const p = h.controller.start();
    h.socket.open();
    h.socket.receive(readyMsg());
    await p;
    expect(h.controller.getState().error).toMatchObject({ code: 'microphone', action: 'open_settings' });
    expect(h.controller.getState().error?.message).toMatch(/Camera and microphone are unavailable/);
  });

  it('camera disconnected mid-session: state mirrored, snapshot.request -> camera_off, Read label -> camera error, voice continues', async () => {
    const h = await started();
    h.camera.set({ status: 'disconnected', message: 'The camera was disconnected.' });
    expect(h.controller.getState().camera.status).toBe('disconnected');
    h.socket.receive({ type: 'snapshot.request', requestId: 'snap-1', purpose: 'read_label', maxDim: 1600 });
    await vi.advanceTimersByTimeAsync(0);
    expect(h.socket.sent.at(-1)).toEqual({ type: 'snapshot.unavailable', requestId: 'snap-1', reason: 'camera_off' });

    h.camera.setCapture(async () => null); // a disconnected camera cannot capture
    await h.controller.readLabel();
    expect(h.controller.getState().error).toMatchObject({ code: 'camera', action: 'retry' });
    expect(h.controller.getState().busy).toBeNull();
    expect(h.socket.types()).not.toContain('action');

    h.mic.emit(loud);
    expect(h.socket.types()).toContain('audio');
  });

  it('camera denied: snapshot.request answered camera_denied (the model is told, not left guessing)', async () => {
    const h = setup();
    h.camera.start.mockImplementationOnce(async () => h.camera.set({ status: 'denied', message: 'Camera permission denied.' }));
    const p = h.controller.start();
    h.socket.open();
    h.socket.receive(readyMsg());
    await p;
    h.socket.receive({ type: 'snapshot.request', requestId: 'snap-2', purpose: 'look_again', maxDim: 1024 });
    await vi.advanceTimersByTimeAsync(0);
    expect(h.socket.sent.at(-1)).toEqual({ type: 'snapshot.unavailable', requestId: 'snap-2', reason: 'camera_denied' });
  });

  it('Try again (start() while live) after the user allows the camera clears the camera error', async () => {
    const h = setup();
    h.camera.start.mockImplementationOnce(async () => h.camera.set({ status: 'denied', message: 'Camera permission denied.' }));
    const p = h.controller.start();
    h.socket.open();
    h.socket.receive(readyMsg());
    await p;
    await h.controller.start();
    expect(h.controller.getState().camera.status).toBe('active');
    expect(h.controller.getState().error).toBeNull();
    expect(h.sockets).toHaveLength(1);
  });
});

describe('(c) interruption rejects cancelled-turn output', () => {
  it('late assistant transcript text of an interrupted turn is not appended', async () => {
    const h = await started();
    h.socket.receive({ type: 'turn', turnId: 1, event: 'start', at: 0 });
    h.socket.receive({ type: 'transcript', role: 'assistant', turnId: 1, text: 'The mug is', final: false });
    h.socket.receive({ type: 'turn', turnId: 1, event: 'interrupted', at: 0 });
    h.socket.receive({ type: 'transcript', role: 'assistant', turnId: 1, text: ' blue and', final: false });
    h.socket.receive({ type: 'audio', turnId: 1, seq: 3, data: 'AAAA' });
    const entry = h.controller.getState().transcript.find((e) => e.id === 'live-assistant-1');
    expect(entry).toMatchObject({ text: 'The mug is', final: true });
    expect(h.player.enqueue).not.toHaveBeenCalled();
    expect(h.player.flush).toHaveBeenLastCalledWith(1);
    // The next turn plays.
    h.socket.receive({ type: 'turn', turnId: 2, event: 'start', at: 0 });
    h.socket.receive({ type: 'audio', turnId: 2, seq: 0, data: 'BBBB' });
    expect(h.player.enqueued).toEqual([[2, 'BBBB']]);
  });

  it('turn ids keep rejecting old turns across a reconnect (server restarts numbering at 1)', async () => {
    const h = await started();
    h.socket.receive({ type: 'turn', turnId: 1, event: 'start', at: 0 });
    h.socket.receive({ type: 'audio', turnId: 1, seq: 0, data: 'AAAA' });
    h.controller.stopSpeaking();
    h.socket.serverClose();
    await vi.advanceTimersByTimeAsync(100);
    h.socket.open();
    h.socket.receive(readyMsg());
    // New socket: server turn 1 is a NEW turn (local 2) and must play.
    h.socket.receive({ type: 'turn', turnId: 1, event: 'start', at: 0 });
    h.socket.receive({ type: 'audio', turnId: 1, seq: 0, data: 'CCCC' });
    expect(h.player.enqueued.at(-1)).toEqual([2, 'CCCC']);
  });
});

describe('(d) end-session cleanup', () => {
  it('end() during a pending reconnect: no new socket is ever opened', async () => {
    const h = await started();
    h.socket.serverClose();
    expect(h.controller.getState().connection).toBe('reconnecting');
    h.controller.end();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.sockets).toHaveLength(1);
    expect(h.controller.getState().connection).toBe('ended');
  });

  it('end() while camera/mic permission prompts are pending: the late streams are stopped, nothing is sent', async () => {
    const h = setup();
    const cam = deferred<void>();
    h.camera.start.mockImplementationOnce(() => cam.promise.then(() => h.camera.set({ status: 'active' })));
    const p = h.controller.start();
    h.socket.open();
    h.controller.end();
    cam.resolve();
    await p;
    expect(h.camera.stop).toHaveBeenCalled();
    expect(h.controller.getState().connection).toBe('ended');
    expect(h.controller.getState().error).toBeNull();
    const n = h.socket.send.mock.calls.length;
    h.sampler.emit(frame());
    h.mic.emit(loud);
    expect(h.socket.send.mock.calls.length).toBe(n);
  });

  it('a non-recoverable server error releases camera, microphone and the socket (regression: missing credentials left the camera on)', async () => {
    const h = setup();
    const p = h.controller.start();
    h.socket.open();
    h.socket.receive({ ...readyMsg('snapshot'), features: { live: false, snapshot: false, detections: false }, models: { live: null, vision: null } });
    h.socket.receive({ type: 'error', code: 'missing_credentials', message: 'The server has no Gemini API key configured.', recoverable: false });
    await p;
    const st = h.controller.getState();
    expect(st.connection).toBe('error');
    expect(st.error).toMatchObject({ code: 'missing_credentials', recoverable: false });
    // The UI returns to the Start screen for missing credentials (no End button), so media must already be off.
    expect(h.camera.stop).toHaveBeenCalled();
    expect(h.mic.stop).toHaveBeenCalled();
    expect(h.socket.close).toHaveBeenCalled();
    expect(h.socket.sent.at(-1)).toEqual({ type: 'bye' });
    const n = h.socket.send.mock.calls.length;
    h.mic.emit(loud);
    h.sampler.emit(frame());
    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.socket.send.mock.calls.length).toBe(n);
    expect(h.sockets).toHaveLength(1);
  });

  it('a permission prompt that resolves after a non-recoverable error does not overwrite the honest error', async () => {
    const h = setup();
    const cam = deferred<void>();
    h.camera.start.mockImplementationOnce(() => cam.promise.then(() => h.camera.set({ status: 'denied', message: 'Denied.' })));
    const p = h.controller.start();
    h.socket.open();
    h.socket.receive({ type: 'error', code: 'missing_credentials', message: 'No key.', recoverable: false });
    expect(h.camera.stop).toHaveBeenCalled(); // real CameraController releases a stream that arrives after stop()
    cam.resolve();
    await p;
    expect(h.controller.getState().error).toMatchObject({ code: 'missing_credentials' });
    expect(h.controller.getState().connection).toBe('error');
  });

  it('after a non-recoverable error, End session and Start work normally', async () => {
    const h = await started();
    h.socket.receive({ type: 'error', code: 'session_limit', message: 'The session time limit was reached.', recoverable: false });
    expect(h.controller.getState().connection).toBe('error');
    expect(h.camera.stop).toHaveBeenCalled();
    h.controller.end();
    expect(h.controller.getState().connection).toBe('ended');
    const p = h.controller.start();
    expect(h.sockets).toHaveLength(2);
    h.socket.open();
    h.socket.receive(readyMsg());
    await p;
    expect(h.controller.getState()).toMatchObject({ connection: 'live', error: null });
  });
});

describe('(e) fallback transitions', () => {
  it('Live connect failure: error(fallback snapshot) + status + ready(snapshot) -> Snapshot mode, sampler stopped, honest error', async () => {
    const h = setup();
    const p = h.controller.start();
    h.socket.open();
    h.socket.receive({ type: 'status', state: 'connecting' });
    h.socket.receive({
      type: 'error',
      code: 'model_unavailable',
      message: 'The configured Gemini Live model is not available for this API key. Check LIVE_MODEL in .env. Switched to snapshot mode.',
      recoverable: true,
      fallback: 'snapshot',
    });
    h.socket.receive({ type: 'status', state: 'snapshot' });
    h.socket.receive(readyMsg('snapshot'));
    await p;
    const st = h.controller.getState();
    expect(st).toMatchObject({ connection: 'snapshot', mode: 'snapshot' });
    expect(st.error).toMatchObject({ code: 'model_unavailable', recoverable: true });
    expect(h.sampler.start).not.toHaveBeenCalled();
    // Typed question captures a high-resolution still and carries it.
    await h.controller.sendText('What is this?');
    expect(h.camera.capture).toHaveBeenLastCalledWith({ maxDim: LIMITS.snapshotMaxDim, jpegQuality: LIMITS.snapshotJpegQuality });
    expect(h.socket.sent.at(-1)).toMatchObject({ type: 'text', text: 'What is this?', frame: { mimeType: 'image/jpeg' } });
    // Mic audio is not streamed in snapshot mode.
    h.mic.emit(loud);
    expect(h.socket.types()).not.toContain('audio');
  });

  it('Live lost mid-session (reconnects exhausted on the server): live -> snapshot without a new ready', async () => {
    const h = await started();
    expect(h.sampler.running).toBe(true);
    h.socket.receive({ type: 'status', state: 'reconnecting', detail: 'connection lost' });
    expect(h.controller.getState().connection).toBe('reconnecting');
    h.socket.receive({ type: 'error', code: 'provider_disconnected', message: 'Lost the connection to Gemini Live. Switched to snapshot mode.', recoverable: true, fallback: 'snapshot' });
    h.socket.receive({ type: 'status', state: 'snapshot' });
    const st = h.controller.getState();
    expect(st).toMatchObject({ connection: 'snapshot', mode: 'snapshot' });
    expect(h.sampler.running).toBe(false);
    h.mic.emit(loud);
    const sentFrames = h.socket.types().filter((t) => t === 'frame').length;
    h.sampler.emit(frame());
    expect(h.socket.types().filter((t) => t === 'frame').length).toBe(sentFrames);
  });

  it('snapshot answers are spoken with TTS and Stop speaking cancels TTS', async () => {
    const h = await started('snapshot');
    await h.controller.sendText('What is this?');
    const req = h.socket.sent.at(-1) as { requestId: string };
    h.socket.receive({ type: 'answer', requestId: req.requestId, text: 'A mug.', frameId: 1, model: 'v', latencyMs: 5 });
    expect(h.speech.speak).toHaveBeenCalledWith('A mug.');
    h.controller.stopSpeaking();
    expect(h.speech.cancel).toHaveBeenCalled();
  });

  it('explicit Read label with a slow camera: the capture is fresh and its id is newer than ambient frames', async () => {
    const h = await started();
    h.sampler.emit(frame());
    const slow = deferred<CapturedFrame | null>();
    h.camera.setCapture(() => slow.promise);
    const reading = h.controller.readLabel();
    expect(h.camera.capture).toHaveBeenLastCalledWith({ maxDim: LIMITS.snapshotMaxDim, jpegQuality: LIMITS.snapshotJpegQuality });
    slow.resolve(frame());
    await reading;
    const action = h.socket.sent.at(-1);
    expect(action).toMatchObject({ type: 'action', action: 'read_label' });
    expect(action?.type === 'action' && action.frame!.frameId).toBe(2);
  });
});
