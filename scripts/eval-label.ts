/**
 * Live accuracy probe for label reading, using a SYNTHETIC packet-back image (generated here, clearly not a real
 * product). Sends real requests to the configured Gemini models; prints which ground-truth facts were recovered.
 *
 *   npx tsx scripts/eval-label.ts            # detail (two-pass) on a 4000x3000 photo vs single pass at 1190 px
 *
 * Synthetic text is not proof of real-packaging accuracy; use it to compare pipeline variants.
 */
import dotenv from 'dotenv';
import sharp from 'sharp';
import { GoogleGenAI } from '@google/genai';
import { loadConfig } from '../src/server/config.js';
import { createMemoryLogger } from '../src/server/log.js';
import { createGeminiVision } from '../src/server/vision/GeminiVision.js';
import type { FramePayload, LabelEvidence } from '../src/shared/protocol.js';

dotenv.config({ quiet: true });
const config = loadConfig();
if (!config.geminiApiKey) {
  console.error('GEMINI_API_KEY not set');
  process.exit(2);
}

const LABEL_LINES = [
  { t: 'CHICKPEA & SPINACH CURRY', size: 34, bold: true },
  { t: 'INGREDIENTS: Water, Chickpeas (24%), Spinach (12%), Onion, Tomato Paste,', size: 15 },
  { t: 'Rapeseed Oil, Ginger Purée, Garlic Purée, Salt, Cumin, Coriander, Turmeric.', size: 15 },
  { t: 'ALLERGY ADVICE: May contain MUSTARD.', size: 15, bold: true },
  { t: 'MICROWAVE (800W): Pierce film. Heat on full power for 3 minutes.', size: 15 },
  { t: 'Stir, re-cover and heat for a further 1 minute 30 seconds. Stand for 1 minute.', size: 15 },
  { t: 'OVEN: 190°C / Fan 170°C / Gas 5. Remove film, cover with foil, 25 minutes.', size: 15 },
  { t: 'Keep refrigerated below 5°C. Once opened, use within 24 hours.', size: 15 },
  { t: 'BEST BEFORE END: 03 2027', size: 17, bold: true },
  { t: 'L4127 14:32', size: 13 },
];
const FACTS: { name: string; re: RegExp }[] = [
  { name: 'product name', re: /chickpea\s*&?\s*(and\s*)?spinach curry/i },
  { name: 'chickpeas 24%', re: /chickpeas\s*\(24\s*%\)/i },
  { name: 'turmeric', re: /turmeric/i },
  { name: 'mustard allergy', re: /mustard/i },
  { name: 'microwave 800W', re: /800\s*w/i },
  { name: 'microwave 3 minutes', re: /3 minutes/i },
  { name: '1 minute 30 seconds', re: /1 minute 30 seconds/i },
  { name: 'oven 190°C', re: /190\s*°?\s*c/i },
  { name: 'gas 5', re: /gas\s*5/i },
  { name: 'use within 24 hours', re: /24 hours/i },
  { name: 'printed date', re: /03\s*2027/ },
  { name: 'batch code kept', re: /L4127/ },
];

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');

async function makePhoto(width: number, height: number): Promise<Buffer> {
  // Label panel ~900x420 px placed off-centre on a 4000x3000 "counter"; small print ~15 px high.
  const lw = 900;
  const lh = 420;
  let y = 44;
  const text = LABEL_LINES.map((l) => {
    const el = `<text x="24" y="${y}" font-family="Helvetica, Arial, sans-serif" font-size="${l.size}" font-weight="${l.bold ? 700 : 400}" fill="#111">${esc(l.t)}</text>`;
    y += l.size + 18;
    return el;
  }).join('');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${lw}" height="${lh}"><rect width="100%" height="100%" rx="10" fill="#f4efe3"/>${text}</svg>`;
  const label = await sharp(Buffer.from(svg)).png().toBuffer();
  const base = sharp({ create: { width: 4000, height: 3000, channels: 3, background: '#8a6a4a' } });
  const full = await base.composite([{ input: label, left: 2300, top: 1500 }]).jpeg({ quality: 92 }).toBuffer();
  return width === 4000 ? full : sharp(full).resize(width, height).jpeg({ quality: 88 }).toBuffer();
}

function score(ev: LabelEvidence) {
  const all = [
    ...ev.exactText.map((t) => t.text),
    ...ev.instructions.flatMap((i) => [i.method, ...i.steps]),
    ...ev.dates.map((d) => d.printedText),
    ...ev.batchCodes,
  ].join('\n');
  const hits = FACTS.filter((f) => f.re.test(all)).map((f) => f.name);
  const miss = FACTS.filter((f) => !f.re.test(all)).map((f) => f.name);
  const batchAsDate = ev.dates.some((d) => /L4127/.test(d.printedText));
  return { hits, miss, batchAsDate };
}

const ai = new GoogleGenAI({ apiKey: config.geminiApiKey, httpOptions: { apiVersion: 'v1beta' } });

for (const [label, w, h] of [
  ['detail: 4000x3000 two-pass', 4000, 3000],
  ['baseline: 1190x893 single pass', 1190, 893],
] as const) {
  const log = createMemoryLogger();
  const vision = createGeminiVision({ ai, config, log });
  const jpeg = await makePhoto(w, h);
  const frame: FramePayload = { frameId: 1, capturedAt: Date.now(), width: w, height: h, mimeType: 'image/jpeg', data: jpeg.toString('base64') };
  const t0 = performance.now();
  try {
    const ev = await vision.extractLabel({ frame, now: new Date(), focus: undefined });
    const s = score(ev);
    const meta = log.events.find((e) => e.event === 'vision_extract')?.fields ?? {};
    console.info(`\n== ${label}: ${Math.round(performance.now() - t0)} ms, model ${ev.model}, readability ${ev.readability}`);
    console.info(`   facts recovered ${s.hits.length}/${FACTS.length}; missing: ${s.miss.join(', ') || 'none'}; batch code treated as date: ${s.batchAsDate}`);
    console.info(`   dates: ${ev.dates.map((d) => `${d.printedText} [${d.labelType}] -> ${d.interpretation.status} ${d.interpretation.isoDate ?? ''} ${d.interpretation.comparison}`).join('; ')}`);
    console.info(`   pipeline: ${JSON.stringify(meta)}`);
  } catch (err) {
    console.error(`\n== ${label}: FAILED after ${Math.round(performance.now() - t0)} ms: ${err instanceof Error ? err.message : String(err)}`);
    console.error(`   log: ${JSON.stringify(log.events.slice(-3))}`);
  }
}
