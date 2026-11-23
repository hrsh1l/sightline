/**
 * Grounded vision pipeline on Gemini (non-Live generateContent). OWNER: vision agent.
 *
 *  - extractLabel: one high-resolution frame -> structured JSON (model-facing schema below) -> zod parse ->
 *    caps per protocol LIMITS -> date interpretation computed HERE with src/shared/dates.ts (never by the model)
 *    -> LabelEvidence.parse. Any provider/JSON/schema failure throws VisionError; evidence is never fabricated.
 *  - answer: one frame + question (+ short history) -> plain text suitable for TTS.
 *
 * Logging is metadata only (model, latency, sizes, counts, error codes): never image data, prompts or text.
 */
import { ThinkingLevel, type GenerateContentParameters, type Content } from '@google/genai';
import { z } from 'zod';
import {
  DateLabelType,
  ImageIssue,
  LabelEvidence,
  TextSection,
  type DateEvidence,
  type FramePayload,
} from '../../shared/protocol.js';
import { inferDateLabelType, interpretPrintedDate } from '../../shared/dates.js';
import type { AppConfig } from '../config.js';
import { VisionError, type ConversationTurn, type Logger, type VisionService } from '../contracts.js';
import { redactSecrets } from '../log.js';
import { buildAnswerInstruction, buildExtractionInstruction, buildExtractionUserText } from './prompts.js';

/** Minimal structural view of GoogleGenAI used here, so tests can inject a FIXTURE fake. */
export interface GenerateContentClient {
  models: {
    generateContent(params: GenerateContentParameters): Promise<{ readonly text?: string | undefined }>;
  };
}

export interface GeminiVisionOptions {
  /** Abort a provider call after this long (ms). */
  extractTimeoutMs?: number;
  answerTimeoutMs?: number;
  /** Thinking levels; null = do not send thinkingConfig. */
  extractThinking?: ThinkingLevel | null;
  answerThinking?: ThinkingLevel | null;
}

/**
 * Client frame statistic threshold: if the client's mean luma (0..255, downscaled) is below this and the model
 * did not report it, 'too_dark' is added. 40/255 is a very dark frame (typical indoor scenes are 80-140);
 * a conservative threshold so we only add the issue when the image is objectively dark.
 */
export const TOO_DARK_MEAN_LUMA = 40;

/** Caps (protocol LabelEvidence limits). */
const CAP = {
  exactText: 40,
  exactTextChars: 2_000,
  instructions: 8,
  methodChars: 80,
  steps: 20,
  stepChars: 500,
  dates: 6,
  printedTextChars: 200,
  batchCodes: 6,
  batchCodeChars: 80,
  itemGuessChars: 200,
  issues: 8,
  suggestionChars: 200,
  answerChars: 1_200,
  focusChars: 200,
  historyTurns: 6,
  historyTurnChars: 500,
  questionChars: 2_000,
} as const;

const DEFAULTS = {
  extractTimeoutMs: 30_000,
  answerTimeoutMs: 20_000,
  extractThinking: ThinkingLevel.LOW,
  answerThinking: ThinkingLevel.MINIMAL,
} as const;

// ---------------------------------------------------------------------------
// Model-facing schema (JSON Schema for responseJsonSchema). Dates carry only printedText + labelType;
// interpretation is computed on the server.
// ---------------------------------------------------------------------------

const nullableString = (description: string) => ({ type: ['string', 'null'], description });

export const EXTRACTION_RESPONSE_SCHEMA = {
  type: 'object',
  properties: {
    readability: { type: 'string', enum: ['clear', 'partial', 'unreadable'] },
    exactText: {
      type: 'array',
      maxItems: CAP.exactText,
      description: 'Visible text transcribed verbatim, grouped by section.',
      items: {
        type: 'object',
        properties: {
          section: { type: 'string', enum: [...TextSection.options] },
          text: { type: 'string', description: 'Verbatim visible text only.' },
        },
        required: ['section', 'text'],
      },
    },
    instructions: {
      type: 'array',
      maxItems: CAP.instructions,
      items: {
        type: 'object',
        properties: {
          method: { type: 'string', description: 'Method as printed, e.g. Microwave, Oven, Hob.' },
          steps: { type: 'array', maxItems: CAP.steps, items: { type: 'string', description: 'Verbatim step.' } },
        },
        required: ['method', 'steps'],
      },
    },
    dates: {
      type: 'array',
      maxItems: CAP.dates,
      items: {
        type: 'object',
        properties: {
          printedText: { type: 'string', description: 'Exact printed characters including label words.' },
          labelType: { type: 'string', enum: [...DateLabelType.options] },
        },
        required: ['printedText', 'labelType'],
      },
    },
    batchCodes: { type: 'array', maxItems: CAP.batchCodes, items: { type: 'string' }, description: 'Lot/batch codes, never dates.' },
    itemGuess: nullableString('Cautious interpretation of what the item probably is; null if unknown.'),
    issues: { type: 'array', maxItems: CAP.issues, items: { type: 'string', enum: [...ImageIssue.options] } },
    suggestion: nullableString('At most one concrete camera adjustment; null if none needed.'),
  },
  required: ['readability', 'exactText', 'instructions', 'dates', 'batchCodes', 'itemGuess', 'issues', 'suggestion'],
} as const;

/** Structural validation of the model's JSON. Enum values are mapped leniently afterwards. */
const ModelExtraction = z.object({
  readability: z.enum(['clear', 'partial', 'unreadable']),
  exactText: z.array(z.object({ section: z.string(), text: z.string() })).default([]),
  instructions: z.array(z.object({ method: z.string(), steps: z.array(z.string()).default([]) })).default([]),
  dates: z.array(z.object({ printedText: z.string(), labelType: z.string() })).default([]),
  batchCodes: z.array(z.string()).default([]),
  itemGuess: z.string().nullable().default(null),
  issues: z.array(z.string()).default([]),
  suggestion: z.string().nullable().default(null),
});
type ModelExtraction = z.infer<typeof ModelExtraction>;

// ---------------------------------------------------------------------------
// Error classification
// ---------------------------------------------------------------------------

function errorStatus(err: unknown): number | null {
  if (err && typeof err === 'object' && 'status' in err && typeof (err as { status: unknown }).status === 'number') {
    return (err as { status: number }).status;
  }
  return null;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : typeof err === 'string' ? err : '';
}

/** True for a 400 rejecting the thinking configuration (e.g. a model without 'minimal' thinking). */
export function isThinkingUnsupportedError(err: unknown): boolean {
  return errorStatus(err) === 400 && /thinking/i.test(errorMessage(err));
}

/** Map a provider error to a VisionError with a short, safe message. */
export function classifyVisionError(err: unknown, model: string): VisionError {
  if (err instanceof VisionError) return err;
  const status = errorStatus(err);
  const msg = errorMessage(err);
  const make = (text: string, code: VisionError['code']) => new VisionError(redactSecrets(text).slice(0, 200), code);
  switch (status) {
    case 401:
      return make('The vision API key was rejected. Check GEMINI_API_KEY.', 'missing_credentials');
    case 403:
      return /\bmodels?\b/i.test(msg)
        ? make(`No permission to use the vision model ${model}.`, 'model_unavailable')
        : make('The vision API key is not allowed to make this request.', 'missing_credentials');
    case 404:
      return make(`The vision model ${model} is not available.`, 'model_unavailable');
    case 429:
      return make('Vision quota or rate limit reached. Try again shortly.', 'quota_exceeded');
    default:
      return make(status ? `The vision service returned an error (${status}).` : 'The vision service could not be reached.', 'provider_error');
  }
}

// ---------------------------------------------------------------------------
// Normalisation helpers
// ---------------------------------------------------------------------------

const clip = (s: string, n: number) => s.trim().slice(0, n).trim();
const nonEmpty = (s: string) => s.length > 0;

function asEnum<T extends string>(values: readonly T[], v: string, fallback: T): T {
  return (values as readonly string[]).includes(v) ? (v as T) : fallback;
}

function buildEvidence(
  raw: ModelExtraction,
  ctx: { frame: FramePayload; now: Date; timeZone: string; model: string; latencyMs: number },
): LabelEvidence {
  const exactText = raw.exactText
    .map((t) => ({ section: asEnum(TextSection.options, t.section, 'other'), text: clip(t.text, CAP.exactTextChars) }))
    .filter((t) => nonEmpty(t.text))
    .slice(0, CAP.exactText);

  const instructions = raw.instructions
    .map((i) => ({
      method: clip(i.method, CAP.methodChars),
      steps: i.steps.map((s) => clip(s, CAP.stepChars)).filter(nonEmpty).slice(0, CAP.steps),
    }))
    .filter((i) => i.steps.length > 0 || nonEmpty(i.method))
    .slice(0, CAP.instructions);

  const dates: DateEvidence[] = raw.dates
    .map((d) => ({ printedText: clip(d.printedText, CAP.printedTextChars), labelType: asEnum(DateLabelType.options, d.labelType, 'unknown') }))
    .filter((d) => nonEmpty(d.printedText))
    .slice(0, CAP.dates)
    .map((d) => {
      const labelType = d.labelType === 'unknown' ? inferDateLabelType(d.printedText) : d.labelType;
      return { printedText: d.printedText, labelType, interpretation: interpretPrintedDate(d.printedText, labelType, ctx.now, ctx.timeZone) };
    });

  const batchCodes = raw.batchCodes.map((b) => clip(b, CAP.batchCodeChars)).filter(nonEmpty).slice(0, CAP.batchCodes);

  const issues = [...new Set(raw.issues.filter((i): i is ImageIssue => (ImageIssue.options as readonly string[]).includes(i)))];
  const luma = ctx.frame.quality?.meanLuma;
  if (luma !== undefined && luma < TOO_DARK_MEAN_LUMA && !issues.includes('too_dark')) issues.push('too_dark');

  let readability = raw.readability;
  // Conservative consistency: text reported as cut off can't be "clear".
  if (readability === 'clear' && issues.includes('text_cut_off')) readability = 'partial';

  const itemGuess = raw.itemGuess !== null ? clip(raw.itemGuess, CAP.itemGuessChars) || null : null;
  const suggestion = raw.suggestion !== null ? clip(raw.suggestion, CAP.suggestionChars) || null : null;

  return LabelEvidence.parse({
    frameId: ctx.frame.frameId,
    capturedAt: ctx.frame.capturedAt,
    readability,
    exactText,
    instructions,
    dates,
    batchCodes,
    itemGuess,
    issues: issues.slice(0, CAP.issues),
    suggestion,
    model: ctx.model.slice(0, 100),
    latencyMs: Math.max(0, Math.round(ctx.latencyMs)),
  });
}

/** Make model prose safe for TTS: strip markdown markers, collapse whitespace, cap length at a sentence end. */
export function cleanAnswerText(text: string, max: number = CAP.answerChars): string {
  let s = text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/\*\*|__|[*_~]/g, '')
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .replace(/^\s*(?:[-•]|\d+[.)])\s+/gm, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
  if (s.length > max) {
    const cut = s.slice(0, max);
    const end = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('? '), cut.lastIndexOf('! '));
    s = end > max / 2 ? cut.slice(0, end + 1) : `${cut.trimEnd()}…`;
  }
  return s;
}

function historyContents(history: ConversationTurn[]): Content[] {
  return history
    .filter((t) => t.text.trim().length > 0)
    .slice(-CAP.historyTurns)
    .map((t) => ({ role: t.role === 'assistant' ? 'model' : 'user', parts: [{ text: clip(t.text, CAP.historyTurnChars) }] }));
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export function createGeminiVision(deps: {
  ai: GenerateContentClient;
  config: AppConfig;
  log: Logger;
  options?: GeminiVisionOptions;
}): VisionService {
  const { ai, config, log } = deps;
  const model = config.visionModel;
  const opts = { ...DEFAULTS, ...deps.options };
  /** Set once the model rejects thinkingConfig, so later calls skip it. */
  let thinkingUnsupported = false;

  async function generate(
    op: 'extract' | 'answer',
    params: { contents: Content[]; config: NonNullable<GenerateContentParameters['config']> },
    thinkingLevel: ThinkingLevel | null,
    timeoutMs: number,
    callerSignal: AbortSignal | undefined,
  ): Promise<string> {
    const timeoutSignal = AbortSignal.timeout(timeoutMs);
    const signal = callerSignal ? AbortSignal.any([callerSignal, timeoutSignal]) : timeoutSignal;
    const call = (withThinking: boolean) =>
      ai.models.generateContent({
        model,
        contents: params.contents,
        config: {
          ...params.config,
          abortSignal: signal,
          ...(withThinking && thinkingLevel ? { thinkingConfig: { thinkingLevel } } : {}),
        },
      });
    try {
      let res;
      try {
        res = await call(!thinkingUnsupported);
      } catch (err) {
        if (!thinkingUnsupported && thinkingLevel && isThinkingUnsupportedError(err) && !signal.aborted) {
          thinkingUnsupported = true;
          log.warn('vision_thinking_unsupported', { model, op, thinkingLevel });
          res = await call(false);
        } else {
          throw err;
        }
      }
      return res.text ?? '';
    } catch (err) {
      if (callerSignal?.aborted) throw err; // caller cancelled: propagate the abort as-is
      if (timeoutSignal.aborted) {
        log.warn('vision_error', { op, model, code: 'provider_error', reason: 'timeout', timeoutMs });
        throw new VisionError('The vision request timed out.', 'provider_error');
      }
      const ve = classifyVisionError(err, model);
      log.warn('vision_error', { op, model, code: ve.code, status: errorStatus(err) });
      throw ve;
    }
  }

  return {
    model,

    async extractLabel({ frame, focus, now, signal }) {
      const started = performance.now();
      const text = await generate(
        'extract',
        {
          // Text before the image: Gemini image-understanding guidance for single-image prompts.
          contents: [
            {
              role: 'user',
              parts: [{ text: buildExtractionUserText(focus?.slice(0, CAP.focusChars)) }, { inlineData: { mimeType: frame.mimeType, data: frame.data } }],
            },
          ],
          config: {
            systemInstruction: buildExtractionInstruction(now, config.timeZone),
            responseMimeType: 'application/json',
            responseJsonSchema: EXTRACTION_RESPONSE_SCHEMA,
            maxOutputTokens: 8_192,
          },
        },
        opts.extractThinking,
        opts.extractTimeoutMs,
        signal,
      );
      const latencyMs = performance.now() - started;

      let json: unknown;
      try {
        json = JSON.parse(text);
      } catch {
        log.warn('vision_error', { op: 'extract', model, code: 'invalid_output', reason: 'json', outputChars: text.length });
        throw new VisionError('The vision model returned unreadable output.', 'invalid_output');
      }
      const parsed = ModelExtraction.safeParse(json);
      if (!parsed.success) {
        log.warn('vision_error', { op: 'extract', model, code: 'invalid_output', reason: 'schema', outputChars: text.length });
        throw new VisionError('The vision model returned output in an unexpected shape.', 'invalid_output');
      }
      let evidence: LabelEvidence;
      try {
        evidence = buildEvidence(parsed.data, { frame, now, timeZone: config.timeZone, model, latencyMs });
      } catch {
        log.warn('vision_error', { op: 'extract', model, code: 'invalid_output', reason: 'evidence' });
        throw new VisionError('The vision model returned output that could not be used.', 'invalid_output');
      }
      log.info('vision_extract', {
        model,
        latencyMs: evidence.latencyMs,
        imageChars: frame.data.length,
        width: frame.width,
        height: frame.height,
        outputChars: text.length,
        sections: evidence.exactText.length,
        instructions: evidence.instructions.length,
        dates: evidence.dates.length,
        batchCodes: evidence.batchCodes.length,
        readability: evidence.readability,
        issues: evidence.issues.length,
      });
      return evidence;
    },

    async answer({ frame, question, history, now, signal }) {
      const started = performance.now();
      const raw = await generate(
        'answer',
        {
          contents: [
            ...historyContents(history),
            {
              role: 'user',
              parts: [{ text: clip(question, CAP.questionChars) }, { inlineData: { mimeType: frame.mimeType, data: frame.data } }],
            },
          ],
          config: {
            systemInstruction: buildAnswerInstruction(now, config.timeZone),
            maxOutputTokens: 2_048,
          },
        },
        opts.answerThinking,
        opts.answerTimeoutMs,
        signal,
      );
      const text = cleanAnswerText(raw);
      const latencyMs = Math.round(performance.now() - started);
      if (!text) {
        log.warn('vision_error', { op: 'answer', model, code: 'invalid_output', reason: 'empty' });
        throw new VisionError('The vision model returned an empty answer.', 'invalid_output');
      }
      log.info('vision_answer', { model, latencyMs, imageChars: frame.data.length, historyTurns: history.length, answerChars: text.length });
      return { text, latencyMs };
    },
  };
}
