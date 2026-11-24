/**
 * Instruction companion: model-facing schema and server-side normalisation for guide extraction. OWNER: vision agent.
 *
 * The provider call lives in GeminiVision.extractGuide; everything here is pure:
 *   model JSON -> lenient structural parse (ModelGuide) -> buildGuideExtraction():
 *     - caps every array/string per GUIDE_LIMITS / the GuideExtraction contract (the model-facing schema carries no
 *       size constraints, see servingSchema.ts),
 *     - section slugs normalised + de-duplicated, step ids `${sectionId}-s${n}`,
 *     - `complete` only when the model says so AND nothing is listed as missing AND there are steps,
 *     - quantities kept only when grounded in the step's sourceText,
 *     - spoken checked against sourceText (src/shared/guideChecks.ts); unfaithful spoken -> verbatim source,
 *     - view issue / adjustment made consistent with readability; the client's frame luma may support too_dark only
 *       when the model also reports a readability problem,
 *     - GuideExtraction.parse.
 * Text from the image is data only: nothing here interprets it as instructions.
 */
import { GUIDE_LIMITS, GuideExtraction, GuideSection, Quantity, ViewIssueKind, type GuideStep } from '../../shared/guide.js';
import { enforceFaithfulSpoken, numberTokenDetails } from '../../shared/guideChecks.js';
import type { FramePayload } from '../../shared/protocol.js';
import { REGION_KIND_LABEL, type RegionKind } from './detailRead.js';
import { servingSchema } from './servingSchema.js';
import { z } from 'zod';

export const GUIDE_CAP = {
  title: 120,
  sectionId: 40,
  sectionTitle: 120,
  missing: 6,
  missingChars: 200,
  quantities: 12,
  quantityChars: 60,
  stepWarnings: 6,
  warnings: 8,
  warningChars: 300,
  issueEvidenceChars: 200,
  adjustmentChars: 200,
  /** Printed step numbers above this are treated as unreliable and steps are renumbered. */
  maxStepNumber: 999,
} as const;

/** Client mean luma (0..255) below this may support 'too_dark' (same threshold as label reading). */
export const GUIDE_TOO_DARK_MEAN_LUMA = 40;

const SECTION_KINDS = GuideSection.shape.kind.options;
const QUANTITY_KINDS = Quantity.shape.kind.options;

// ---------------------------------------------------------------------------
// Model-facing schema (servingSchema strips any size/range keyword; limits are enforced below)
// ---------------------------------------------------------------------------

const nullableString = (description: string) => ({ type: ['string', 'null'], description });

/**
 * Property order matters for generation: the model transcribes the sections first, then judges the view with
 * that transcription in front of it.
 */
export const GUIDE_RESPONSE_SCHEMA = servingSchema({
  type: 'object',
  properties: {
    title: nullableString('Item or document title exactly as printed; null if not visible.'),
    sections: {
      type: 'array',
      maxItems: GUIDE_LIMITS.maxSections,
      description: 'Visible instruction sections in printed order. Each alternative method is its own section, never merged.',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Short lowercase slug, e.g. microwave, oven, hob, storage, assembly.' },
          title: { type: 'string', description: 'Section heading exactly as printed, e.g. "MICROWAVE (800W)".' },
          kind: { type: 'string', enum: [...SECTION_KINDS] },
          steps: {
            type: 'array',
            maxItems: GUIDE_LIMITS.maxStepsPerSection,
            items: {
              type: 'object',
              properties: {
                n: { type: 'integer', description: 'Printed step number, or position top to bottom starting at 1.' },
                sourceText: { type: 'string', description: 'The step exactly as printed (visible, legible text only), without its leading number or bullet.' },
                spoken: {
                  type: 'string',
                  description: 'Short natural version for speech that keeps every number, unit, temperature, time, amount, condition and order exactly as printed.',
                },
                quantities: {
                  type: 'array',
                  maxItems: GUIDE_CAP.quantities,
                  items: {
                    type: 'object',
                    properties: {
                      text: { type: 'string', description: 'Exactly as printed, e.g. "3 minutes", "190°C", "800W", "2 x M4 screws".' },
                      kind: { type: 'string', enum: [...QUANTITY_KINDS] },
                    },
                    required: ['text', 'kind'],
                  },
                },
                warnings: { type: 'array', maxItems: GUIDE_CAP.stepWarnings, items: { type: 'string' }, description: 'Warnings printed with this step, verbatim.' },
              },
              required: ['n', 'sourceText', 'spoken', 'quantities', 'warnings'],
            },
          },
          complete: { type: 'boolean', description: 'True only if the start and the end of this section are both visible and readable.' },
          missing: { type: 'array', maxItems: GUIDE_CAP.missing, items: { type: 'string' }, description: 'What is missing or unreadable in this section.' },
        },
        required: ['id', 'title', 'kind', 'steps', 'complete', 'missing'],
      },
    },
    warnings: { type: 'array', maxItems: GUIDE_CAP.warnings, items: { type: 'string' }, description: 'Other visible printed warnings, verbatim.' },
    readability: { type: 'string', enum: ['clear', 'partial', 'unreadable'], description: 'Readability of the REQUESTED instructions in this photo.' },
    issue: { type: 'string', enum: [...ViewIssueKind.options], description: 'The single main visible reason they are not fully readable, or none.' },
    issueEvidence: nullableString('What is actually visible that shows the issue; null when issue is none.'),
    adjustment: nullableString('Exactly one short camera adjustment for the person; null when issue is none.'),
  },
  required: ['title', 'sections', 'warnings', 'readability', 'issue', 'issueEvidence', 'adjustment'],
} as const);

// ---------------------------------------------------------------------------
// Lenient structural parse (enum values are mapped leniently afterwards)
// ---------------------------------------------------------------------------

const ModelStep = z.object({
  n: z.number().nullable().optional(),
  sourceText: z.string(),
  spoken: z.string().nullable().default(''),
  quantities: z.array(z.object({ text: z.string(), kind: z.string() })).default([]),
  warnings: z.array(z.string()).default([]),
});

const ModelSection = z.object({
  id: z.string().nullable().default(''),
  title: z.string().nullable().default(''),
  kind: z.string().nullable().default('other'),
  steps: z.array(ModelStep).default([]),
  complete: z.boolean().default(false),
  missing: z.array(z.string()).default([]),
});

export const ModelGuide = z.object({
  title: z.string().nullable().default(null),
  sections: z.array(ModelSection).default([]),
  warnings: z.array(z.string()).default([]),
  readability: z.enum(['clear', 'partial', 'unreadable']),
  issue: z.string().nullable().default(null),
  issueEvidence: z.string().nullable().default(null),
  adjustment: z.string().nullable().default(null),
});
export type ModelGuide = z.infer<typeof ModelGuide>;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const clip = (s: string | null | undefined, n: number) => (s ?? '').replace(/\s+/g, ' ').trim().slice(0, n).trim();
const clipOrNull = (s: string | null | undefined, n: number) => clip(s, n) || null;

function asEnum<T extends string>(values: readonly T[], v: string | null | undefined, fallback: T): T {
  return v && (values as readonly string[]).includes(v) ? (v as T) : fallback;
}

function clipList(items: string[], max: number, chars: number): string[] {
  const out: string[] = [];
  for (const item of items) {
    const c = clip(item, chars);
    if (c && !out.includes(c)) out.push(c);
    if (out.length >= max) break;
  }
  return out;
}

/** Lowercase ASCII slug: "MICROWAVE (800W)" -> "microwave-800w". */
export function slugify(text: string, max: number = GUIDE_CAP.sectionId): string {
  return text
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, max)
    .replace(/-+$/, '');
}

/** Unique section slug: model id, else the title, else "section"; duplicates get "-2", "-3"... within the length cap. */
export function uniqueSectionId(rawId: string, title: string, taken: Set<string>): string {
  const base = slugify(rawId) || slugify(title) || 'section';
  let id = base;
  for (let i = 2; taken.has(id); i++) {
    const suffix = `-${i}`;
    id = `${base.slice(0, GUIDE_CAP.sectionId - suffix.length).replace(/-+$/, '')}${suffix}`;
  }
  taken.add(id);
  return id;
}

/** Plain lowercase text for substring checks. */
const plain = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim();

/** A quantity is kept only if it is grounded in the step's printed text. */
export function quantityGrounded(text: string, sourceText: string): boolean {
  const q = numberTokenDetails(text);
  if (q.length === 0) return plain(sourceText).includes(plain(text));
  const src = new Set(numberTokenDetails(sourceText).map((t) => t.key));
  return q.every((t) => src.has(t.key));
}

/** One concrete adjustment per issue, used only when the model gave none. */
export const DEFAULT_ADJUSTMENT: Record<Exclude<ViewIssueKind, 'none'>, string> = {
  // Cut-off wording is fixed (not the model's): live runs gave contradictory up/down directions for the same view.
  // "Move back" widens the view whichever edge is cut, so it cannot point the wrong way.
  cut_off_top: 'The top of the instructions is outside the frame. Move the phone slightly back.',
  cut_off_bottom: 'The bottom of the instructions is outside the frame. Move the phone slightly back.',
  cut_off_left: 'The left side of the instructions is outside the frame. Move the phone slightly back.',
  cut_off_right: 'The right side of the instructions is outside the frame. Move the phone slightly back.',
  too_far: 'The text is too small to read. Bring the phone a little closer.',
  too_close: 'The phone is too close to read the text. Move it back a little.',
  glare: 'There is a reflection on the text. Tilt the item slightly.',
  blurry: 'The text is blurry. Hold the phone still for a moment.',
  too_dark: 'It is too dark to read. Can you turn on a light?',
  wrong_side: "I can't see the instructions on this side. Can you turn the item around?",
  not_visible: "I can't see any instructions. Can you show me the part with the instructions?",
  unclear: "I can't read all of the instructions. Can you show me that part again?",
};

export interface GuideBuildStats {
  sections: number;
  steps: number;
  incompleteSections: number;
  spokenReplaced: number;
  quantitiesDropped: number;
  /** Steps renumbered because printed numbers were missing, duplicated or out of order. */
  renumberedSections: number;
  /** Issue changed by the server's consistency rules (metadata only). */
  issueAdjusted: boolean;
}

export interface SpokenReplacement {
  sectionIndex: number;
  n: number;
  extraCount: number;
  droppedCount: number;
}

/** Printed numbers are kept when they are positive, strictly increasing and plausible; otherwise renumber 1..k. */
function stepNumbers(ns: Array<number | null | undefined>): { numbers: number[]; renumbered: boolean } {
  const valid = ns.every((n, i) => typeof n === 'number' && Number.isInteger(n) && n >= 1 && n <= GUIDE_CAP.maxStepNumber && (i === 0 || n > (ns[i - 1] as number)));
  return valid ? { numbers: ns as number[], renumbered: false } : { numbers: ns.map((_, i) => i + 1), renumbered: ns.length > 0 };
}

// ---------------------------------------------------------------------------
// Build
// ---------------------------------------------------------------------------

export function buildGuideExtraction(
  raw: ModelGuide,
  ctx: { frame: FramePayload; model: string; latencyMs: number },
): { extraction: GuideExtraction; stats: GuideBuildStats; replacements: SpokenReplacement[] } {
  const stats: GuideBuildStats = { sections: 0, steps: 0, incompleteSections: 0, spokenReplaced: 0, quantitiesDropped: 0, renumberedSections: 0, issueAdjusted: false };
  const replacements: SpokenReplacement[] = [];
  const taken = new Set<string>();
  const sections: GuideSection[] = [];

  for (const s of raw.sections) {
    if (sections.length >= GUIDE_LIMITS.maxSections) break;
    const printedTitle = clip(s.title, GUIDE_CAP.sectionTitle);
    const rawSteps = s.steps
      .map((st) => ({ ...st, sourceText: clip(st.sourceText, GUIDE_LIMITS.maxSourceTextChars) }))
      .filter((st) => st.sourceText.length > 0)
      .slice(0, GUIDE_LIMITS.maxStepsPerSection);
    if (!printedTitle && rawSteps.length === 0) continue;

    const id = uniqueSectionId(s.id ?? '', printedTitle, taken);
    const { numbers, renumbered } = stepNumbers(rawSteps.map((st) => st.n));
    if (renumbered) stats.renumberedSections++;
    const sectionIndex = sections.length;

    const steps: GuideStep[] = rawSteps.map((st, i) => {
      const n = numbers[i]!;
      const quantities: Quantity[] = [];
      for (const q of st.quantities) {
        const text = clip(q.text, GUIDE_CAP.quantityChars);
        if (!text) continue;
        if (!quantityGrounded(text, st.sourceText)) {
          stats.quantitiesDropped++;
          continue;
        }
        if (quantities.length < GUIDE_CAP.quantities && !quantities.some((x) => x.text === text)) quantities.push({ text, kind: asEnum(QUANTITY_KINDS, q.kind, 'other') });
      }
      const enforced = enforceFaithfulSpoken({ sourceText: st.sourceText, spoken: clip(st.spoken, 10 * GUIDE_LIMITS.maxSpokenChars) });
      if (enforced.replaced) {
        stats.spokenReplaced++;
        replacements.push({ sectionIndex, n, extraCount: enforced.extraCount, droppedCount: enforced.droppedCount });
      }
      return {
        id: `${id}-s${n}`,
        n,
        sourceText: st.sourceText,
        spoken: enforced.step.spoken,
        quantities,
        warnings: clipList(st.warnings, GUIDE_CAP.stepWarnings, GUIDE_CAP.warningChars),
      };
    });

    const missing = clipList(s.missing, GUIDE_CAP.missing, GUIDE_CAP.missingChars);
    const complete = s.complete && missing.length === 0 && steps.length > 0;
    if (!complete && missing.length === 0) {
      missing.push(steps.length === 0 ? 'No readable steps in this section.' : 'Part of this section may not be readable in this photo.');
    }
    if (!complete) stats.incompleteSections++;
    stats.steps += steps.length;
    sections.push({ id, title: printedTitle || 'Instructions', kind: asEnum(SECTION_KINDS, s.kind, 'other'), steps, complete, missing });
  }
  stats.sections = sections.length;

  const view = normaliseView(raw, stats.steps, ctx.frame.quality?.meanLuma);
  stats.issueAdjusted = view.adjusted;

  const extraction = GuideExtraction.parse({
    frameIds: [ctx.frame.frameId],
    capturedAt: [ctx.frame.capturedAt],
    readability: view.readability,
    issue: view.issue,
    issueEvidence: view.issueEvidence,
    adjustment: view.adjustment,
    title: clipOrNull(raw.title, GUIDE_CAP.title),
    sections,
    warnings: clipList(raw.warnings, GUIDE_CAP.warnings, GUIDE_CAP.warningChars),
    model: ctx.model.slice(0, 100),
    latencyMs: Math.max(0, Math.round(ctx.latencyMs)),
  });
  return { extraction, stats, replacements };
}

/**
 * Make readability, issue and adjustment consistent, conservatively:
 *  - no readable steps -> unreadable; an unreadable/partial view always carries an issue (unclear if the model gave
 *    none or an unknown value; not_visible when nothing at all was extracted),
 *  - a reported issue means the view is not 'clear',
 *  - client meanLuma < 40 turns an unclear/not_visible problem into too_dark (never on its own),
 *  - issue none -> evidence and adjustment null; otherwise exactly one adjustment (the model's, else a default).
 */
export function normaliseView(
  raw: Pick<ModelGuide, 'readability' | 'issue' | 'issueEvidence' | 'adjustment'>,
  stepCount: number,
  meanLuma: number | undefined,
): { readability: GuideExtraction['readability']; issue: ViewIssueKind; issueEvidence: string | null; adjustment: string | null; adjusted: boolean } {
  let readability = raw.readability;
  const modelIssue = asEnum(ViewIssueKind.options, raw.issue, readability === 'clear' ? 'none' : 'unclear');
  let issue = modelIssue;
  let issueEvidence = clipOrNull(raw.issueEvidence, GUIDE_CAP.issueEvidenceChars);
  let adjustment = clipOrNull(raw.adjustment, GUIDE_CAP.adjustmentChars);

  if (stepCount === 0) readability = 'unreadable';
  if (readability !== 'clear' && issue === 'none') issue = stepCount === 0 ? 'not_visible' : 'unclear';
  if (readability === 'clear' && issue !== 'none') readability = 'partial';

  if (meanLuma !== undefined && meanLuma < GUIDE_TOO_DARK_MEAN_LUMA && readability !== 'clear' && (issue === 'unclear' || issue === 'not_visible')) {
    issue = 'too_dark';
    issueEvidence = 'The photo is very dark.';
    adjustment = null; // the model's adjustment addressed a different cause
  }

  if (issue === 'none') {
    issueEvidence = null;
    adjustment = null;
  } else if (issue.startsWith('cut_off_')) {
    adjustment = DEFAULT_ADJUSTMENT[issue];
  } else {
    adjustment = adjustment ?? DEFAULT_ADJUSTMENT[issue];
  }
  return { readability, issue, issueEvidence, adjustment, adjusted: issue !== modelIssue || readability !== raw.readability };
}

/** Crop caption wording for guide reading (pass-1 kinds are shared with label reading). */
export function guideRegionLabel(kind: RegionKind): string {
  return kind === 'cooking_instructions' ? 'instructions' : REGION_KIND_LABEL[kind];
}
