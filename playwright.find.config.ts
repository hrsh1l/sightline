/**
 * REAL-detector Find e2e (desktop Chromium). The fake camera plays generated Y4M videos built from a real COCO
 * photo; detections come from the real local YOLO26n service. Gemini is FIXTURE. Requires `npm run detector`.
 *   npm run test:e2e:find
 * Not Galaxy S25 / Buds3 Pro validation: stereo routing over Bluetooth must be checked on the device.
 */
import { defineConfig } from '@playwright/test';
import path from 'node:path';

const PORT = 3111;
const media = path.resolve('test-results/media');

export default defineConfig({
  testDir: 'tests/e2e-find',
  testMatch: '**/*.spec.ts',
  outputDir: 'test-results/e2e-find',
  timeout: 90_000,
  expect: { timeout: 15_000 },
  workers: 1,
  retries: 0,
  reporter: [['list']],
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    browserName: 'chromium',
    viewport: { width: 384, height: 832 },
    isMobile: true,
    hasTouch: true,
    permissions: ['camera', 'microphone'],
    trace: 'retain-on-failure',
  },
  projects: [
    {
      name: 'bowl-pan',
      testMatch: '**/find-direction.spec.ts',
      use: { launchOptions: { args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-video-capture=${media}/bowl-pan.y4m`] } },
    },
    {
      name: 'three-bowls',
      testMatch: '**/find-select.spec.ts',
      use: { launchOptions: { args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-video-capture=${media}/three-bowls.y4m`] } },
    },
  ],
  webServer: {
    command: 'npx tsx tests/e2e/media/make-find-videos.ts && npx vite build --logLevel warn && npx tsx tests/e2e-find/find-server.ts',
    url: `http://127.0.0.1:${PORT}/api/health`,
    reuseExistingServer: false,
    timeout: 180_000,
    stdout: 'pipe',
  },
});
