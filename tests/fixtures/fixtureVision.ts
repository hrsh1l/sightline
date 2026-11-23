/**
 * FIXTURE vision, detector and frames. NOT a real model: returns canned, clearly labelled evidence so tests can
 * check plumbing (exact text vs interpretation, batch codes kept apart from dates) without any provider.
 */
import type { DetectorService, VisionService } from '../../src/server/contracts.js';
import type { FramePayload, LabelEvidence, ServerDetections } from '../../src/shared/protocol.js';

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
  /** Make the next calls throw (e.g. a VisionError). */
  failWith: unknown;
}

export function createFixtureVision(): FixtureVision {
  const v: FixtureVision = {
    model: FIXTURE_VISION_MODEL,
    extractCalls: [],
    answerCalls: [],
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
