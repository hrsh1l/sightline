/**
 * Cheap client-side frame statistics (pure functions, no DOM).
 *
 * These numbers are the ONLY client-side grounds for the assistant to say a frame is "too dark" or
 * "blurry" (otherwise it must rely on the vision model's own analysis of the actual image).
 *
 * Both statistics are computed on a small grayscale copy (<= ANALYSIS_MAX_SIDE px on the longest side)
 * so they are cheap and roughly comparable across capture resolutions. The absolute scale is
 * device-dependent (sensor noise, ISP sharpening, JPEG compression, scene content), so the thresholds
 * below are deliberately conservative heuristics: they should only fire for frames that are almost
 * certainly unusable, and they have not been calibrated on a Galaxy S25.
 */
import type { FrameQuality } from '../../shared/protocol.js';

/** Anything shaped like ImageData (RGBA, 4 bytes per pixel, row-major). */
export interface ImageDataLike {
  readonly data: ArrayLike<number>;
  readonly width: number;
  readonly height: number;
}

export interface GrayImage {
  /** Luma 0..255, row-major. */
  readonly data: Float32Array;
  readonly width: number;
  readonly height: number;
}

/** Longest side of the analysis copy. */
export const ANALYSIS_MAX_SIDE = 128;

/**
 * Conservative, device-dependent heuristics. Do not treat as calibrated measurements.
 * - tooDarkMeanLuma: mean luma below this is a near-black frame (lens covered, lights off).
 * - tooBrightMeanLuma: mean luma above this is a near-white, blown-out frame.
 * - blurrySharpness: Laplacian variance below this means almost no edges at analysis scale.
 *   Note a plain featureless surface (blank wall, sheet of paper) also scores low; callers should say
 *   "blurry or featureless", not assert motion blur.
 */
export const QUALITY_THRESHOLDS = {
  tooDarkMeanLuma: 30,
  tooBrightMeanLuma: 245,
  blurrySharpness: 15,
} as const;

/**
 * Convert RGBA to luma (Rec. 601) and area-average down so the longest side is <= maxSide.
 * Never upscales.
 */
export function toGrayscale(img: ImageDataLike, maxSide: number = ANALYSIS_MAX_SIDE): GrayImage {
  const { width: sw, height: sh, data } = img;
  if (sw <= 0 || sh <= 0) return { data: new Float32Array(0), width: 0, height: 0 };
  const scale = Math.min(1, maxSide / Math.max(sw, sh));
  const dw = Math.max(1, Math.round(sw * scale));
  const dh = Math.max(1, Math.round(sh * scale));
  const out = new Float32Array(dw * dh);
  const counts = new Uint32Array(dw * dh);
  for (let y = 0; y < sh; y++) {
    const dy = Math.min(dh - 1, Math.floor((y * dh) / sh));
    for (let x = 0; x < sw; x++) {
      const dx = Math.min(dw - 1, Math.floor((x * dw) / sw));
      const i = (y * sw + x) * 4;
      const luma = 0.299 * (data[i] ?? 0) + 0.587 * (data[i + 1] ?? 0) + 0.114 * (data[i + 2] ?? 0);
      const o = dy * dw + dx;
      out[o] = (out[o] ?? 0) + luma;
      counts[o] = (counts[o] ?? 0) + 1;
    }
  }
  for (let o = 0; o < out.length; o++) out[o] = (out[o] ?? 0) / Math.max(1, counts[o] ?? 1);
  return { data: out, width: dw, height: dh };
}

/** Mean luma 0..255. */
export function meanLuma(gray: GrayImage): number {
  const n = gray.data.length;
  if (n === 0) return 0;
  let sum = 0;
  for (let i = 0; i < n; i++) sum += gray.data[i] ?? 0;
  return clamp(sum / n, 0, 255);
}

/**
 * Variance of the 4-neighbour Laplacian over interior pixels. Higher = more edges / sharper.
 * Returns 0 for images smaller than 3x3.
 */
export function laplacianVariance(gray: GrayImage): number {
  const { width: w, height: h, data } = gray;
  if (w < 3 || h < 3) return 0;
  let sum = 0;
  let sumSq = 0;
  let n = 0;
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const v =
        (data[i - w] ?? 0) + (data[i + w] ?? 0) + (data[i - 1] ?? 0) + (data[i + 1] ?? 0) - 4 * (data[i] ?? 0);
      sum += v;
      sumSq += v * v;
      n++;
    }
  }
  const mean = sum / n;
  const variance = sumSq / n - mean * mean;
  return Number.isFinite(variance) ? Math.max(0, variance) : 0;
}

/** Both statistics, rounded to 2 decimals (keeps payloads tidy; precision beyond that is meaningless). */
export function computeFrameQuality(img: ImageDataLike, maxSide: number = ANALYSIS_MAX_SIDE): FrameQuality {
  const gray = toGrayscale(img, maxSide);
  return { meanLuma: round2(meanLuma(gray)), sharpness: round2(laplacianVariance(gray)) };
}

/** Conservative heuristic; see QUALITY_THRESHOLDS. */
export function isLikelyTooDark(q: FrameQuality): boolean {
  return q.meanLuma < QUALITY_THRESHOLDS.tooDarkMeanLuma;
}

/** Conservative heuristic; see QUALITY_THRESHOLDS. */
export function isLikelyTooBright(q: FrameQuality): boolean {
  return q.meanLuma > QUALITY_THRESHOLDS.tooBrightMeanLuma;
}

/**
 * Conservative heuristic; see QUALITY_THRESHOLDS. A dark frame naturally has few edges, so darkness
 * is reported instead of blur when both apply.
 */
export function isLikelyBlurry(q: FrameQuality): boolean {
  return !isLikelyTooDark(q) && q.sharpness < QUALITY_THRESHOLDS.blurrySharpness;
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

function round2(v: number): number {
  return Math.round(v * 100) / 100;
}
