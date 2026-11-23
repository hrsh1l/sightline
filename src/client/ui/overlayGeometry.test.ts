import { describe, expect, it } from 'vitest';
import { contentRect, mapBoxToElement } from './overlayGeometry.js';

const full = { x: 0, y: 0, w: 1, h: 1 };

function close(actual: { x: number; y: number; width: number; height: number } | null, expected: [number, number, number, number]) {
  expect(actual).not.toBeNull();
  const a = actual!;
  expect(a.x).toBeCloseTo(expected[0], 6);
  expect(a.y).toBeCloseTo(expected[1], 6);
  expect(a.width).toBeCloseTo(expected[2], 6);
  expect(a.height).toBeCloseTo(expected[3], 6);
}

describe('contentRect', () => {
  it('returns null for invalid sizes', () => {
    expect(contentRect({ width: 0, height: 10 }, { width: 10, height: 10 }, 'contain')).toBeNull();
    expect(contentRect({ width: 10, height: 10 }, { width: 10, height: 0 }, 'cover')).toBeNull();
    expect(contentRect({ width: Number.NaN, height: 10 }, { width: 10, height: 10 }, 'cover')).toBeNull();
  });
});

describe('mapBoxToElement — contain (letterboxed)', () => {
  it('landscape source in a portrait element: bars top and bottom', () => {
    // 1280x720 scaled to width 360 -> 360x202.5, offset y = (640-202.5)/2 = 218.75
    close(mapBoxToElement(full, { width: 1280, height: 720 }, { width: 360, height: 640 }, 'contain'), [0, 218.75, 360, 202.5]);
    close(
      mapBoxToElement({ x: 0.5, y: 0.5, w: 0.25, h: 0.5 }, { width: 1280, height: 720 }, { width: 360, height: 640 }, 'contain'),
      [180, 218.75 + 101.25, 90, 101.25],
    );
  });

  it('portrait source in a landscape element: bars left and right', () => {
    // 720x1280 scaled to height 400 -> 225x400, offset x = (800-225)/2 = 287.5
    close(mapBoxToElement(full, { width: 720, height: 1280 }, { width: 800, height: 400 }, 'contain'), [287.5, 0, 225, 400]);
    close(
      mapBoxToElement({ x: 0.2, y: 0.1, w: 0.4, h: 0.3 }, { width: 720, height: 1280 }, { width: 800, height: 400 }, 'contain'),
      [287.5 + 45, 40, 90, 120],
    );
  });

  it('matching aspect: no letterbox, simple scale', () => {
    close(mapBoxToElement({ x: 0.25, y: 0.25, w: 0.5, h: 0.5 }, { width: 1600, height: 900 }, { width: 800, height: 450 }, 'contain'), [
      200, 112.5, 400, 225,
    ]);
  });

  it('portrait source in a portrait element of different aspect', () => {
    // 720x1280 (0.5625) into 400x600 (0.667): height-limited. scale=600/1280 -> 337.5x600, x offset 31.25
    close(mapBoxToElement(full, { width: 720, height: 1280 }, { width: 400, height: 600 }, 'contain'), [31.25, 0, 337.5, 600]);
  });
});

describe('mapBoxToElement — cover (cropped)', () => {
  it('landscape source in a portrait element crops the sides', () => {
    // scale = max(360/1280, 640/720) = 0.8889 -> 1137.78 x 640, x offset = (360-1137.78)/2 = -388.89
    const r = mapBoxToElement({ x: 0.45, y: 0.25, w: 0.1, h: 0.5 }, { width: 1280, height: 720 }, { width: 360, height: 640 }, 'cover');
    const w = 1280 * (640 / 720);
    const ox = (360 - w) / 2;
    close(r, [ox + 0.45 * w, 160, 0.1 * w, 320]);
  });

  it('clips boxes that extend past the visible element', () => {
    const r = mapBoxToElement({ x: 0, y: 0, w: 0.5, h: 1 }, { width: 1280, height: 720 }, { width: 360, height: 640 }, 'cover');
    const w = 1280 * (640 / 720);
    const ox = (360 - w) / 2;
    close(r, [0, 0, ox + 0.5 * w, 640]);
  });

  it('returns null for boxes entirely cropped away', () => {
    expect(mapBoxToElement({ x: 0, y: 0, w: 0.1, h: 0.1 }, { width: 1280, height: 720 }, { width: 360, height: 640 }, 'cover')).toBeNull();
  });

  it('portrait source in landscape element crops top and bottom', () => {
    // scale = max(800/720, 400/1280) = 1.111 -> 800 x 1422.2, y offset = (400-1422.2)/2
    const h = 1280 * (800 / 720);
    const oy = (400 - h) / 2;
    const r = mapBoxToElement({ x: 0.25, y: 0.45, w: 0.5, h: 0.1 }, { width: 720, height: 1280 }, { width: 800, height: 400 }, 'cover');
    close(r, [200, oy + 0.45 * h, 400, 0.1 * h]);
  });
});

describe('mapBoxToElement — robustness', () => {
  it('clamps out-of-range boxes to the image', () => {
    close(mapBoxToElement({ x: 0.9, y: 0.9, w: 0.5, h: 0.5 }, { width: 100, height: 100 }, { width: 100, height: 100 }, 'contain'), [
      90, 90, 10, 10,
    ]);
  });

  it('returns null for zero-area boxes and invalid sizes', () => {
    expect(mapBoxToElement({ x: 0.5, y: 0.5, w: 0, h: 0.2 }, { width: 100, height: 100 }, { width: 100, height: 100 }, 'contain')).toBeNull();
    expect(mapBoxToElement(full, { width: 100, height: 100 }, { width: 0, height: 0 }, 'contain')).toBeNull();
  });
});
