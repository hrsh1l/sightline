/** Client composition root. OWNER: lead. Wires real browser implementations behind the contracts. */
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { LIMITS } from '../shared/protocol.js';
import { App } from './App.js';
import { createCameraController, createFrameSampler } from './camera/index.js';
import { createMicCapture } from './audio/MicCapture.js';
import { createAudioPlayer } from './audio/AudioPlayer.js';
import { createSpeechOutput } from './audio/SpeechOutput.js';
import { createSessionSocket } from './session/SessionSocket.js';
import { createAssistantController } from './session/AssistantController.js';

const controller = createAssistantController({
  camera: createCameraController(),
  // Live API accepts JPEG frames at up to 1 FPS; the sampler also enforces this floor.
  createSampler: (camera) =>
    createFrameSampler(camera, {
      intervalMs: LIMITS.liveFrameMinIntervalMs,
      maxDim: LIMITS.liveFrameMaxDim,
      jpegQuality: LIMITS.liveFrameJpegQuality,
    }),
  mic: createMicCapture(),
  player: createAudioPlayer(),
  speech: createSpeechOutput(),
  createSocket: () => createSessionSocket(),
});

const rootEl = document.getElementById('root');
if (!rootEl) throw new Error('#root missing');
createRoot(rootEl).render(
  <StrictMode>
    <App controller={controller} />
  </StrictMode>,
);

// Release camera/mic/socket if the page is torn down (not for bfcache, where pagehide.persisted is true).
window.addEventListener('pagehide', (e) => {
  if (!e.persisted) controller.end();
});
