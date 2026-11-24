/**
 * REAL detector (YOLO26n on a generated video of a real photographed bowl) + real client audio graph in desktop
 * Chromium. Gemini is FIXTURE. Video timeline (tests/e2e/media/make-find-videos.ts): bowl LEFT 0-5 s, slides to
 * CENTRE 5-9 s, holds CENTRE 9-13 s, slides RIGHT 13-16 s, gone 16-20 s.
 * Not device validation: Bluetooth stereo routing on the S25 + Buds3 Pro must be checked by hand.
 */
import { test, expect } from '@playwright/test';
import { writeFileSync } from 'node:fs';
import { instrument, panAt, readLog } from './instrument.js';

test('find a bowl: left-biased beacon, one centred confirmation, right-biased beacon, loss announced once and cues stop', async ({ page }, info) => {
  await instrument(page);
  await page.goto('/');
  await page.getByRole('button', { name: 'Start assistant' }).click();
  await expect(page.getByText('Live', { exact: false }).first()).toBeVisible();
  // Chromium's fake microphone beeps; mute so it is not treated as the user talking (which pauses cues).
  await page.getByRole('button', { name: /^Mute microphone/ }).click();
  await page.getByRole('button', { name: /^Bowl$/ }).click();

  const t0 = (await readLog(page)).t0;
  expect(t0, 'camera opened').not.toBeNull();
  await page.waitForFunction((start) => performance.now() - start > 19_500, t0!, { timeout: 40_000, polling: 250 });
  const log = await readLog(page);
  writeFileSync(info.outputPath('cue-log.json'), JSON.stringify(log, null, 1));

  const rel = (t: number) => (t - t0!) / 1000;
  const oscIn = (a: number, b: number) => log.starts.filter((s) => s.kind === 'osc' && rel(s.t) >= a && rel(s.t) < b);
  const pans = (a: number, b: number) => oscIn(a, b).map((s) => panAt(log, s.t));
  const said = (re: RegExp) => log.speech.filter((s) => re.test(s.text)).map((s) => +rel(s.t).toFixed(2));

  const left = pans(2, 4.8);
  const right = pans(15, 16.2);
  const centredSaid = said(/bowl centred/i);
  const lostSaid = said(/lost/i);
  const summary = {
    leftPulses: left.length,
    leftPans: left.map((v) => v?.toFixed(2)),
    centredHoldStarts: oscIn(10.6, 12.8).length,
    rightPulses: right.length,
    rightPans: right.map((v) => v?.toFixed(2)),
    centredSaid,
    lostSaid,
    afterLostStarts: oscIn(17.8, 19.5).length,
    speech: log.speech.map((s) => `${rel(s.t).toFixed(1)}s ${s.text}`),
  };
  console.info('[find e2e] summary', JSON.stringify(summary, null, 1));

  expect(left.length, 'beacon pulses while the bowl is left').toBeGreaterThanOrEqual(3);
  expect(left.every((v) => v !== null && v < -0.3), 'left-biased pan').toBe(true);
  expect(centredSaid, 'one centred confirmation while the bowl is held at centre').toHaveLength(1);
  expect(centredSaid[0]!).toBeGreaterThan(8.5);
  expect(centredSaid[0]!).toBeLessThan(13.5);
  expect(oscIn(10.6, 12.8).length, 'beacon stops while stably centred').toBeLessThanOrEqual(1);
  expect(right.length, 'beacon resumes when the bowl moves right').toBeGreaterThanOrEqual(2);
  expect(right.every((v) => v !== null && v > 0.15), 'right-biased pan').toBe(true);
  expect(lostSaid, 'loss announced once').toHaveLength(1);
  expect(oscIn(17.8, 19.5), 'no directional cues after loss').toHaveLength(0);
});
