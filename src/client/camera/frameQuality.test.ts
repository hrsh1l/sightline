import { describe, expect, it } from 'vitest';
import {
  ANALYSIS_MAX_SIDE,
  computeFrameQuality,
  isLikelyBlurry,
  isLikelyTooBright,
  isLikelyTooDark,
  laplacianVariance,
  meanLuma,
  toGrayscale,
  type ImageDataLike,
} from './frameQuality.js';
import { bytesToBase64 } from './surface.js';

function image(width: number, height: number, pixel: (x: number, y: number) => [number, number, number]): ImageDataLike {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const [r, g, b] = pixel(x, y);
      const i = (y * width + x) * 4;
      data[i] = r;
      data[i + 1] = g;
      data[i + 2] = b;
      data[i + 3] = 255;
    }
  }
  return { data, width, height };
}

const solid = (v: number) => image(64, 48, () => [v, v, v]);
const checker = (size: number, cell: number) =>
  image(size, size, (x, y) => ((Math.floor(x / cell) + Math.floor(y / cell)) % 2 === 0 ? [0, 0, 0] : [255, 255, 255]));

describe('frameQuality', () => {
  it('black frame: luma 0, no edges, flagged too dark (not blurry)', () => {
    const q = computeFrameQuality(solid(0));
    expect(q).toEqual({ meanLuma: 0, sharpness: 0 });
    expect(isLikelyTooDark(q)).toBe(true);
    expect(isLikelyBlurry(q)).toBe(false);
    expect(isLikelyTooBright(q)).toBe(false);
  });

  it('white frame: luma 255, no edges, flagged too bright and featureless', () => {
    const q = computeFrameQuality(solid(255));
    expect(q.meanLuma).toBeCloseTo(255, 1);
    expect(q.sharpness).toBe(0);
    expect(isLikelyTooBright(q)).toBe(true);
    expect(isLikelyTooDark(q)).toBe(false);
    expect(isLikelyBlurry(q)).toBe(true);
  });

  it('checkerboard: mid luma and very high sharpness', () => {
    const q = computeFrameQuality(checker(64, 1));
    expect(q.meanLuma).toBeCloseTo(127.5, 0);
    expect(q.sharpness).toBeGreaterThan(100_000);
    expect(isLikelyBlurry(q)).toBe(false);
    expect(isLikelyTooDark(q)).toBe(false);
  });

  it('a larger checkerboard is downscaled to the analysis size and stays sharp', () => {
    const big = checker(512, 8);
    const gray = toGrayscale(big);
    expect(Math.max(gray.width, gray.height)).toBe(ANALYSIS_MAX_SIDE);
    expect(meanLuma(gray)).toBeCloseTo(127.5, 0);
    expect(laplacianVariance(gray)).toBeGreaterThan(1_000);
  });

  it('uses Rec. 601 luma weights', () => {
    const red = computeFrameQuality(image(8, 8, () => [255, 0, 0]));
    expect(red.meanLuma).toBeCloseTo(0.299 * 255, 1);
  });

  it('handles degenerate sizes', () => {
    expect(computeFrameQuality({ data: new Uint8ClampedArray(0), width: 0, height: 0 })).toEqual({ meanLuma: 0, sharpness: 0 });
    expect(computeFrameQuality(image(2, 2, () => [10, 10, 10])).sharpness).toBe(0);
  });
});

describe('bytesToBase64', () => {
  it('encodes without a data: prefix, including inputs larger than one chunk', () => {
    expect(bytesToBase64(new Uint8Array([65, 66, 67]))).toBe('QUJD');
    const big = new Uint8Array(100_000).map((_, i) => i % 256);
    expect(bytesToBase64(big)).toBe(btoa(Array.from(big, (c) => String.fromCharCode(c)).join('')));
  });
});
