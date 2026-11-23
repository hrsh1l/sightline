/**
 * Desktop Chromium e2e with FAKE camera/microphone and FIXTURE providers (tests/e2e/fixture-server.ts).
 * Proves the browser app + real server plumbing end to end. Does NOT prove Gemini Live behaviour or anything
 * about the Galaxy S25 (real rear camera, Android permission UI, audio routing, TalkBack).
 */
import { expect, test } from '@playwright/test';
import { E2E_NOKEY_PORT } from './ports.js';
import {
  denyCamera,
  horizontalOverflow,
  lastIndex,
  newestSession,
  recordMediaStreams,
  screenshot,
  sessionByIndex,
  startAssistant,
  stats,
  trackStates,
  triggerReply,
  triggerToolReadLabel,
} from './helpers.js';

test.describe('FIXTURE e2e: phone portrait viewport (384x832, emulated)', () => {
  test('start screen explains purpose and privacy before any media is requested', async ({ page }) => {
    await recordMediaStreams(page);
    await page.goto('/');
    await expect(page.getByRole('heading', { level: 1, name: 'Sightline' })).toBeVisible();
    await expect(page.getByText(/selected camera frames and your microphone audio are sent to the configured AI provider \(Google Gemini\)/)).toBeVisible();
    await expect(page.getByText(/Nothing is saved by Sightline after you end the session/)).toBeVisible();
    await expect(page.getByRole('button', { name: 'Start assistant' })).toBeEnabled();
    expect(await trackStates(page)).toEqual([]); // nothing requested before the tap
    await screenshot(page, '01-start-portrait');
  });

  test('live session: frames <= 1 FPS, 16 kHz audio, FIXTURE reply, stop speaking, mute, read label, voice tool, end session', async ({ page }) => {
    test.setTimeout(90_000);
    await recordMediaStreams(page);
    const before = await lastIndex();
    await page.goto('/');
    await startAssistant(page);
    await expect(page.getByTestId('status-camera')).toContainText(/Rear camera|Front camera|Camera on/);
    await expect(page.getByTestId('status-mic')).toContainText('On');
    const s0 = await newestSession(before);
    const idx = s0.index;

    // --- Frames reach the FIXTURE provider at <= 1 FPS; audio arrives as audio/pcm;rate=16000.
    await expect.poll(async () => (await sessionByIndex(idx)).frames, { timeout: 5_000 }).toBeGreaterThanOrEqual(1);
    const a = await sessionByIndex(idx);
    await page.waitForTimeout(4_000);
    const b = await sessionByIndex(idx);
    const framesIn4s = b.frames - a.frames;
    expect(framesIn4s).toBeGreaterThanOrEqual(2);
    expect(framesIn4s).toBeLessThanOrEqual(5);
    const gaps = b.frameTimes.slice(1).map((t, i) => t - b.frameTimes[i]!);
    expect(Math.min(...gaps)).toBeGreaterThanOrEqual(900);
    expect(b.audio).toBeGreaterThan(a.audio);
    expect(b.audioMimes).toEqual(['audio/pcm;rate=16000']);

    // --- The FIXTURE provider's auto reply (tone + "FIXTURE reply") shows in the transcript.
    const transcript = page.getByRole('region', { name: 'Transcript' });
    await expect(transcript).toContainText('FIXTURE reply');
    await expect(transcript).toContainText('FIXTURE heard you');
    await screenshot(page, '02-live-portrait-reply');

    // --- Stop speaking: a long FIXTURE reply is cut off locally and the server drops the rest of the turn.
    await triggerReply(6_000);
    await expect(page.getByTestId('status-speaking')).toContainText('Speaking');
    const stop = page.getByRole('button', { name: /Stop speaking/ });
    await expect(stop).toBeEnabled();
    await stop.click();
    await expect(page.getByTestId('status-speaking')).toContainText('Not speaking');
    // The FIXTURE keeps streaming audio for this turn for several seconds; none of it may play.
    await page.waitForTimeout(1_500);
    await expect(page.getByTestId('status-speaking')).toContainText('Not speaking');
    await expect(stop).toBeDisabled();

    // --- Mute toggles aria-pressed and stops audio forwarding; unmute resumes it.
    const mute = page.getByRole('button', { name: /Mute microphone/ });
    await expect(mute).toHaveAttribute('aria-pressed', 'false');
    await mute.click();
    await expect(mute).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByTestId('status-mic')).toContainText('Muted');
    await page.waitForTimeout(500);
    const m1 = await sessionByIndex(idx);
    await page.waitForTimeout(2_000);
    const m2 = await sessionByIndex(idx);
    expect(m2.audio).toBe(m1.audio);
    expect(m2.audioStreamEnds).toBeGreaterThanOrEqual(1);
    await mute.click();
    await expect(mute).toHaveAttribute('aria-pressed', 'false');
    await expect.poll(async () => (await sessionByIndex(idx)).audio, { timeout: 5_000 }).toBeGreaterThan(m2.audio);

    // --- Read label: a fresh high-res capture goes to FIXTURE vision; evidence panel separates exact text,
    //     dates, batch codes and interpretation; the evidence is injected into the Live session.
    const visionBefore = (await stats()).vision.extractCalls.length;
    const pressedAt = Date.now();
    await page.getByRole('button', { name: 'Read label' }).click();
    const evidence = page.getByTestId('evidence');
    await expect(evidence).toBeVisible();
    await expect(page.getByTestId('evidence-exact')).toContainText('FIXTURE Tomato Soup');
    await expect(page.getByTestId('evidence-exact')).toContainText('Heat gently for 4 minutes, stirring.');
    await expect(page.getByTestId('evidence-dates')).toContainText('BEST BEFORE END 03 2027');
    await expect(page.getByTestId('evidence-batch')).toContainText('L4471 B2');
    await expect(page.getByTestId('evidence-batch')).toContainText('not dates');
    await expect(page.getByTestId('evidence-interpretation')).toContainText('a tin of soup (FIXTURE guess)');
    await expect(page.getByTestId('evidence-exact')).not.toContainText('FIXTURE guess');
    await expect(page.getByTestId('evidence-exact')).not.toContainText('L4471');
    const st = await stats();
    const call = st.vision.extractCalls[visionBefore]!;
    expect(call).toBeDefined();
    expect(Math.abs(call.capturedAt - pressedAt)).toBeLessThan(2_500); // fresh capture, not an old ambient frame
    expect(Math.max(call.width, call.height)).toBeLessThanOrEqual(1_600);
    expect(Math.max(call.width, call.height)).toBeGreaterThan(0);
    const sAfterRead = await sessionByIndex(idx);
    expect(sAfterRead.clientContent.some((c) => c.includes('the user pressed Read label'))).toBe(true);
    await screenshot(page, '03-evidence-portrait');

    // --- Voice path: the FIXTURE provider calls read_label; the page answers snapshot.request with a fresh
    //     capture, the server runs FIXTURE vision and returns a tool response with the same call id.
    const callId = await triggerToolReadLabel();
    await expect
      .poll(async () => (await sessionByIndex(idx)).toolResponses.find((t) => t.includes(callId)) ?? '', { timeout: 10_000 })
      .toContain('"status":"ok"');
    expect((await stats()).vision.extractCalls.length).toBe(visionBefore + 2);

    // --- Diagnostics show frames sent (used by the S25 checklist).
    await page.getByText('Settings and diagnostics').click();
    await page.getByLabel('Show diagnostics').check();
    const diag = page.getByTestId('diagnostics');
    await expect(diag).toContainText('Frames sent');
    const framesSentText = await diag.locator('.diagnostics__row', { hasText: 'Frames sent' }).locator('dd').textContent();
    expect(Number(framesSentText)).toBeGreaterThanOrEqual(3);

    // --- End session: provider session closed, nothing more is received, all tracks stopped.
    await page.getByRole('button', { name: /End session/ }).click();
    await expect(page.getByTestId('session-ended')).toContainText('The camera and microphone are off');
    await expect.poll(async () => (await sessionByIndex(idx)).closed, { timeout: 5_000 }).toBe(true);
    const e1 = await sessionByIndex(idx);
    await page.waitForTimeout(3_000);
    const e2 = await sessionByIndex(idx);
    expect(e2.frames).toBe(e1.frames);
    expect(e2.audio).toBe(e1.audio);
    expect(e2.sendsAfterClose).toBe(0);
    const tracks = await trackStates(page);
    expect(tracks.length).toBeGreaterThanOrEqual(2);
    expect(tracks.every((t) => t.readyState === 'ended')).toBe(true);
    const videoSrc = await page.evaluate(() => Array.from(document.querySelectorAll('video')).map((v) => v.srcObject === null));
    expect(videoSrc.every(Boolean)).toBe(true);
    const disposed = (await stats()).log.filter((l) => l.event === 'session_disposed');
    expect(disposed.at(-1)?.fields).toMatchObject({ reason: 'bye' });
    // The server discarded the rest of the stopped FIXTURE reply instead of forwarding it.
    expect(Number(disposed.at(-1)?.fields.audioOutDiscarded ?? 0)).toBeGreaterThan(0);
    await screenshot(page, '04-ended-portrait');
  });

  test('camera permission denied: denial message, voice-only conversation still works', async ({ page }) => {
    await denyCamera(page);
    const before = await lastIndex();
    await page.goto('/');
    await startAssistant(page);
    await expect(page.getByTestId('status-camera')).toContainText('Denied');
    const banner = page.getByTestId('error-banner');
    await expect(banner).toContainText('Camera permission was denied');
    await expect(banner).toContainText('set Camera to Allow');
    await expect(banner.getByRole('button', { name: 'Open settings' })).toBeVisible();
    const s = await newestSession(before);
    await expect.poll(async () => (await sessionByIndex(s.index)).audio, { timeout: 5_000 }).toBeGreaterThan(3);
    expect((await sessionByIndex(s.index)).frames).toBe(0);
    await triggerReply(400, 'FIXTURE voice-only reply');
    await expect(page.getByRole('region', { name: 'Transcript' })).toContainText('FIXTURE voice-only reply');
    // Read label honestly fails without a camera (no fabricated evidence).
    await page.getByRole('button', { name: 'Read label' }).click();
    await expect(page.getByTestId('error-banner')).toContainText('Camera unavailable');
    await expect(page.getByTestId('evidence')).toHaveCount(0);
    await screenshot(page, '05-camera-denied-portrait');
    await page.getByRole('button', { name: /End session/ }).click();
  });

  test('missing credentials: honest configuration message, Start disabled, camera and mic released', async ({ page }) => {
    await recordMediaStreams(page);
    await page.goto(`http://127.0.0.1:${E2E_NOKEY_PORT}/`);
    await page.getByRole('button', { name: 'Start assistant' }).click();
    const msg = page.getByTestId('config-message');
    await expect(msg).toContainText('Not set up yet');
    await expect(msg).toContainText('no Gemini API key configured');
    await expect(page.getByRole('button', { name: 'Start assistant' })).toBeDisabled();
    await expect(page.getByRole('region', { name: 'Transcript' })).toHaveCount(0);
    // Regression: the Start screen has no End button, so the controller must release media itself.
    await expect.poll(async () => (await trackStates(page)).every((t) => t.readyState === 'ended'), { timeout: 5_000 }).toBe(true);
    await screenshot(page, '06-missing-credentials-portrait');
  });

  test('layout: every button is named and at least 44 px tall; no horizontal scroll at 384 px', async ({ page }) => {
    await page.goto('/');
    await startAssistant(page);
    await page.getByText('Settings and diagnostics').click();
    const buttons = await page.getByRole('button').all();
    expect(buttons.length).toBeGreaterThanOrEqual(8);
    const small: string[] = [];
    for (const b of buttons) {
      await expect(b).toHaveAccessibleName(/\S/);
      if (!(await b.isVisible())) continue;
      const box = await b.boundingBox();
      if (box && box.height < 44) small.push(`${(await b.textContent())?.trim()} (${Math.round(box.height)}px)`);
    }
    expect(small, `buttons under 44px: ${small.join(', ')}`).toEqual([]);
    const ov = await horizontalOverflow(page);
    expect(ov, JSON.stringify(ov)).toEqual({ scroll: false, offenders: [] });
    await page.getByRole('button', { name: /End session/ }).click();
  });
});

test.describe('FIXTURE e2e: narrow, zoomed and landscape layouts (emulated)', () => {
  test('320 px wide: start and session screens have no horizontal overflow', async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 700 });
    await page.goto('/');
    expect(await horizontalOverflow(page)).toEqual({ scroll: false, offenders: [] });
    await screenshot(page, '07-start-320');
    await startAssistant(page);
    const ov = await horizontalOverflow(page);
    expect(ov, JSON.stringify(ov)).toEqual({ scroll: false, offenders: [] });
    await screenshot(page, '08-session-320');
    await page.getByRole('button', { name: /End session/ }).click();
  });

  test('200% text size (root font-size 200%) at 384 px: no horizontal overflow, buttons grow', async ({ page }) => {
    await page.goto('/');
    await page.addStyleTag({ content: 'html { font-size: 200% !important; }' });
    expect(await horizontalOverflow(page)).toEqual({ scroll: false, offenders: [] });
    await startAssistant(page);
    const ov = await horizontalOverflow(page);
    expect(ov, JSON.stringify(ov)).toEqual({ scroll: false, offenders: [] });
    const box = await page.getByRole('button', { name: 'Read label' }).boundingBox();
    expect(box!.height).toBeGreaterThanOrEqual(88);
    await screenshot(page, '09-session-text-200pct');
    await page.getByRole('button', { name: /End session/ }).click();
  });

  test('200% page zoom equivalent (192 CSS px layout width): no horizontal overflow', async ({ page }) => {
    await page.setViewportSize({ width: 192, height: 416 });
    await page.goto('/');
    const ov1 = await horizontalOverflow(page);
    expect(ov1, JSON.stringify(ov1)).toEqual({ scroll: false, offenders: [] });
    await startAssistant(page);
    const ov2 = await horizontalOverflow(page);
    expect(ov2, JSON.stringify(ov2)).toEqual({ scroll: false, offenders: [] });
    await screenshot(page, '10-session-zoom-192');
    await page.getByRole('button', { name: /End session/ }).click();
  });

  test('landscape 832x384: session goes live, controls reachable, no horizontal overflow', async ({ page }) => {
    await page.setViewportSize({ width: 832, height: 384 });
    const before = await lastIndex();
    await page.goto('/');
    await startAssistant(page);
    const s = await newestSession(before);
    await expect.poll(async () => (await sessionByIndex(s.index)).frames, { timeout: 5_000 }).toBeGreaterThanOrEqual(1);
    const ov = await horizontalOverflow(page);
    expect(ov, JSON.stringify(ov)).toEqual({ scroll: false, offenders: [] });
    const end = page.getByRole('button', { name: /End session/ });
    await end.scrollIntoViewIfNeeded();
    await expect(end).toBeVisible();
    await screenshot(page, '11-session-landscape');
    await end.click();
    await expect.poll(async () => (await sessionByIndex(s.index)).closed).toBe(true);
  });
});
