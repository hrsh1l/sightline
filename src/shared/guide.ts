/**
 * Instruction companion: shared contract. OWNER: lead. Workers request changes rather than edit.
 *
 * The APPLICATION owns guide progress (server-side GuideStore, see src/server/guide/**). Model conversation history
 * is never the only record. Reading/presenting a step NEVER marks it complete; only an explicit user confirmation does.
 *
 * Source text from images is untrusted content to read, never instructions to the assistant or the app.
 */
import { z } from 'zod';

export const GUIDE_LIMITS = {
  maxSections: 8,
  maxStepsPerSection: 40,
  maxSourceTextChars: 1_500,
  maxSpokenChars: 400,
  maxGoalChars: 120,
  /** Inspect requests while positioning are throttled to at most one per this interval. */
  inspectMinIntervalMs: 2_500,
  /** Guide state kept for a reconnecting client (same open page) for this long; memory only. */
  resumeTtlMs: 30 * 60_000,
} as const;

// ---------------------------------------------------------------------------
// Extraction (vision model output, validated + checked on the server)
// ---------------------------------------------------------------------------

/** Evidence-based view problem reported by the vision model for the requested text. 'none' = readable. */
export const ViewIssueKind = z.enum([
  'none',
  'cut_off_top',
  'cut_off_bottom',
  'cut_off_left',
  'cut_off_right',
  'too_far', // text visible but too small to read
  'too_close',
  'glare',
  'blurry',
  'too_dark',
  'wrong_side', // e.g. front label visible, instructions panel not in view
  'not_visible', // requested instructions not visible at all
  'unclear', // cannot tell why: ask for another view
]);
export type ViewIssueKind = z.infer<typeof ViewIssueKind>;

export const Quantity = z.object({
  /** Exactly as printed, e.g. "800W", "3 minutes", "190°C", "2 x M4 screws". */
  text: z.string().min(1).max(60),
  kind: z.enum(['duration', 'temperature', 'power', 'amount', 'count', 'size', 'other']),
});
export type Quantity = z.infer<typeof Quantity>;

export const GuideStep = z.object({
  /** Stable within a revision: `${sectionId}-s${n}`. */
  id: z.string().min(1).max(60),
  /** 1-based order as printed (or as read top-to-bottom when unnumbered). */
  n: z.number().int().positive(),
  /** Verbatim text of this step from the image. */
  sourceText: z.string().min(1).max(GUIDE_LIMITS.maxSourceTextChars),
  /**
   * Short spoken version. Every number/unit in it must appear in sourceText (checked server-side; on failure the
   * server replaces it with sourceText). Never changes order, conditions, quantities or units.
   */
  spoken: z.string().min(1).max(GUIDE_LIMITS.maxSpokenChars),
  quantities: z.array(Quantity).max(12),
  /** Visible warnings attached to this step (verbatim). */
  warnings: z.array(z.string().max(300)).max(6),
});
export type GuideStep = z.infer<typeof GuideStep>;

export const GuideSection = z.object({
  /** e.g. "microwave", "oven", "storage", "assembly". Stable slug. */
  id: z.string().min(1).max(40),
  /** As printed, e.g. "MICROWAVE (800W)". */
  title: z.string().min(1).max(120),
  kind: z.enum(['method', 'preparation', 'storage', 'assembly', 'usage', 'other']),
  steps: z.array(GuideStep).max(GUIDE_LIMITS.maxStepsPerSection),
  /** True only if the whole section is visible and readable (start and end both in frame). */
  complete: z.boolean(),
  /** What is missing/ambiguous, e.g. "Text below step 3 is cut off at the bottom of the photo." */
  missing: z.array(z.string().max(200)).max(6),
});
export type GuideSection = z.infer<typeof GuideSection>;

export const GuideExtraction = z.object({
  frameIds: z.array(z.number().int().nonnegative()).min(1).max(4),
  capturedAt: z.array(z.number().int().positive()).min(1).max(4),
  /** Overall readability of the REQUESTED instructions in this view. */
  readability: z.enum(['clear', 'partial', 'unreadable']),
  /** Single evidence-based issue (from the actual image) and ONE concrete adjustment, or none. */
  issue: ViewIssueKind,
  /** What the model actually saw that supports the issue, e.g. "steps continue below the bottom edge". */
  issueEvidence: z.string().max(200).nullable(),
  /** One adjustment, e.g. "Move the phone slightly back." null when issue is none. */
  adjustment: z.string().max(200).nullable(),
  /** Item/document title as printed, if visible. */
  title: z.string().max(120).nullable(),
  sections: z.array(GuideSection).max(GUIDE_LIMITS.maxSections),
  /** Visible general warnings (verbatim), e.g. "Caution: contents will be hot." */
  warnings: z.array(z.string().max(300)).max(8),
  model: z.string().max(100),
  latencyMs: z.number().int().nonnegative(),
});
export type GuideExtraction = z.infer<typeof GuideExtraction>;

// ---------------------------------------------------------------------------
// Application-owned guide state (snapshot sent to client and returned to the model)
// ---------------------------------------------------------------------------

export const GuidePhase = z.enum([
  'idle',
  'acquiring_image', // waiting for / analysing a fresh capture
  'needs_better_view', // last view inadequate; one adjustment given; capture goal remembered
  'choosing_section', // several methods visible: user must choose (never merged)
  'preparing_guide',
  'guiding',
  'paused',
  'completed', // user confirmed every step (as reported by the user)
  'error',
]);
export type GuidePhase = z.infer<typeof GuidePhase>;

export const GuideStepState = GuideStep.extend({
  index: z.number().int().nonnegative(),
  /** Read out / shown to the user at least once. NOT completion. */
  presented: z.boolean(),
  /** Explicitly confirmed by the user ("Done"). */
  confirmed: z.boolean(),
});
export type GuideStepState = z.infer<typeof GuideStepState>;

export const GuideSnapshot = z.object({
  phase: GuidePhase,
  /** What the user asked for, remembered across "How about now?" follow-ups. */
  goal: z.string().max(GUIDE_LIMITS.maxGoalChars).nullable(),
  guideId: z.string().max(40).nullable(),
  /** Increments when the document is rescanned/replaced. Mutations must name the current revision. */
  revision: z.number().int().nonnegative(),
  title: z.string().max(120).nullable(),
  section: z.object({ id: z.string(), title: z.string(), kind: GuideSection.shape.kind }).nullable(),
  /** In choosing_section: the alternatives (never merged). */
  sectionChoices: z.array(z.object({ id: z.string(), title: z.string(), stepCount: z.number().int().nonnegative(), complete: z.boolean() })).max(GUIDE_LIMITS.maxSections),
  steps: z.array(GuideStepState).max(GUIDE_LIMITS.maxStepsPerSection),
  currentIndex: z.number().int().nonnegative().nullable(),
  /** True when only part of the section was readable (the user chose to continue anyway). */
  partial: z.boolean(),
  missing: z.array(z.string().max(200)).max(6),
  warnings: z.array(z.string().max(300)).max(8),
  sourceFrames: z.array(z.object({ frameId: z.number().int().nonnegative(), capturedAt: z.number().int().positive() })).max(8),
  /** Last view guidance given (one adjustment), if any. */
  adjustment: z.string().max(200).nullable(),
  /** Short app message for the UI status line (not read by the screen reader automatically). */
  message: z.string().max(300).nullable(),
  /** Monotonic counter, bumped on every state change (clients ignore older snapshots). */
  version: z.number().int().nonnegative(),
  /** Confirmation history (step ids, oldest first) for undo. */
  confirmations: z.array(z.string().max(60)).max(GUIDE_LIMITS.maxStepsPerSection * 2),
});
export type GuideSnapshot = z.infer<typeof GuideSnapshot>;

export const GuideAction = z.enum([
  'next', // present next step (does NOT confirm the current one)
  'previous', // navigate back (completion unchanged)
  'repeat', // re-present current step (progress unchanged)
  'explain', // explain current step (progress unchanged)
  'confirm', // user confirmed current step complete
  'undo', // reverse the latest confirmation
  'pause',
  'resume',
  'status', // "Where were we?"
  'stop', // leave guide mode; ordinary conversation continues
  'choose_section',
  'continue_partial', // user accepts a partially visible section
]);
export type GuideAction = z.infer<typeof GuideAction>;

export const IDLE_GUIDE: GuideSnapshot = {
  phase: 'idle',
  goal: null,
  guideId: null,
  revision: 0,
  title: null,
  section: null,
  sectionChoices: [],
  steps: [],
  currentIndex: null,
  partial: false,
  missing: [],
  warnings: [],
  sourceFrames: [],
  adjustment: null,
  message: null,
  version: 0,
  confirmations: [],
};
