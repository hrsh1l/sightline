/**
 * Instruction companion in desktop Chromium (phone viewport) against the real server with FIXTURE Gemini Live and
 * FIXTURE guide extractions (tests/fixtures/fixtureVision.ts: first view cut off, then microwave + oven).
 * Proves the integrated UI flow and app-owned progress; not live-model or S25 validation.
 */
import { test, expect } from '@playwright/test';
import { E2E_CONTROL_PORT } from './ports.js';

const stats = async () => (await fetch(`http://127.0.0.1:${E2E_CONTROL_PORT}/stats`)).json() as Promise<{ sessions: { clientContent: string[] }[] }>;

test('guide: framing advice, choose method, next is not done, done confirms, pause/resume, where were we, stop', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Start assistant' }).click();
  await expect(page.getByText('Live', { exact: false }).first()).toBeVisible();
  const panel = page.getByTestId('guide-panel');

  // Ask for a walkthrough: the FIXTURE first view is cut off -> one adjustment.
  await panel.getByRole('button', { name: 'Guide me through instructions' }).click();
  await expect(panel.getByText('The bottom of the instructions is outside the frame. Move the phone slightly back.').first()).toBeVisible();

  // "How about now?" without voice: Check this view (after the server's 2.5 s inspect throttle).
  await page.waitForTimeout(2_700);
  await panel.getByRole('button', { name: /^Check this view/ }).click();
  const microwave = panel.getByRole('button', { name: /MICROWAVE/ });
  await expect(microwave).toBeVisible();
  await expect(panel.getByRole('button', { name: /OVEN/ })).toBeVisible();
  await microwave.click();

  await expect(panel.getByText('Step 1 of 3').first()).toBeVisible();
  await expect.poll(async () => (await stats()).sessions.at(-1)!.clientContent.some((c) => c.includes('Step 1 of 3')), { message: 'step 1 handed to the model to speak' }).toBe(true);

  // Next presents step 2 but does not mark step 1 done.
  await panel.getByRole('button', { name: /^Next/ }).click();
  await expect(panel.getByText('Step 2 of 3').first()).toBeVisible();
  await panel.getByText('Show source text').click();
  const source = panel.getByTestId('guide-source');
  await expect(source).toContainText('Pierce film several times.');
  const before = await source.innerText();
  expect(before).not.toMatch(/Confirmed done/);

  // Done confirms the CURRENT step (2) only.
  await panel.getByTestId('guide-done').click();
  await expect(panel.getByText('Step 3 of 3').first()).toBeVisible();
  await expect(source).toContainText('Confirmed done');
  expect((await source.innerText()).match(/Confirmed done/g)).toHaveLength(1);

  // Pause / resume keep the place; Where were we? does not change it.
  await panel.getByRole('button', { name: /^Pause/ }).click();
  await expect(panel.getByRole('button', { name: /^Resume/ })).toBeVisible();
  await panel.getByRole('button', { name: /^Resume/ }).click();
  await expect(panel.getByText('Step 3 of 3').first()).toBeVisible();
  await panel.getByRole('button', { name: /^Where were we/ }).click();
  await expect(panel.getByText('Step 3 of 3').first()).toBeVisible();

  // Stop the guide: back to the idle entry; ordinary conversation still available.
  await panel.getByRole('button', { name: /^Stop guide/ }).click();
  await expect(panel.getByRole('button', { name: 'Guide me through instructions' })).toBeVisible();
  await expect(page.getByRole('button', { name: /^Read label/ })).toBeEnabled();
  await page.screenshot({ path: 'test-results/screenshots/12-guide-stopped.png', fullPage: true });
});
