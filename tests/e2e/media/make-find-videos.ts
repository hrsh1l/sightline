/**
 * Builds fake-camera videos (Y4M, fed to Chromium with --use-file-for-fake-video-capture) for the REAL-detector
 * Find test. Source photo: COCO image 000000000009.jpg from the Ultralytics COCO8 sample set (downloaded on demand
 * into test-results/media, never committed; COCO images carry their Flickr licences, the COCO8 bundle is AGPL-3.0).
 *
 *   npx tsx tests/e2e/media/make-find-videos.ts
 *
 * Output (git-ignored):
 *   test-results/media/bowl-pan.y4m     640x480 @10 fps, 20 s: one bowl LEFT (0-5 s) -> slides to CENTRE (5-9 s)
 *                                        -> holds CENTRE (9-13 s) -> slides RIGHT (13-16 s) -> no bowl (16-20 s)
 *   test-results/media/three-bowls.y4m  640x480 @10 fps, 10 s: the original photo (YOLO sees three bowls)
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, openSync, writeSync, closeSync } from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';

const OUT = path.resolve('test-results/media');
const W = 640;
const H = 480;
const FPS = 10;
const COCO8_URL = 'https://github.com/ultralytics/assets/releases/download/v0.0.0/coco8.zip';

export const BOWL_PAN_TIMELINE = { leftUntil: 5, centreFrom: 9, centreUntil: 13, rightFrom: 16, emptyFrom: 16, total: 20 } as const;

async function sourcePhoto(): Promise<string> {
  const img = path.join(OUT, 'coco8/images/train/000000000009.jpg');
  if (existsSync(img)) return img;
  mkdirSync(OUT, { recursive: true });
  const zip = path.join(OUT, 'coco8.zip');
  execFileSync('curl', ['-sSL', '-o', zip, COCO8_URL]);
  execFileSync('unzip', ['-q', '-o', zip, '-d', OUT]);
  if (!existsSync(img)) throw new Error('COCO8 photo not found after download');
  return img;
}

/** RGB (W*H*3) -> I420 planar (Y, U, V), BT.601 full-range approximation. */
function toI420(rgb: Buffer): Buffer {
  const y = Buffer.alloc(W * H);
  const u = Buffer.alloc((W / 2) * (H / 2));
  const v = Buffer.alloc((W / 2) * (H / 2));
  for (let i = 0, p = 0; i < W * H; i++, p += 3) {
    y[i] = Math.max(0, Math.min(255, Math.round(0.299 * rgb[p]! + 0.587 * rgb[p + 1]! + 0.114 * rgb[p + 2]!)));
  }
  for (let by = 0; by < H / 2; by++) {
    for (let bx = 0; bx < W / 2; bx++) {
      let r = 0, g = 0, b = 0;
      for (const [dx, dy] of [[0, 0], [1, 0], [0, 1], [1, 1]] as const) {
        const p = ((by * 2 + dy) * W + (bx * 2 + dx)) * 3;
        r += rgb[p]!; g += rgb[p + 1]!; b += rgb[p + 2]!;
      }
      r /= 4; g /= 4; b /= 4;
      const k = by * (W / 2) + bx;
      u[k] = Math.max(0, Math.min(255, Math.round(-0.169 * r - 0.331 * g + 0.5 * b + 128)));
      v[k] = Math.max(0, Math.min(255, Math.round(0.5 * r - 0.419 * g - 0.081 * b + 128)));
    }
  }
  return Buffer.concat([y, u, v]);
}

async function writeY4m(file: string, frames: number, frameAt: (i: number) => Promise<Buffer>) {
  const fd = openSync(file, 'w');
  writeSync(fd, `YUV4MPEG2 W${W} H${H} F${FPS}:1 Ip A1:1 C420jpeg\n`);
  let cacheKey = '';
  let cache: Buffer | null = null;
  for (let i = 0; i < frames; i++) {
    const rgb = await frameAt(i);
    const key = createHash('sha1').update(rgb).digest('hex'); // reuse conversion for identical consecutive frames
    if (key !== cacheKey || !cache) {
      cache = toI420(rgb);
      cacheKey = key;
    }
    writeSync(fd, 'FRAME\n');
    writeSync(fd, cache);
  }
  closeSync(fd);
}

export async function makeFindVideos(): Promise<{ bowlPan: string; threeBowls: string }> {
  mkdirSync(OUT, { recursive: true });
  const photo = await sourcePhoto();
  const bowlPan = path.join(OUT, 'bowl-pan.y4m');
  const threeBowls = path.join(OUT, 'three-bowls.y4m');
  // Cut out the clearest bowl (YOLO 0.88 on the original) and place it on a plain counter colour.
  const bowl = await sharp(photo).extract({ left: 311, top: 0, width: 320, height: 237 }).resize(240).toBuffer();
  const bowlW = 240;
  const xLeft = 20; // centre x ~0.22 of the frame
  const xCentre = (W - bowlW) / 2; // ~0.50
  const xRight = W - bowlW - 20; // ~0.78
  const raw = async (x: number | null) => {
    const base = sharp({ create: { width: W, height: H, channels: 3, background: '#c9b79c' } });
    const img = x === null ? base : base.composite([{ input: bowl, left: Math.round(x), top: 150 }]);
    return img.removeAlpha().raw().toBuffer();
  };
  const lerp = (a: number, b: number, t: number) => a + (b - a) * Math.min(1, Math.max(0, t));
  const T = BOWL_PAN_TIMELINE;
  await writeY4m(bowlPan, T.total * FPS, async (i) => {
    const t = i / FPS;
    if (t < T.leftUntil) return raw(xLeft);
    if (t < T.centreFrom) return raw(lerp(xLeft, xCentre, (t - T.leftUntil) / (T.centreFrom - T.leftUntil)));
    if (t < T.centreUntil) return raw(xCentre);
    if (t < T.rightFrom) return raw(lerp(xCentre, xRight, (t - T.centreUntil) / (T.rightFrom - T.centreUntil)));
    return raw(null);
  });
  const photoRgb = await sharp(photo).resize(W, H, { fit: 'fill' }).removeAlpha().raw().toBuffer();
  await writeY4m(threeBowls, 10 * FPS, async () => photoRgb);
  return { bowlPan, threeBowls };
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve('tests/e2e/media/make-find-videos.ts')) {
  makeFindVideos().then((r) => console.info('wrote', r), (e: unknown) => {
    console.error(e);
    process.exit(1);
  });
}
