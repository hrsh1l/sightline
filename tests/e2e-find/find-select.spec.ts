/**
 * REAL detector on the original COCO photo (three overlapping bowls). Gemini is FIXTURE.
 * Expect: needs selection with left/middle/right choices; after choosing, guidance stays bound to that bowl.
 */
import { test, expect } from '@playwright/test';
import { writeFileSync } from 'node:fs';
import { instrument, panAt, readLog } from './instrument.js';

test('three bowls: asks which one, then stays on the chosen bowl', async ({ page }, info) => {
  await instrument(page);
  await page.goto('/');
  await page.getByRole('button', { name: 'Start assistant' }).click();
  await expect(page.getByText('Live', { exact: false }).first()).toBeVisible();
  await page.getByRole('button', { name: /^Mute microphone/ }).click();
  await page.getByRole('button', { name: /^Bowl$/ }).click();

  const choice = page.getByRole('button', { name: /^Left bowl/ });
  await expect(choice).toBeVisible({ timeout: 15_000 });
  const before = await readLog(page);
  expect(before.speech.some((s) => /(three|3) bowls/i.test(s.text)), 'selection question spoken').toBe(true);
  const selectedAt = await page.evaluate(() => performance.now());
  await choice.click();
  await page.waitForTimeout(5_000);
  const log = await readLog(page);
  writeFileSync(info.outputPath('cue-log.json'), JSON.stringify(log, null, 1));
  const after = log.starts.filter((s) => s.kind === 'osc' && s.t > selectedAt + 600).map((s) => panAt(log, s.t)).filter((v): v is number => v !== null);
  console.info('[find e2e] pans after choosing the left bowl', after.map((v) => v.toFixed(2)).join(' '));
  expect(after.length, 'beacon pulses after selection').toBeGreaterThanOrEqual(3);
  // Left bowl centre is at ~0.34 of the width -> pan ~ -0.31; the other bowls are at ~ -0.04 and ~ +0.47.
  expect(after.every((v) => v < -0.15), 'stays on the left bowl').toBe(true);
  expect(Math.max(...after) - Math.min(...after), 'no jumping between bowls').toBeLessThan(0.2);
});
