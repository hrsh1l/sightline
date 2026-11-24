/**
 * Server for the REAL-detector Find e2e test. Starts the real Sightline server (production build) with:
 *   - the REAL local YOLO detector (DETECTOR_URL, default http://127.0.0.1:8765; start with `npm run detector`)
 *   - FIXTURE Gemini Live + FIXTURE vision (no Google calls, no quota used; the FIXTURE Live never auto-replies)
 * Evidence from this server = desktop Chromium + real YOLO detections on generated camera video. It is NOT
 * live-model or Galaxy S25 / Buds3 Pro validation.
 */
import { startServer } from '../../src/server/index.js';
import { loadConfig } from '../../src/server/config.js';
import { createLogger } from '../../src/server/log.js';
import { createDetector } from '../../src/server/vision/detector.js';
import { createFixtureLive } from '../fixtures/fixtureLive.js';
import { createFixtureVision } from '../fixtures/fixtureVision.js';

const PORT = Number(process.env.FIND_E2E_PORT ?? 3111);
const DETECTOR_URL = process.env.DETECTOR_URL || 'http://127.0.0.1:8765';

async function main() {
  const health = await fetch(`${DETECTOR_URL}/health`).then((r) => r.ok, () => false);
  if (!health) {
    console.error(`[find e2e] detector not reachable at ${DETECTOR_URL}. Start it with: npm run detector`);
    process.exit(1);
  }
  const config = loadConfig({ NODE_ENV: 'production', HOST: '127.0.0.1', PORT: String(PORT), DETECTOR_URL, MAX_CONCURRENT_SESSIONS: '4' });
  const log = createLogger('find-e2e');
  await startServer(config, {
    liveConnector: createFixtureLive().connector,
    vision: createFixtureVision(),
    detector: createDetector({ config, log }),
    log,
  });
  console.info(`[find e2e] http://127.0.0.1:${PORT} (REAL detector ${DETECTOR_URL}, FIXTURE Gemini)`);
}
main().catch((e: unknown) => {
  console.error(e);
  process.exit(1);
});
