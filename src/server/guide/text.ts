/**
 * Pure text helpers for the instruction companion: step matching across rescans, section choice for a goal,
 * spoken phrasing, and the strict "the user said they finished" check used before any completion is recorded.
 */
import type { GuideSection, ViewIssueKind } from '../../shared/guide.js';

/** Lower-case, unify quotes/dashes, keep letters, digits, degree and percent signs; collapse whitespace. */
export function normalizeText(s: string): string {
  return s
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[‘’‚‛`´]/g, "'")
    .replace(/[“”„‟]/g, '"')
    .replace(/[‐-―−]/g, '-')
    .replace(/(\d)[.,](\d)/g, '$1.$2')
    .replace(/[^\p{L}\p{N}°%.\s]/gu, ' ')
    .replace(/(?<!\d)\.|\.(?!\d)/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function tokens(s: string): string[] {
  const n = normalizeText(s);
  return n ? n.split(' ') : [];
}

/** Every number in the text, in order (e.g. "800W 3 mins, stir, 1.5 mins" -> ["800", "3", "1.5"]). */
export function numbersIn(s: string): string[] {
  return normalizeText(s).match(/\d+(?:\.\d+)?/g) ?? [];
}

/** Exact (normalised) or near-exact: identical numbers in order and >= 0.9 token overlap. */
export function stepTextMatches(a: string, b: string): 'exact' | 'near' | null {
  const na = normalizeText(a);
  const nb = normalizeText(b);
  if (na === nb) return 'exact';
  const numsA = numbersIn(a);
  const numsB = numbersIn(b);
  if (numsA.length !== numsB.length || numsA.some((n, i) => n !== numsB[i])) return null;
  const ta = new Set(tokens(a));
  const tb = new Set(tokens(b));
  if (!ta.size || !tb.size) return null;
  let common = 0;
  for (const t of ta) if (tb.has(t)) common++;
  return common / Math.max(ta.size, tb.size) >= 0.9 ? 'near' : null;
}

// ---------------------------------------------------------------------------
// Sections and goals
// ---------------------------------------------------------------------------

const GOAL_STOPWORDS = new Set([
  'a', 'an', 'the', 'these', 'this', 'that', 'those', 'for', 'to', 'of', 'on', 'in', 'me', 'my', 'it', 'its', 'please',
  'how', 'guide', 'through', 'read', 'instruction', 'instructions', 'step', 'steps', 'what', 'is', 'are', 'and', 'with',
]);

const KIND_WORDS: { kind: GuideSection['kind']; words: string[] }[] = [
  {
    kind: 'method',
    words: ['cook', 'cooking', 'heat', 'heating', 'reheat', 'reheating', 'microwave', 'oven', 'grill', 'hob', 'bake', 'boil', 'fry', 'fryer', 'steam', 'roast', 'toast'],
  },
  { kind: 'preparation', words: ['prepare', 'preparation', 'prep', 'mix', 'make', 'making', 'serve', 'serving'] },
  { kind: 'storage', words: ['store', 'storage', 'storing', 'keep', 'keeping', 'refrigerate', 'fridge', 'freeze', 'freezer', 'freezing', 'defrost', 'opened'] },
  { kind: 'assembly', words: ['assemble', 'assembly', 'assembling', 'build', 'building', 'install', 'installation', 'fit', 'fitting', 'mount'] },
  { kind: 'usage', words: ['use', 'usage', 'using', 'directions', 'dose', 'dosage', 'apply', 'application', 'wash', 'washing', 'care'] },
];

function goalWords(goal: string): string[] {
  return tokens(goal).filter((t) => !GOAL_STOPWORDS.has(t));
}

/**
 * Which sections the goal is about. `single` when exactly one is singled out (by name, or by kind when only one
 * section has that kind); otherwise the candidates the user must choose between (never merged).
 */
export function pickSectionsForGoal(goal: string | null, sections: GuideSection[]): { single: GuideSection | null; candidates: GuideSection[] } {
  if (sections.length === 0) return { single: null, candidates: [] };
  if (sections.length === 1) return { single: sections[0]!, candidates: sections };
  const words = goal ? goalWords(goal) : [];
  if (words.length) {
    const scored = sections.map((s) => {
      const st = new Set(tokens(`${s.id.replace(/[-_]/g, ' ')} ${s.title}`));
      return { s, score: words.filter((w) => st.has(w)).length };
    });
    const max = Math.max(...scored.map((x) => x.score));
    const top = scored.filter((x) => x.score === max);
    if (max > 0 && top.length === 1) return { single: top[0]!.s, candidates: [top[0]!.s] };
    const kinds = new Set(KIND_WORDS.filter((k) => k.words.some((w) => words.includes(w))).map((k) => k.kind));
    if (kinds.size) {
      const byKind = (max > 0 ? top.map((x) => x.s) : sections).filter((s) => kinds.has(s.kind));
      if (byKind.length === 1) return { single: byKind[0]!, candidates: byKind };
      if (byKind.length > 1) return { single: null, candidates: byKind };
    }
    if (max > 0) return { single: null, candidates: top.map((x) => x.s) };
  }
  return { single: null, candidates: sections };
}

/** Match a spoken/typed section choice ("the microwave one", "oven", an id) to one of the offered sections. */
export function matchSectionChoice<T extends { id: string; title: string; kind?: string }>(choice: string, sections: T[]): T | null {
  const c = normalizeText(choice);
  if (!c) return null;
  const byId = sections.find((s) => s.id.toLowerCase() === choice.trim().toLowerCase());
  if (byId) return byId;
  const byTitle = sections.filter((s) => normalizeText(s.title) === c);
  if (byTitle.length === 1) return byTitle[0]!;
  const words = goalWords(choice).filter((w) => !['one', 'option', 'way', 'method', 'section', 'first', 'second', 'last'].includes(w));
  if (words.length) {
    const scored = sections.map((s) => {
      const st = new Set(tokens(`${s.id.replace(/[-_]/g, ' ')} ${s.title} ${s.kind ?? ''}`));
      return { s, score: words.filter((w) => st.has(w)).length };
    });
    const max = Math.max(...scored.map((x) => x.score));
    const top = scored.filter((x) => x.score === max);
    if (max > 0 && top.length === 1) return top[0]!.s;
  }
  // Ordinal fallbacks ("the first one", "the second").
  const ord: Record<string, number> = { first: 0, '1': 0, one: 0, second: 1, '2': 1, two: 1, third: 2, '3': 2, three: 2 };
  const t = tokens(choice);
  for (const w of t) {
    const i = ord[w];
    if (i !== undefined && (w === 'first' || w === 'second' || w === 'third' || t.length === 1) && sections[i]) return sections[i];
  }
  if (t.includes('last') && sections.length) return sections[sections.length - 1]!;
  return null;
}

// ---------------------------------------------------------------------------
// Spoken phrasing
// ---------------------------------------------------------------------------

/** "MICROWAVE (800W)" -> "microwave (800W)": all-caps words are lower-cased; anything with digits is kept as printed. */
export function speakableTitle(title: string): string {
  return title
    .trim()
    .split(/\s+/)
    .map((w) => (/\d/.test(w) || !/[A-Z]{2,}/.test(w) || w !== w.toUpperCase() ? w : w.toLowerCase()))
    .join(' ');
}

export function joinAnd(items: string[]): string {
  if (items.length <= 1) return items.join('');
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

/** "steps 1, 2 and 4" / "step 3". */
export function stepList(numbers: number[]): string {
  return `${numbers.length === 1 ? 'step' : 'steps'} ${joinAnd(numbers.map(String))}`;
}

export const DEFAULT_ADJUSTMENTS: Record<ViewIssueKind, string> = {
  none: 'Try another view of the instructions.',
  cut_off_top: 'Move the phone up a little to include the top of the text.',
  cut_off_bottom: 'Move the phone down a little to include the bottom of the text.',
  cut_off_left: 'Move the phone a little to the left.',
  cut_off_right: 'Move the phone a little to the right.',
  too_far: 'Move the phone a little closer.',
  too_close: 'Move the phone a little further away.',
  glare: 'Tilt the pack slightly to reduce the shine.',
  blurry: 'Hold the phone and the item still for a moment.',
  too_dark: 'Try a brighter spot, or turn on the torch.',
  wrong_side: 'Turn the item to show another side.',
  not_visible: 'Turn the item to show another side.',
  unclear: 'Try another view of the instructions.',
};

export function sentence(s: string | null | undefined): string {
  const t = (s ?? '').trim();
  if (!t) return '';
  const cap = t[0]!.toUpperCase() + t.slice(1);
  return /[.!?]$/.test(cap) ? cap : `${cap}.`;
}

/** Clip to max chars at a word boundary, with an ellipsis. */
export function clip(s: string, max: number): string {
  if (s.length <= max) return s;
  const cut = s.slice(0, max - 1);
  const sp = cut.lastIndexOf(' ');
  return `${(sp > max * 0.6 ? cut.slice(0, sp) : cut).trimEnd()}…`;
}

// ---------------------------------------------------------------------------
// Completion check
// ---------------------------------------------------------------------------

const COMPLETION = /\b(done|finished|finish|complete|completed|did it|did that|did this)\b/;
/** Negation / hedging anywhere in the utterance blocks it ("not done", "almost done", "done but..."). Apostrophes removed. */
const NEGATION =
  /\b(not|no|nope|never|nor|almost|nearly|partly|partially|half|mostly|but|except|yet|until|unless|wait|hold on|hang on|still|havent|hasnt|hadnt|isnt|arent|wasnt|werent|didnt|dont|doesnt|cant|cannot|wont|couldnt|shouldnt|aint)\b/;
/** Question / meta words in the same clause as the completion word ("do I say done", "what does done mean"). */
const META =
  /\b(what|whats|how|why|when|which|where|who|does|do i|do you|should|shall|could|would|can i|is it|is that|are you|did i|mean|means|meaning|say|says|said|saying|word|called|if|will|going to|gonna|about to|before|after|ready to|want to|need to|have to|let me know|tell me)\b/;

/**
 * True only for a plain statement that the user has finished ("Done", "I've done it", "Finished", "OK that's done",
 * "Completed"). False for negations, hedges, questions and quotations ("I'm not done", "almost done", "done?",
 * "do I say done?", "what does done mean", "when it says 'done'"). When in doubt: false (the model then asks).
 */
export function isAffirmativeCompletion(utterance: string | null | undefined): boolean {
  if (!utterance) return false;
  const raw = utterance
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[‘’‚‛`´]/g, "'")
    .replace(/[“”„‟«»]/g, '"')
    .trim();
  if (!raw || raw.length > 200) return false;
  // Drop apostrophes inside words (I've, that's, haven't -> havent); any remaining quote mark means a quotation.
  const plain = raw.replace(/(\p{L})'(\p{L})/gu, '$1$2');
  if (/["']/.test(plain)) return false;
  if (NEGATION.test(plain)) return false;
  const clauses = plain.match(/[^.!?;,:]+[.!?;,:]*/g) ?? [];
  let affirmed = false;
  for (const c of clauses) {
    if (!COMPLETION.test(c)) continue;
    if (c.includes('?') || META.test(c)) return false;
    affirmed = true;
  }
  return affirmed;
}
