/**
 * FIXTURE vision, detector and frames. NOT a real model: returns canned, clearly labelled evidence so tests can
 * check plumbing (exact text vs interpretation, batch codes kept apart from dates) without any provider.
 */
import type { DetectorService, VisionService } from '../../src/server/contracts.js';
import type { FramePayload, LabelEvidence, ServerDetections } from '../../src/shared/protocol.js';
import type { GuideExtraction, GuideSection } from '../../src/shared/guide.js';

/**
 * FIXTURE guide extractions (test data only, never used in the app). Scenario names:
 *   'cut_off'   - instructions run off the bottom of the photo: one adjustment, nothing usable
 *   'two_methods' - complete MICROWAVE (3 steps) and OVEN (2 steps) sections: app must ask which
 *   'microwave' - only the complete MICROWAVE section
 */
export type FixtureGuideScenario = 'cut_off' | 'two_methods' | 'microwave';

const FIXTURE_MICROWAVE: GuideSection = {
  id: 'microwave',
  title: 'MICROWAVE (800W) — FIXTURE',
  kind: 'method',
  complete: true,
  missing: [],
  steps: [
    { id: 'microwave-s1', n: 1, sourceText: 'Pierce film several times.', spoken: 'Pierce the film several times.', quantities: [], warnings: [] },
    { id: 'microwave-s2', n: 2, sourceText: 'Heat on full power for 3 minutes.', spoken: 'Heat on full power for 3 minutes.', quantities: [{ text: '3 minutes', kind: 'duration' }], warnings: [] },
    { id: 'microwave-s3', n: 3, sourceText: 'Stir, re-cover and heat for 1 minute 30 seconds. Stand for 1 minute.', spoken: 'Stir, re-cover and heat for 1 minute 30 seconds, then stand for 1 minute.', quantities: [{ text: '1 minute 30 seconds', kind: 'duration' }, { text: '1 minute', kind: 'duration' }], warnings: ['Caution: contents will be hot.'] },
  ],
};
const FIXTURE_OVEN: GuideSection = {
  id: 'oven',
  title: 'OVEN 190°C / Fan 170°C / Gas 5 — FIXTURE',
  kind: 'method',
  complete: true,
  missing: [],
  steps: [
    { id: 'oven-s1', n: 1, sourceText: 'Remove film and cover with foil.', spoken: 'Remove the film and cover with foil.', quantities: [], warnings: [] },
    { id: 'oven-s2', n: 2, sourceText: 'Cook for 25 minutes.', spoken: 'Cook for 25 minutes.', quantities: [{ text: '25 minutes', kind: 'duration' }], warnings: [] },
  ],
};

export function fixtureGuide(frame: Pick<FramePayload, 'frameId' | 'capturedAt'>, scenario: FixtureGuideScenario): GuideExtraction {
  const base = { frameIds: [frame.frameId], capturedAt: [frame.capturedAt], title: 'FIXTURE Chickpea Curry', warnings: [], model: 'FIXTURE-vision', latencyMs: 9 };
  if (scenario === 'cut_off') {
    return { ...base, readability: 'partial', issue: 'cut_off_bottom', issueEvidence: 'FIXTURE: text continues below the bottom edge', adjustment: 'The bottom of the instructions is outside the frame. Move the phone slightly back.', sections: [] };
  }
  const sections = scenario === 'two_methods' ? [FIXTURE_MICROWAVE, FIXTURE_OVEN] : [FIXTURE_MICROWAVE];
  return { ...base, readability: 'clear', issue: 'none', issueEvidence: null, adjustment: null, sections };
}

export const FIXTURE_VISION_MODEL = 'FIXTURE-vision';
export const FIXTURE_ANSWER = 'FIXTURE snapshot answer: a mug is in the photo.';

export function fixtureEvidence(frame: Pick<FramePayload, 'frameId' | 'capturedAt'>): LabelEvidence {
  return {
    frameId: frame.frameId,
    capturedAt: frame.capturedAt,
    readability: 'clear',
    exactText: [
      { section: 'product_name', text: 'FIXTURE Tomato Soup' },
      { section: 'cooking_instructions', text: 'Heat gently, stirring.' },
    ],
    instructions: [{ method: 'Hob', steps: ['Pour into a pan.', 'Heat gently for 4 minutes, stirring.'] }],
    dates: [
      {
        printedText: 'BEST BEFORE END 03 2027',
        labelType: 'best_before_end',
        interpretation: { status: 'parsed', isoDate: '2027-03-31', comparison: 'future', note: 'Month and year only' },
      },
    ],
    batchCodes: ['L4471 B2'],
    itemGuess: 'a tin of soup (FIXTURE guess)',
    issues: [],
    suggestion: null,
    model: FIXTURE_VISION_MODEL,
    latencyMs: 12,
  };
}

export interface FixtureVision extends VisionService {
  extractCalls: { frame: FramePayload; focus?: string | undefined }[];
  answerCalls: { frame: FramePayload; question: string }[];
  locateCalls: { frame: FramePayload; query: string }[];
  guideCalls: { frame: FramePayload; goal: string }[];
  /** FIXTURE: scenarios returned by successive extractGuide calls (last one repeats). */
  guideScenarios: FixtureGuideScenario[];
  /** Make the next calls throw (e.g. a VisionError). */
  failWith: unknown;
}

export function createFixtureVision(): FixtureVision {
  const v: FixtureVision = {
    model: FIXTURE_VISION_MODEL,
    extractCalls: [],
    answerCalls: [],
    locateCalls: [],
    guideCalls: [],
    guideScenarios: ['cut_off', 'two_methods'],
    failWith: null,
    async extractLabel({ frame, focus }) {
      v.extractCalls.push({ frame, focus });
      if (v.failWith) throw v.failWith;
      return fixtureEvidence(frame);
    },
    async answer({ frame, question }) {
      v.answerCalls.push({ frame, question });
      if (v.failWith) throw v.failWith;
      return { text: FIXTURE_ANSWER, latencyMs: 7 };
    },
    async extractGuide({ frame, goal }) {
      v.guideCalls.push({ frame, goal });
      if (v.failWith) throw v.failWith;
      const i = Math.min(v.guideCalls.length - 1, v.guideScenarios.length - 1);
      return fixtureGuide(frame, v.guideScenarios[i] ?? 'microwave');
    },
    /** FIXTURE: one fixed centred box labelled with the query. */
    async locate({ frame, query }) {
      v.locateCalls.push({ frame, query });
      if (v.failWith) throw v.failWith;
      return { boxes: [{ label: `FIXTURE ${query}`, box: { x: 0.4, y: 0.4, w: 0.2, h: 0.2 }, score: 0.9 }], model: FIXTURE_VISION_MODEL, latencyMs: 5 };
    },
  };
  return v;
}

export const disabledDetector: DetectorService = {
  enabled: false,
  model: 'none',
  detect: async () => null,
  health: async () => 'disabled',
};

/** FIXTURE detector: one fixed box per frame, result stamped with the frame's id/capture time. */
export function createFixtureDetector(): DetectorService & { calls: number } {
  const d = {
    enabled: true,
    model: 'FIXTURE-detector',
    calls: 0,
    async detect(frame: FramePayload): Promise<ServerDetections | null> {
      d.calls++;
      return {
        type: 'detections',
        frameId: frame.frameId,
        capturedAt: frame.capturedAt,
        sourceWidth: frame.width,
        sourceHeight: frame.height,
        detectedAt: Date.now(),
        model: 'FIXTURE-detector',
        detections: [{ label: 'cup', score: 0.9, box: { x: 0.1, y: 0.1, w: 0.3, h: 0.3 } }],
      };
    },
    health: async () => 'ok' as const,
  };
  return d;
}

/** 1x1 white JPEG, base64 without a data: prefix (FIXTURE image bytes). */
export const TINY_JPEG_BASE64 =
  '/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAAMCAgICAgMCAgIDAwMDBAYEBAQEBAgGBgUGCQgKCgkICQkKDA8MCgsOCwkJDRENDg8QEBEQCgwSExIQEw8QEBD/yQALCAABAAEBAREA/8wABgAQEAX/2gAIAQEAAD8A0s8g/9k=';

let frameCounter = 0;
export function fixtureFrame(over: Partial<FramePayload> = {}): FramePayload {
  return {
    frameId: ++frameCounter,
    capturedAt: Date.now(),
    width: 640,
    height: 480,
    mimeType: 'image/jpeg',
    data: TINY_JPEG_BASE64,
    ...over,
  };
}
