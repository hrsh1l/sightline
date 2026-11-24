/**
 * LIVE end-to-end dialogue against a running Sightline server (default http://localhost:3000) with REAL Gemini Live
 * and REAL guide extraction. The "camera" answers snapshot requests with SYNTHETIC packet photos (first cut off,
 * then complete). User turns are typed text. Uses API quota (1 Live session + ~4 vision calls).
 *   npx tsx scripts/live-guide-dialogue.ts [baseUrl]
 */
import WebSocket from 'ws';
import sharp from 'sharp';
import type { ClientMessage, ServerMessage } from '../src/shared/protocol.js';

const base = process.argv[2] ?? 'http://localhost:3000';
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
const LINES = [
  ['COOKING INSTRUCTIONS', 26, 1], ['MICROWAVE (800W)', 20, 1], ['1. Pierce film several times.', 17, 0],
  ['2. Heat on full power for 3 minutes.', 17, 0], ['3. Stir, re-cover and heat for 1 minute 30 seconds.', 17, 0],
  ['4. Stand for 1 minute before serving.', 17, 0], ['OVEN 190°C / Fan 170°C / Gas 5', 20, 1],
  ['1. Remove film and cover with foil.', 17, 0], ['2. Cook for 25 minutes. Stir halfway.', 17, 0],
  ['Caution: contents will be hot.', 15, 0],
] as const;
async function packet(cut: boolean) {
  let y = 50;
  const text = LINES.map(([t, size, bold]) => {
    const el = `<text x="40" y="${y}" font-family="Helvetica, Arial" font-size="${size}" font-weight="${bold ? 700 : 400}" fill="#111">${esc(t)}</text>`;
    y += size + 20;
    return el;
  }).join('');
  const lh = y + 20;
  const label = await sharp(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="1000" height="${lh}"><rect width="100%" height="100%" fill="#f6f1e6"/>${text}</svg>`)).png().toBuffer();
  const full = await sharp({ create: { width: 2400, height: 1800, channels: 3, background: '#7c6248' } }).composite([{ input: label, left: 700, top: 300 }]).jpeg({ quality: 90 }).toBuffer();
  if (!cut) return { data: full, w: 2400, h: 1800 };
  const keep = Math.round(300 + lh * 0.42);
  return { data: await sharp(full).extract({ left: 0, top: 0, width: 2400, height: keep }).jpeg({ quality: 90 }).toBuffer(), w: 2400, h: keep };
}

const ws = new WebSocket(base.replace(/^http/, 'ws') + '/ws', { headers: { Origin: base } });
const inbox: ServerMessage[] = [];
let frameId = 1000;
let snapshots = 0;
const send = (m: ClientMessage) => ws.send(JSON.stringify(m));
const t0 = Date.now();
const ts = () => ((Date.now() - t0) / 1000).toFixed(1).padStart(5);

ws.on('message', async (raw) => {
  const m = JSON.parse(raw.toString()) as ServerMessage;
  inbox.push(m);
  if (m.type === 'snapshot.request') {
    const img = await packet(snapshots++ === 0);
    console.info(`${ts()} [camera] snapshot for ${m.purpose} -> ${snapshots === 1 ? 'CUT-OFF' : 'FULL'} packet photo`);
    send({ type: 'snapshot.result', requestId: m.requestId, frame: { frameId: ++frameId, capturedAt: Date.now(), width: img.w, height: img.h, mimeType: 'image/jpeg', data: img.data.toString('base64') } });
  } else if (m.type === 'tool') console.info(`${ts()} [tool] ${m.name} ${m.state}`);
  else if (m.type === 'guide') {
    const g = m.guide;
    const cur = g.currentIndex !== null ? g.steps[g.currentIndex] : null;
    console.info(`${ts()} [guide v${g.version}] ${g.phase}${g.section ? ` · ${g.section.title}` : ''}${cur ? ` · step ${g.currentIndex! + 1}/${g.steps.length}` : ''} · confirmed=[${g.confirmations.join(',')}]${g.adjustment ? ` · adj="${g.adjustment}"` : ''}`);
  } else if (m.type === 'error') console.info(`${ts()} [error] ${m.code}: ${m.message}`);
});

function turnText(since: number) {
  return inbox.slice(since).filter((m): m is Extract<ServerMessage, { type: 'transcript' }> => m.type === 'transcript' && m.role === 'assistant').map((m) => m.text).join('');
}
async function say(text: string, timeoutMs = 45_000) {
  const since = inbox.length;
  console.info(`\n${ts()} USER: ${text}`);
  send({ type: 'text', requestId: `t${Date.now()}`, text });
  const start = Date.now();
  // Wait until an assistant turn completes after at least some assistant output (or timeout).
  while (Date.now() - start < timeoutMs) {
    await new Promise((r) => setTimeout(r, 200));
    const done = inbox.slice(since).some((m) => m.type === 'turn' && m.event === 'complete');
    if (done && turnText(since).trim()) break;
  }
  await new Promise((r) => setTimeout(r, 400));
  console.info(`${ts()} SIGHTLINE: ${turnText(since).trim() || '(no transcript)'}`);
}

ws.on('open', async () => {
  send({ type: 'hello', protocolVersion: 1, mode: 'live', settings: { pushToTalk: false, detections: false }, clientTime: Date.now() });
  while (!inbox.some((m) => m.type === 'ready')) await new Promise((r) => setTimeout(r, 100));
  console.info(`${ts()} ready`);
  await say('Guide me through these instructions.');
  await say('How about now?');
  await say('The microwave ones please.');
  await say('Wait, what does pierce the film mean?');
  await say('Next.');
  await say("Done, I've finished this step.");
  await say('Do I say done when it has stood?');
  await say('Where were we?');
  await say('Stop the guide.');
  send({ type: 'bye' });
  ws.close();
});
ws.on('close', () => process.exit(0));
ws.on('error', (e) => {
  console.error('ws error', e.message);
  process.exit(1);
});
