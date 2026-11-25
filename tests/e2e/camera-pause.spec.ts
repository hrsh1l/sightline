/**
 * Pause camera in desktop Chromium (fake camera) against the real server with FIXTURE Gemini Live.
 * Proves the camera track is released, no frames reach the provider while paused, and frames resume afterwards.
 */
import { test, expect } from '@playwright/test';
import { E2E_CONTROL_PORT } from './ports.js';

type Stats = { sessions: { frames: number; clientContent: string[] }[] };
const stats = async () => (await (await fetch(`http://127.0.0.1:${E2E_CONTROL_PORT}/stats`)).json()) as Stats;
const last = async () => (await stats()).sessions.at(-1)!;

test('pause camera: track released, no frames while paused, model told, frames resume', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Start assistant' }).click();
  await expect(page.getByText('Live', { exact: false }).first()).toBeVisible();
  await expect.poll(async () => (await last()).frames, { message: 'ambient frames flowing' }).toBeGreaterThan(0);

  await page.getByRole('button', { name: 'Pause camera' }).click();
  await expect(page.getByRole('button', { name: 'Resume camera' })).toBeVisible();
  const liveTracks = () =>
    page.evaluate(() => {
      const v = document.querySelector('video');
      const src = v?.srcObject as MediaStream | null | undefined;
      return src ? src.getVideoTracks().filter((t) => t.readyState === 'live').length : 0;
    });
  await expect.poll(liveTracks, { message: 'camera released' }).toBe(0);
  await expect.poll(async () => (await last()).clientContent.some((c) => c.includes('paused the camera'))).toBe(true);
  const frozen = (await last()).frames;
  await page.waitForTimeout(2_500);
  expect((await last()).frames).toBe(frozen);
  await expect(page.getByRole('button', { name: /^Mute microphone/ })).toBeEnabled();

  await page.getByRole('button', { name: 'Resume camera' }).click();
  await expect(page.getByRole('button', { name: 'Pause camera' })).toBeVisible();
  await expect.poll(liveTracks).toBe(1);
  await expect.poll(async () => (await last()).frames, { timeout: 5_000 }).toBeGreaterThan(frozen);
});
