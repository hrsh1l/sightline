/**
 * Detail reading helpers for small print. OWNER: vision agent.
 *
 * Why: Gemini spends a fixed token budget per image part (LOW 280, MEDIUM 560, HIGH 1120, ULTRA_HIGH 2240 tokens),
 * whatever its pixel count. A small ingredients panel or date code inside a 4000 px photo therefore gets only a
 * sliver of that budget. Two-pass reading fixes this:
 *   pass 1  a downscaled overview (<= DETAIL.overviewMaxSide, HIGH) -> boxes of printed text regions (box_2d 0..1000)
 *   crops   each region cut from the FULL-resolution frame with sharp (padded, clamped, <= DETAIL.maxCropSide)
 *   pass 2  overview (HIGH) + every crop (ULTRA_HIGH) in one extraction call.
 *
 * Everything here is pure geometry or local image processing; the provider calls live in GeminiVision.ts.
 * Nothing is rotated: the client already encodes frames upright and un-mirrored.
 */
import sharp from 'sharp';

type SharpPipeline = ReturnType<typeof sharp>;

export const DETAIL = {
  /** Frames whose longest side is below this skip pass 1 (crops would not add resolution). */
  minTwoPassSide: 1_200,
  /** Overview sent to pass 1 and pass 2. */
  overviewMaxSide: 1_536,
  overviewJpegQuality: 85,
  maxRegions: 6,
  /** Padding on each side: max(padFraction x box size, minPadFraction x image size) on the same axis. */
  padFraction: 0.08,
  /** Gemini boxes are only accurate to roughly +-1% of the image, so a tight box can clip characters. */
  minPadFraction: 0.01,
  /** Padded crops narrower or shorter than this (px) are skipped. */
  minCropSide: 24,
  maxCropSide: 2_048,
  cropJpegQuality: 90,
  /** Crops overlapping an earlier crop by more than this IoU are dropped as duplicates. */
  duplicateIoU: 0.85,
  /** Inline request budget (base64 chars of all images). The API limit for inline requests is 20 MB. */
  maxInlineBase64Chars: 18_000_000,
} as const;

export const REGION_KINDS = [
  'product_name',
  'ingredients',
  'allergens',
  'cooking_instructions',
  'dates_codes',
  'nutrition',
  'storage',
  'warnings',
  'other_text',
] as const;
export type RegionKind = (typeof REGION_KINDS)[number];

/** Human wording used in the "Crop i of n (... region)" label. */
export const REGION_KIND_LABEL: Record<RegionKind, string> = {
  product_name: 'product name',
  ingredients: 'ingredients',
  allergens: 'allergens',
  cooking_instructions: 'cooking instructions',
  dates_codes: 'dates and codes',
  nutrition: 'nutrition',
  storage: 'storage',
  warnings: 'warnings',
  other_text: 'other text',
};

const box2dSchema = {
  type: 'array',
  minItems: 4,
  maxItems: 4,
  items: { type: 'integer' },
  description: '[ymin, xmin, ymax, xmax] normalized to 0-1000 relative to the image.',
} as const;

/** Pass-1 structured output. */
export const REGION_RESPONSE_SCHEMA = {
  type: 'object',
  properties: {
    regions: {
      type: 'array',
      maxItems: DETAIL.maxRegions,
      items: {
        type: 'object',
        properties: {
          box_2d: box2dSchema,
          kind: { type: 'string', enum: [...REGION_KINDS] },
        },
        required: ['box_2d', 'kind'],
      },
    },
  },
  required: ['regions'],
} as const;

/** Gemini box in its native convention: 0..1000, relative to the image. */
export interface Box2d {
  ymin: number;
  xmin: number;
  ymax: number;
  xmax: number;
}

/**
 * Validate a model box_2d: exactly 4 finite numbers within [0, 1000], ymin < ymax and xmin < xmax.
 * Swapped, degenerate or out-of-range boxes are rejected (never "repaired" into a guess).
 */
export function parseBox2d(v: unknown): Box2d | null {
  if (!Array.isArray(v) || v.length !== 4) return null;
  if (!v.every((n) => typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= 1000)) return null;
  const [ymin, xmin, ymax, xmax] = v as [number, number, number, number];
  if (!(ymin < ymax && xmin < xmax)) return null;
  return { ymin, xmin, ymax, xmax };
}

export interface CropRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** Pixel crop for a box on a width x height image, padded and clamped. null = too small after padding. */
export function cropRectFor(box: Box2d, width: number, height: number): CropRect | null {
  const x0 = (box.xmin / 1000) * width;
  const x1 = (box.xmax / 1000) * width;
  const y0 = (box.ymin / 1000) * height;
  const y1 = (box.ymax / 1000) * height;
  const padX = Math.max(DETAIL.padFraction * (x1 - x0), DETAIL.minPadFraction * width);
  const padY = Math.max(DETAIL.padFraction * (y1 - y0), DETAIL.minPadFraction * height);
  const left = Math.max(0, Math.floor(x0 - padX));
  const top = Math.max(0, Math.floor(y0 - padY));
  const right = Math.min(width, Math.ceil(x1 + padX));
  const bottom = Math.min(height, Math.ceil(y1 + padY));
  const rect = { left, top, width: right - left, height: bottom - top };
  if (rect.width < DETAIL.minCropSide || rect.height < DETAIL.minCropSide) return null;
  return rect;
}

export function iou(a: CropRect, b: CropRect): number {
  const ix = Math.max(0, Math.min(a.left + a.width, b.left + b.width) - Math.max(a.left, b.left));
  const iy = Math.max(0, Math.min(a.top + a.height, b.top + b.height) - Math.max(a.top, b.top));
  const inter = ix * iy;
  const union = a.width * a.height + b.width * b.height - inter;
  return union > 0 ? inter / union : 0;
}

export interface PlannedCrop {
  rect: CropRect;
  kind: RegionKind;
}

/**
 * Validate pass-1 output and turn it into crop rectangles, keeping the model's order (most relevant first),
 * dropping invalid boxes, tiny crops and near-duplicates, at most DETAIL.maxRegions.
 */
export function planCrops(raw: unknown, width: number, height: number): PlannedCrop[] {
  const regions = raw && typeof raw === 'object' && Array.isArray((raw as { regions?: unknown }).regions) ? (raw as { regions: unknown[] }).regions : [];
  const out: PlannedCrop[] = [];
  for (const r of regions) {
    if (out.length >= DETAIL.maxRegions) break;
    if (!r || typeof r !== 'object') continue;
    const box = parseBox2d((r as { box_2d?: unknown }).box_2d);
    if (!box) continue;
    const rect = cropRectFor(box, width, height);
    if (!rect) continue;
    if (out.some((c) => iou(c.rect, rect) > DETAIL.duplicateIoU)) continue;
    const k = (r as { kind?: unknown }).kind;
    const kind = (REGION_KINDS as readonly unknown[]).includes(k) ? (k as RegionKind) : 'other_text';
    out.push({ rect, kind });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Image processing (sharp)
// ---------------------------------------------------------------------------

export interface DecodedImage {
  data: Buffer;
  width: number;
  height: number;
  channels: 1 | 2 | 3 | 4;
}

export interface EncodedImage {
  /** Base64 JPEG, no data: prefix. */
  data: string;
  width: number;
  height: number;
}

/**
 * Decode a base64 JPEG once to raw pixels so several crops do not re-decode the full frame. The input comes from
 * the client, so the pixel count is capped (a small JPEG can declare huge dimensions): 25 MP covers a 4096 x 4096
 * detail still with margin (~75 MB raw RGB).
 */
export const MAX_DECODE_PIXELS = 25_000_000;

export async function decodeImage(base64: string): Promise<DecodedImage> {
  const { data, info } = await sharp(Buffer.from(base64, 'base64'), { limitInputPixels: MAX_DECODE_PIXELS })
    .raw()
    .toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height, channels: info.channels };
}

function fromRaw(img: DecodedImage): SharpPipeline {
  return sharp(img.data, { raw: { width: img.width, height: img.height, channels: img.channels } });
}

function fitInside(width: number, height: number, maxSide: number): { width: number; height: number } {
  const scale = Math.min(1, maxSide / Math.max(width, height));
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

async function toJpeg(pipeline: SharpPipeline, quality: number): Promise<EncodedImage> {
  const { data, info } = await pipeline.jpeg({ quality, mozjpeg: false }).toBuffer({ resolveWithObject: true });
  return { data: data.toString('base64'), width: info.width, height: info.height };
}

/** Downscaled copy (never upscaled) for pass 1 and as the pass-2 overview. */
export function encodeOverview(img: DecodedImage, maxSide: number = DETAIL.overviewMaxSide, quality: number = DETAIL.overviewJpegQuality): Promise<EncodedImage> {
  const size = fitInside(img.width, img.height, maxSide);
  let p = fromRaw(img);
  if (size.width !== img.width || size.height !== img.height) p = p.resize(size.width, size.height, { fit: 'fill' });
  return toJpeg(p, quality);
}

/** Crop at native resolution; only downscaled when its longest side exceeds maxSide. */
export function encodeCrop(img: DecodedImage, rect: CropRect, maxSide: number = DETAIL.maxCropSide, quality: number = DETAIL.cropJpegQuality): Promise<EncodedImage> {
  const size = fitInside(rect.width, rect.height, maxSide);
  let p = fromRaw(img).extract(rect);
  if (size.width !== rect.width || size.height !== rect.height) p = p.resize(size.width, size.height, { fit: 'fill' });
  return toJpeg(p, quality);
}
