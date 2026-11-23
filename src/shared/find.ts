/**
 * Find-mode helpers shared by the server (target selection, state, descriptions) and the client (cue targets).
 * Pure functions, no I/O. OWNER: conversation agent.
 *
 * SAFETY FRAMING: every position here is IMAGE-RELATIVE ("left of the picture") so the user can aim the camera at
 * an item within reach. Nothing here describes physical distance or walking directions; "large in the picture" is
 * not a distance claim.
 */
import type { Detection, NormalizedBox } from './protocol.js';

/** The 80 COCO classes, as named by the Ultralytics YOLO models behind DetectorService. */
export const COCO_CLASSES = [
  'person', 'bicycle', 'car', 'motorcycle', 'airplane', 'bus', 'train', 'truck', 'boat', 'traffic light',
  'fire hydrant', 'stop sign', 'parking meter', 'bench', 'bird', 'cat', 'dog', 'horse', 'sheep', 'cow',
  'elephant', 'bear', 'zebra', 'giraffe', 'backpack', 'umbrella', 'handbag', 'tie', 'suitcase', 'frisbee',
  'skis', 'snowboard', 'sports ball', 'kite', 'baseball bat', 'baseball glove', 'skateboard', 'surfboard', 'tennis racket', 'bottle',
  'wine glass', 'cup', 'fork', 'knife', 'spoon', 'bowl', 'banana', 'apple', 'sandwich', 'orange',
  'broccoli', 'carrot', 'hot dog', 'pizza', 'donut', 'cake', 'chair', 'couch', 'potted plant', 'bed',
  'dining table', 'toilet', 'tv', 'laptop', 'mouse', 'remote', 'keyboard', 'cell phone', 'microwave', 'oven',
  'toaster', 'sink', 'refrigerator', 'book', 'clock', 'vase', 'scissors', 'teddy bear', 'hair drier', 'toothbrush',
] as const;
export type CocoClass = (typeof COCO_CLASSES)[number];

const COCO_SET: ReadonlySet<string> = new Set(COCO_CLASSES);

/**
 * Everyday words -> COCO class(es). The first label is the primary one. An empty array means "known not to be a
 * COCO class" (e.g. "glasses" are spectacles, not wine glasses), so the query goes to Gemini instead.
 */
const SYNONYMS: Readonly<Record<string, readonly CocoClass[]>> = {
  mug: ['cup'],
  'coffee mug': ['cup'],
  'coffee cup': ['cup'],
  teacup: ['cup'],
  'tea cup': ['cup'],
  beaker: ['cup'],
  tumbler: ['cup', 'wine glass'],
  glass: ['cup', 'wine glass'],
  'drinking glass': ['cup', 'wine glass'],
  'wineglass': ['wine glass'],
  glasses: [],
  spectacles: [],
  plate: [],
  phone: ['cell phone'],
  cellphone: ['cell phone'],
  'mobile phone': ['cell phone'],
  mobile: ['cell phone'],
  smartphone: ['cell phone'],
  iphone: ['cell phone'],
  television: ['tv'],
  telly: ['tv'],
  'tv remote': ['remote'],
  'remote control': ['remote'],
  'computer mouse': ['mouse'],
  computer: ['laptop'],
  'laptop computer': ['laptop'],
  sofa: ['couch'],
  settee: ['couch'],
  table: ['dining table'],
  'kitchen table': ['dining table'],
  plant: ['potted plant'],
  houseplant: ['potted plant'],
  'house plant': ['potted plant'],
  'pot plant': ['potted plant'],
  fridge: ['refrigerator'],
  'hair dryer': ['hair drier'],
  hairdryer: ['hair drier'],
  teddy: ['teddy bear'],
  ball: ['sports ball'],
  football: ['sports ball'],
  rucksack: ['backpack'],
  bag: ['handbag', 'backpack', 'suitcase'],
  purse: ['handbag'],
  doughnut: ['donut'],
  hotdog: ['hot dog'],
  motorbike: ['motorcycle'],
  bike: ['bicycle'],
  plane: ['airplane'],
  aeroplane: ['airplane'],
  man: ['person'],
  woman: ['person'],
  someone: ['person'],
  somebody: ['person'],
  people: ['person'],
  child: ['person'],
  kitten: ['cat'],
  puppy: ['dog'],
  loo: ['toilet'],
  microwave: ['microwave'],
  'microwave oven': ['microwave'],
  knives: ['knife'],
  scissor: ['scissors'],
};

const DETERMINERS = new Set(['the', 'a', 'an', 'my', 'some', 'this', 'that', 'these', 'those', 'your', 'our', 'any']);

/** Lower-case, letters/spaces only, without leading determiners or a trailing "please". */
export function normalizeQuery(query: string): string {
  const words = query
    .toLowerCase()
    .replace(/[^a-z\s-]/g, ' ')
    .replace(/-/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
  while (words.length > 1 && DETERMINERS.has(words[0]!)) words.shift();
  while (words.length > 1 && words[words.length - 1] === 'please') words.pop();
  if (words.length === 1 && DETERMINERS.has(words[0]!)) return '';
  // "glass of water" / "bottle of milk": the head noun is before "of".
  const of = words.indexOf('of');
  return (of > 0 ? words.slice(0, of) : words).join(' ');
}

function lookupPhrase(phrase: string): readonly CocoClass[] | null {
  if (!phrase) return null;
  if (Object.hasOwn(SYNONYMS, phrase)) return SYNONYMS[phrase]!;
  if (COCO_SET.has(phrase)) return [phrase as CocoClass];
  // Simple plurals: "cups", "bottles", "boxes" (never strips "scissors"/"skis", which matched above).
  for (const singular of [phrase.replace(/es$/, ''), phrase.replace(/s$/, '')]) {
    if (singular !== phrase) {
      if (Object.hasOwn(SYNONYMS, singular)) return SYNONYMS[singular]!;
      if (COCO_SET.has(singular)) return [singular as CocoClass];
    }
  }
  return null;
}

export interface CocoMatch {
  /** Matching COCO labels, primary first. */
  labels: readonly CocoClass[];
  /** True when the whole query (minus determiners) is the class name/synonym, e.g. "the cup" but not "the red cup". */
  exact: boolean;
}

/**
 * Map a free-text query to COCO class(es) by its head noun ("the blue coffee mug" -> cup). Returns null when it is
 * not (or is known not to be) a COCO class.
 */
export function cocoMatch(query: string): CocoMatch | null {
  const words = normalizeQuery(query).split(' ').filter(Boolean);
  // Try the longest trailing phrase first: "blue coffee mug" -> "blue coffee mug", "coffee mug", "mug".
  for (let i = 0; i < words.length; i++) {
    const labels = lookupPhrase(words.slice(i).join(' '));
    if (labels) return labels.length ? { labels, exact: i === 0 } : null;
  }
  return null;
}

/** The primary COCO label for a query, or null. */
export function cocoLabelFor(query: string): CocoClass | null {
  return cocoMatch(query)?.labels[0] ?? null;
}

const SHARP_WORDS = /\b(knife|knives|blade|blades|scissor|scissors|razor|razors|scalpel|cleaver|peeler|grater|saw|axe|needle|needles|pin|pins|skewer|skewers|mandoline)\b/i;

/** True for items that may be sharp: aiming help only, never guidance that brings a hand toward them. */
export function isSharpQuery(query: string): boolean {
  return SHARP_WORDS.test(query);
}

// ---------------------------------------------------------------------------
// Geometry
// ---------------------------------------------------------------------------

const clamp01 = (v: number) => (Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0);

export function boxCenter(box: NormalizedBox): { cx: number; cy: number } {
  return { cx: clamp01(box.x + box.w / 2), cy: clamp01(box.y + box.h / 2) };
}

export function boxArea(box: NormalizedBox): number {
  return clamp01(Math.max(0, box.w) * Math.max(0, box.h));
}

/** Intersection over union of two normalised boxes (0..1). */
export function iou(a: NormalizedBox, b: NormalizedBox): number {
  const x1 = Math.max(a.x, b.x);
  const y1 = Math.max(a.y, b.y);
  const x2 = Math.min(a.x + a.w, b.x + b.w);
  const y2 = Math.min(a.y + a.h, b.y + b.h);
  const inter = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
  const union = a.w * a.h + b.w * b.h - inter;
  return union > 0 ? inter / union : 0;
}

/** Half-widths of the "centred" window around the picture centre. */
export const CENTER_TOLERANCE = { x: 0.12, y: 0.15 } as const;

/**
 * Box centre within +-0.12 (x) / +-0.15 (y) of the picture centre. `slack` widens the window (used as hysteresis so
 * a target that is already centred does not flap out on jitter).
 */
export function isCentered(box: NormalizedBox, slack = 0): boolean {
  const { cx, cy } = boxCenter(box);
  return Math.abs(cx - 0.5) <= CENTER_TOLERANCE.x + slack && Math.abs(cy - 0.5) <= CENTER_TOLERANCE.y + slack;
}

/** Size words are about how much of the PICTURE the item fills, never how far away it is. */
export function sizeWord(area: number): 'small' | 'medium' | 'large' {
  if (area < 0.03) return 'small';
  if (area < 0.2) return 'medium';
  return 'large';
}

/** Short image-relative text, e.g. "left of the picture, near the top, small". */
export function describePosition(box: NormalizedBox): string {
  const { cx, cy } = boxCenter(box);
  const size = sizeWord(boxArea(box));
  if (isCentered(box)) return `in the centre of the picture, ${size}`;
  const parts: string[] = [];
  if (cx < 0.38) parts.push('left of the picture');
  else if (cx > 0.62) parts.push('right of the picture');
  else parts.push('middle of the picture');
  if (cy < 0.35) parts.push('near the top');
  else if (cy > 0.65) parts.push('near the bottom');
  parts.push(size);
  return parts.join(', ');
}

/** Structurally identical to the client's CueTarget contract. */
export interface CueTargetLike {
  cx: number;
  cy: number;
  area: number;
  centered: boolean;
}

export function toCueTarget(box: NormalizedBox, centered: boolean = isCentered(box)): CueTargetLike {
  const { cx, cy } = boxCenter(box);
  return { cx, cy, area: boxArea(box), centered };
}

// ---------------------------------------------------------------------------
// Target selection
// ---------------------------------------------------------------------------

export interface PickTargetOptions {
  /** Accept any label (e.g. Gemini locate results, already filtered by the query). */
  anyLabel?: boolean;
  /** Ignore detections below this score. Default 0.3. */
  minScore?: number;
}

/**
 * Best detection for the query: label must match (unless anyLabel), then score, plus a continuity bonus for
 * overlapping the previous target box (so the cue does not jump between two similar items). Returns null when
 * nothing matches; never invents a box.
 */
export function pickTarget(
  detections: readonly Detection[],
  query: string,
  prev?: NormalizedBox | null,
  opts: PickTargetOptions = {},
): Detection | null {
  const minScore = opts.minScore ?? 0.3;
  const labels = opts.anyLabel ? null : new Set<string>(cocoMatch(query)?.labels ?? [normalizeQuery(query)]);
  let best: Detection | null = null;
  let bestScore = Number.NEGATIVE_INFINITY;
  for (const d of detections) {
    if (d.score < minScore) continue;
    if (labels && !labels.has(d.label.toLowerCase())) continue;
    const s = d.score + (prev ? 0.6 * iou(prev, d.box) : 0);
    if (s > bestScore) {
      best = d;
      bestScore = s;
    }
  }
  return best;
}
