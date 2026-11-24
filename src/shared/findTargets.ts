/**
 * The objects Find mode supports, and nothing else. OWNER: lead.
 *
 * Each maps to one COCO class the local YOLO26n detector outputs (verified class names: cup, bottle, bowl, apple,
 * banana). Gemini prose is never used as coordinates. Anything outside this list gets an honest "unsupported"
 * reply listing these items; normal Gemini conversation stays available for other questions.
 */
export interface FindTarget {
  /** COCO class name as emitted by the detector. */
  coco: 'cup' | 'bottle' | 'bowl' | 'apple' | 'banana';
  /** Singular noun used in speech ("Bottle centred in the camera."). */
  noun: string;
  /** Plural used in selection prompts ("I see two cups."). */
  plural: string;
  /** Button label. */
  label: string;
  /** Accepted words (lower case, singular and plural). */
  aliases: readonly string[];
}

export const FIND_TARGETS: readonly FindTarget[] = [
  { coco: 'cup', noun: 'cup', plural: 'cups', label: 'Cup or mug', aliases: ['cup', 'cups', 'mug', 'mugs', 'teacup', 'teacups', 'coffee cup', 'coffee mug', 'tea cup'] },
  { coco: 'bottle', noun: 'bottle', plural: 'bottles', label: 'Bottle', aliases: ['bottle', 'bottles', 'water bottle', 'drink bottle'] },
  { coco: 'bowl', noun: 'bowl', plural: 'bowls', label: 'Bowl', aliases: ['bowl', 'bowls', 'mixing bowl'] },
  { coco: 'apple', noun: 'apple', plural: 'apples', label: 'Apple', aliases: ['apple', 'apples'] },
  { coco: 'banana', noun: 'banana', plural: 'bananas', label: 'Banana', aliases: ['banana', 'bananas'] },
] as const;

/** "cups, mugs, bottles, bowls, apples and bananas" for honest limitation messages. */
export const SUPPORTED_FIND_SENTENCE = 'cups or mugs, bottles, bowls, apples and bananas';

const ARTICLES = /^(?:the|a|an|my|some|that|this|one)\s+/;

/** Resolve free text ("Find a mug", "the bottle") to a supported target, or null if unsupported. */
export function resolveFindTarget(query: string): FindTarget | null {
  let q = query.toLowerCase().replace(/[^a-z\s]/g, ' ').replace(/\s+/g, ' ').trim();
  q = q.replace(/^(?:find|look for|where is|where's|wheres)\s+/, '');
  while (ARTICLES.test(q)) q = q.replace(ARTICLES, '');
  if (!q) return null;
  for (const t of FIND_TARGETS) if (t.aliases.includes(q)) return t;
  // Allow one leading adjective-free phrase containing exactly one known alias word, e.g. "white mug".
  const words = q.split(' ');
  const hits = FIND_TARGETS.filter((t) => t.aliases.some((a) => !a.includes(' ') && words.includes(a)));
  return hits.length === 1 ? hits[0]! : null;
}

export function findTargetByCoco(coco: string): FindTarget | null {
  return FIND_TARGETS.find((t) => t.coco === coco) ?? null;
}
