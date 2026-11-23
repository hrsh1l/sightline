/**
 * Desktop-Chromium e2e tests against the REAL server with FIXTURE providers (tests/e2e/fixture-server.ts).
 * Chromium's fake camera/microphone replace real devices. This is not live-model or Galaxy S25 validation.
 */
import { defineConfig } from '@playwright/test';
import { E2E_CONTROL_PORT, E2E_NOKEY_PORT, E2E_PORT } from './tests/e2e/ports.js';

export default defineConfig({
  testDir: 'tests/e2e',
  testMatch: '**/*.spec.ts',
  outputDir: 'test-results/e2e',
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1, // one shared FIXTURE provider; tests read its counters
  retries: 0,
  reporter: [['list'], ['html', { open: 'never', outputFolder: 'playwright-report' }]],
  use: {
    baseURL: `http://127.0.0.1:${E2E_PORT}`,
    browserName: 'chromium',
    // Phone-sized viewport (roughly a Galaxy S25 in CSS px). Emulation only: not a real device.
    viewport: { width: 384, height: 832 },
    isMobile: true,
    hasTouch: true,
    deviceScaleFactor: 3,
    permissions: ['camera', 'microphone'],
    launchOptions: {
      // Fake camera (test pattern) and fake microphone (beep), and auto-accept the permission prompt.
      args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'],
    },
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  webServer: {
    // Static production build of the client, then the FIXTURE server (real startServer, FIXTURE providers).
    command: 'npx vite build --logLevel warn && npx tsx tests/e2e/fixture-server.ts',
    url: `http://127.0.0.1:${E2E_CONTROL_PORT}/health`,
    reuseExistingServer: false,
    timeout: 120_000,
    stdout: 'pipe',
    env: { E2E_PORT: String(E2E_PORT), E2E_NOKEY_PORT: String(E2E_NOKEY_PORT), E2E_CONTROL_PORT: String(E2E_CONTROL_PORT) },
  },
});
