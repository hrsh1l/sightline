/**
 * Pure geometry for drawing detector boxes over a <video> rendered with object-fit.
 *
 * Boxes are normalised (0..1) relative to the source image as sent (top-left origin, never mirrored).
 * The element shows that image scaled with `object-fit: contain` (letterboxed) or `cover` (cropped).
 * The returned rectangle is in element CSS pixels, clipped to the element bounds.
 */
import type { NormalizedBox } from '../../shared/protocol.js';

export interface Size {
  width: number;
  height: number;
}

export interface PixelRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export type ObjectFit = 'contain' | 'cover';

/** Where the scaled source image sits inside the element (may extend beyond it for `cover`). */
export function contentRect(source: Size, element: Size, fit: ObjectFit): PixelRect | null {
  if (!(source.width > 0 && source.height > 0 && element.width > 0 && element.height > 0)) return null;
  const sx = element.width / source.width;
  const sy = element.height / source.height;
  const scale = fit === 'contain' ? Math.min(sx, sy) : Math.max(sx, sy);
  const width = source.width * scale;
  const height = source.height * scale;
  return { x: (element.width - width) / 2, y: (element.height - height) / 2, width, height };
}

const clamp01 = (n: number) => (Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0);

/**
 * Map a normalised box to element pixels. Returns null when sizes are invalid or when the box
 * lies entirely outside the visible element (possible with `cover`).
 */
export function mapBoxToElement(box: NormalizedBox, source: Size, element: Size, fit: ObjectFit): PixelRect | null {
  const content = contentRect(source, element, fit);
  if (!content) return null;
  const x0n = clamp01(box.x);
  const y0n = clamp01(box.y);
  const x1n = clamp01(box.x + box.w);
  const y1n = clamp01(box.y + box.h);
  const x0 = Math.max(0, content.x + x0n * content.width);
  const y0 = Math.max(0, content.y + y0n * content.height);
  const x1 = Math.min(element.width, content.x + x1n * content.width);
  const y1 = Math.min(element.height, content.y + y1n * content.height);
  if (x1 <= x0 || y1 <= y0) return null;
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
}
