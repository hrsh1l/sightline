/**
 * Find-mode box detection helpers (schema + conversion). OWNER: vision agent. The provider call is in GeminiVision.ts.
 *
 * Gemini returns box_2d = [ymin, xmin, ymax, xmax] normalised to 0..1000. We convert to NormalizedBox {x, y, w, h}
 * in 0..1 and drop anything invalid. Boxes are never invented or repaired.
 */
import { NormalizedBox } from '../../shared/protocol.js';
import { parseBox2d } from './detailRead.js';
import { servingSchema } from './servingSchema.js';

export const LOCATE = {
  maxBoxes: 5,
  /** Boxes thinner than this (fraction of the image) on either axis are dropped as degenerate. */
  minSide: 0.005,
  labelChars: 80,
  /** Used when the model omits confidence. */
  defaultScore: 0.5,
  timeoutMs: 6_000,
  maxOutputTokens: 2_048,
} as const;

export const LOCATE_RESPONSE_SCHEMA = servingSchema({
  type: 'object',
  properties: {
    found: {
      type: 'array',
      maxItems: LOCATE.maxBoxes,
      description: 'Only the requested item(s). Empty if not clearly visible.',
      items: {
        type: 'object',
        properties: {
          label: { type: 'string', description: 'The item name as visible, e.g. "salt shaker".' },
          box_2d: {
            type: 'array',
            minItems: 4,
            maxItems: 4,
            items: { type: 'integer' },
            description: '[ymin, xmin, ymax, xmax] normalized to 0-1000.',
          },
          confidence: { type: 'number', minimum: 0, maximum: 1, description: 'How sure you are that this is the requested item, 0 to 1.' },
        },
        required: ['label', 'box_2d', 'confidence'],
      },
    },
  },
  required: ['found'],
} as const);

export interface LocatedBox {
  label: string;
  box: NormalizedBox;
  score: number;
}

/** Convert one Gemini box_2d to a NormalizedBox; null when invalid/degenerate. */
export function box2dToNormalized(v: unknown): NormalizedBox | null {
  const b = parseBox2d(v);
  if (!b) return null;
  const box = { x: b.xmin / 1000, y: b.ymin / 1000, w: (b.xmax - b.xmin) / 1000, h: (b.ymax - b.ymin) / 1000 };
  if (box.w < LOCATE.minSide || box.h < LOCATE.minSide) return null;
  const parsed = NormalizedBox.safeParse(box);
  return parsed.success ? parsed.data : null;
}

/** Validate the model's locate JSON into at most LOCATE.maxBoxes boxes, highest score first. */
export function parseLocateOutput(raw: unknown, query: string): LocatedBox[] | null {
  if (!raw || typeof raw !== 'object' || !Array.isArray((raw as { found?: unknown }).found)) return null;
  const out: LocatedBox[] = [];
  for (const item of (raw as { found: unknown[] }).found) {
    if (!item || typeof item !== 'object') continue;
    const o = item as { label?: unknown; box_2d?: unknown; confidence?: unknown };
    const box = box2dToNormalized(o.box_2d);
    if (!box) continue;
    const label = (typeof o.label === 'string' ? o.label.replace(/\s+/g, ' ').trim() : '').slice(0, LOCATE.labelChars) || query.slice(0, LOCATE.labelChars);
    const c = typeof o.confidence === 'number' && Number.isFinite(o.confidence) ? o.confidence : LOCATE.defaultScore;
    out.push({ label, box, score: Math.min(1, Math.max(0, c)) });
  }
  return out.sort((a, b) => b.score - a.score).slice(0, LOCATE.maxBoxes);
}
