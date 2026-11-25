/**
 * Captures the walkthrough screenshots in docs/screenshots/ from the REAL app (running dev server, real Gemini, local
 * YOLO detector) in Chromium at a phone-sized viewport. The phone camera is replaced by generated videos:
 *   - a SYNTHETIC packet back (cooking instructions, dates) drawn here: not a real product;
 *   - the same packet framed so its bottom is cut off;
 *   - COCO sample photo 000000000009.jpg (bowls of food), from tests/e2e/media/make-find-videos.ts.
 * The microphone is silent; questions are typed. Answers come from the live models, so wording varies run to run.
 *
 *   npm run dev  (+ npm run detector)   then   npx tsx scripts/capture-screenshots.ts
 * Uses API quota (a Live session per scene, a label read and two guide extractions).
 */
import { existsSync, mkdirSync, openSync, writeSync, closeSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { chromium, type Page } from 'playwright';

const BASE = process.env.SIGHTLINE_URL ?? 'http://localhost:3000';
const OUT = path.resolve('docs/screenshots');
const MEDIA = path.resolve('test-results/media/screens');
const W = 1280;
const H = 960;
mkdirSync(OUT, { recursive: true });
mkdirSync(MEDIA, { recursive: true });

// ---------------------------------------------------------------------------------------------------------------
// Camera media
// ---------------------------------------------------------------------------------------------------------------

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
type Line = { t: string; size: number; bold?: boolean; gap?: number };
const PACKET: Line[] = [
  { t: 'CHICKEN TIKKA MASALA', size: 44, bold: true },
  { t: 'with pilau rice  ·  400g  ·  Serves 1', size: 26, gap: 30 },
  { t: 'COOKING INSTRUCTIONS', size: 32, bold: true },
  { t: 'MICROWAVE  (800W)', size: 28, bold: true },
  { t: '1. Pierce film several times.', size: 26 },
  { t: '2. Heat on full power for 3 minutes.', size: 26 },
  { t: '3. Stir, re-cover and heat for 1 minute 30 seconds.', size: 26 },
  { t: '4. Stand for 1 minute before serving.', size: 26, gap: 26 },
  { t: 'OVEN  190°C / Fan 170°C / Gas 5', size: 28, bold: true },
  { t: '1. Remove film and cover with foil.', size: 26 },
  { t: '2. Place on a baking tray in the centre of the oven.', size: 26 },
  { t: '3. Cook for 25 minutes. Stir halfway.', size: 26, gap: 26 },
  { t: 'Check food is piping hot before serving.', size: 24 },
  { t: 'USE BY: 28 NOV 2026      Keep refrigerated', size: 28, bold: true },
  { t: 'L6329 B4', size: 22 },
];

async function packetLabel(): Promise<{ png: Buffer; w: number; h: number }> {
  const w = 1060;
  let y = 64;
  const text = PACKET.map((l) => {
    const el = `<text x="48" y="${y}" font-family="Helvetica, Arial, sans-serif" font-size="${l.size}" font-weight="${l.bold ? 700 : 400}" fill="#141414">${esc(l.t)}</text>`;
    y += l.size + 16 + (l.gap ?? 0);
    return el;
  }).join('');
  const h = y + 24;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><rect width="100%" height="100%" rx="18" fill="#f7f0e1"/><rect x="0" y="0" width="${w}" height="10" fill="#b5462b"/>${text}</svg>`;
  return { png: await sharp(Buffer.from(svg)).png().toBuffer(), w, h };
}

/** Packet on a wooden worktop. cut=true aims the camera too high: the lower part of the instructions is outside the picture. */
async function packetFrame(cut: boolean): Promise<Buffer> {
  const label = await packetLabel();
  const scale = Math.min(1, (H - 60) / label.h);
  const lw = Math.round(label.w * scale);
  const lh = Math.round(label.h * scale);
  const png = await sharp(label.png).resize(lw, lh).toBuffer();
  const top = cut ? Math.round(H - lh * 0.36) : Math.round((H - lh) / 2);
  const visible = cut ? await sharp(png).extract({ left: 0, top: 0, width: lw, height: H - top }).toBuffer() : png;
  return sharp({ create: { width: W, height: H, channels: 3, background: '#7a5a3c' } })
    .composite([{ input: visible, left: Math.round((W - lw) / 2), top }])
    .removeAlpha()
    .raw()
    .toBuffer();
}

async function kitchenFrame(): Promise<Buffer> {
  const img = path.resolve('test-results/media/coco8/images/train/000000000009.jpg');
  if (!existsSync(img)) throw new Error('Run `npx tsx tests/e2e/media/make-find-videos.ts` once first (downloads the COCO sample).');
  return sharp(img).resize(W, H, { fit: 'cover' }).removeAlpha().raw().toBuffer();
}

function toI420(rgb: Buffer): Buffer {
  const y = Buffer.alloc(W * H);
  const u = Buffer.alloc((W / 2) * (H / 2));
  const v = Buffer.alloc((W / 2) * (H / 2));
  const c = (n: number) => Math.max(0, Math.min(255, Math.round(n)));
  for (let i = 0, p = 0; i < W * H; i++, p += 3) y[i] = c(0.299 * rgb[p]! + 0.587 * rgb[p + 1]! + 0.114 * rgb[p + 2]!);
  for (let by = 0; by < H / 2; by++) {
    for (let bx = 0; bx < W / 2; bx++) {
      let r = 0, g = 0, b = 0;
      for (const [dx, dy] of [[0, 0], [1, 0], [0, 1], [1, 1]] as const) {
        const p = ((by * 2 + dy) * W + (bx * 2 + dx)) * 3;
        r += rgb[p]!; g += rgb[p + 1]!; b += rgb[p + 2]!;
      }
      const k = by * (W / 2) + bx;
      u[k] = c(-0.169 * r / 4 - 0.331 * g / 4 + 0.5 * b / 4 + 128);
      v[k] = c(0.5 * r / 4 - 0.419 * g / 4 - 0.081 * b / 4 + 128);
    }
  }
  return Buffer.concat([y, u, v]);
}

function writeY4m(file: string, rgb: Buffer, frames = 4) {
  const fd = openSync(file, 'w');
  writeSync(fd, `YUV4MPEG2 W${W} H${H} F2:1 Ip A1:1 C420jpeg\n`);
  const yuv = toI420(rgb);
  for (let i = 0; i < frames; i++) {
    writeSync(fd, 'FRAME\n');
    writeSync(fd, yuv);
  }
  closeSync(fd);
}

function silentWav(file: string, seconds = 2) {
  const rate = 16_000;
  const data = Buffer.alloc(rate * seconds * 2);
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + data.length, 4); h.write('WAVE', 8); h.write('fmt ', 12);
  h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22); h.writeUInt32LE(rate, 24);
  h.writeUInt32LE(rate * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34); h.write('data', 36);
  h.writeUInt32LE(data.length, 40);
  writeFileSync(file, Buffer.concat([h, data]));
}

// ---------------------------------------------------------------------------------------------------------------
// Browser
// ---------------------------------------------------------------------------------------------------------------

async function withPhone(video: string, fn: (page: Page) => Promise<void>) {
  const browser = await chromium.launch({
    args: [
      '--use-fake-ui-for-media-stream',
      '--use-fake-device-for-media-stream',
      `--use-file-for-fake-video-capture=${video}`,
      `--use-file-for-fake-audio-capture=${path.join(MEDIA, 'silence.wav')}`,
      '--autoplay-policy=no-user-gesture-required',
    ],
  });
  const context = await browser.newContext({ viewport: { width: 412, height: 915 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  await context.grantPermissions(['camera', 'microphone'], { origin: BASE });
  const page = await context.newPage();
  try {
    await fn(page);
  } finally {
    await page.getByRole('button', { name: /End session/ }).click().catch(() => undefined);
    await browser.close();
  }
}

async function shot(page: Page, name: string, scrollTo?: string) {
  if (scrollTo) await page.locator(scrollTo).first().evaluate((el) => el.scrollIntoView({ block: 'start' }));
  else await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(400);
  await page.screenshot({ path: path.join(OUT, `${name}.png`) });
  console.info(`  saved ${name}.png`);
}

async function open(page: Page) {
  await page.goto(BASE);
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(1_500); // Vite may reload once after optimising dependencies
  await page.getByRole('button', { name: 'Start assistant' }).waitFor();
}

async function startLive(page: Page) {
  await open(page);
  await page.getByRole('button', { name: 'Start assistant' }).click();
  await page.waitForFunction(() => /Live/.test(document.querySelector('[data-testid="status-connection"]')?.textContent ?? ''), undefined, { timeout: 30_000 });
  await page.waitForTimeout(2_500); // a few ambient frames reach Gemini; detector boxes appear
}

async function ask(page: Page, text: string) {
  await page.getByRole('textbox', { name: 'Question' }).fill(text);
  await page.getByRole('textbox', { name: 'Question' }).press('Enter');
  // Wait for a final assistant transcript entry after this question.
  await page.waitForFunction(
    (q) => {
      const entries = [...document.querySelectorAll('.transcript__entry')];
      const qi = entries.findIndex((e) => e.textContent?.includes(q));
      return qi >= 0 && entries.slice(qi + 1).some((e) => e.className.includes('assistant') && !e.querySelector('.transcript__pending'));
    },
    text,
    { timeout: 45_000 },
  );
  await page.waitForTimeout(3_000); // let the spoken reply finish streaming into the transcript
}

// ---------------------------------------------------------------------------------------------------------------
// Scenes
// ---------------------------------------------------------------------------------------------------------------

const only = new Set(process.argv.slice(2));
const want = (s: string) => only.size === 0 || only.has(s);

silentWav(path.join(MEDIA, 'silence.wav'));
const packetY4m = path.join(MEDIA, 'packet.y4m');
const cutY4m = path.join(MEDIA, 'packet-cut.y4m');
const kitchenY4m = path.join(MEDIA, 'kitchen.y4m');
writeY4m(packetY4m, await packetFrame(false));
writeY4m(cutY4m, await packetFrame(true));
writeY4m(kitchenY4m, await kitchenFrame());
for (const [f, buf] of [['camera-packet.jpg', await packetFrame(false)], ['camera-packet-cut.jpg', await packetFrame(true)]] as const) {
  await sharp(buf, { raw: { width: W, height: H, channels: 3 } }).jpeg({ quality: 85 }).toFile(path.join(MEDIA, f));
}

if (want('start')) {
  console.info('scene: start + conversation + read label + pause camera');
  await withPhone(packetY4m, async (page) => {
    await open(page);
    await shot(page, '01-start');
    await startLive(page);
    await shot(page, '02-live-session');
    await ask(page, 'What am I holding?');
    await shot(page, '03-conversation', 'section.transcript');
    await page.getByRole('button', { name: /^Read label/ }).click();
    await page.getByTestId('evidence').waitFor({ timeout: 60_000 });
    await page.waitForTimeout(4_000);
    await shot(page, '04-read-label', '[data-testid="evidence"]');
    await page.getByRole('button', { name: 'Pause camera' }).click();
    await page.waitForTimeout(1_500);
    await shot(page, '10-camera-paused');
  });
}

if (want('cut')) {
  console.info('scene: guide with a cut-off view');
  await withPhone(cutY4m, async (page) => {
    await startLive(page);
    const panel = page.getByTestId('guide-panel');
    await panel.getByRole('button', { name: 'Guide me through instructions' }).click();
    await page.waitForFunction(() => /outside the frame|Move the phone|choose|Step 1 of/i.test(document.querySelector('[data-testid="guide-panel"]')?.textContent ?? ''), undefined, { timeout: 60_000 });
    await page.waitForTimeout(1_500);
    await shot(page, '05-guide-adjust-camera', '[data-testid="guide-panel"]');
  });
}

if (want('guide')) {
  console.info('scene: guide walkthrough');
  await withPhone(packetY4m, async (page) => {
    await startLive(page);
    const panel = page.getByTestId('guide-panel');
    await panel.getByRole('button', { name: 'Guide me through instructions' }).click();
    const microwave = panel.getByRole('button', { name: /microwave/i });
    await microwave.waitFor({ timeout: 60_000 });
    await shot(page, '06-guide-choose-method', '[data-testid="guide-panel"]');
    await microwave.click();
    await panel.getByText(/Step 1 of/).first().waitFor({ timeout: 15_000 });
    await page.waitForTimeout(4_000);
    await panel.getByRole('button', { name: /^Next/ }).click();
    await panel.getByText(/Step 2 of/).first().waitFor({ timeout: 15_000 });
    await page.waitForTimeout(3_000);
    await panel.getByTestId('guide-done').click();
    await panel.getByText(/Step 3 of/).first().waitFor({ timeout: 15_000 });
    await panel.getByText('Show source text').click();
    await page.waitForTimeout(3_000);
    await shot(page, '07-guide-walkthrough', '[data-testid="guide-panel"]');
  });
}

if (want('find')) {
  console.info('scene: object boxes + find');
  await withPhone(kitchenY4m, async (page) => {
    await startLive(page);
    await page.getByTestId('detection-overlay').waitFor({ timeout: 20_000 }).catch(() => undefined);
    await page.waitForTimeout(1_500);
    await shot(page, '08-object-boxes');
    await page.getByRole('button', { name: 'Bowl', exact: true }).click();
    await page.getByTestId('find-status').waitFor({ timeout: 20_000 });
    await page.waitForTimeout(3_000);
    await shot(page, '09-find-object', 'section.find');
  });
}
console.info(`done -> ${OUT}`);
