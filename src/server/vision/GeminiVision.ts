/**
 * Grounded vision pipeline on Gemini (non-Live generateContent). OWNER: vision agent.
 *
 *  - extractLabel: one high-resolution frame -> structured JSON (model-facing schema below) -> zod parse ->
 *    caps per protocol LIMITS -> date interpretation computed HERE with src/shared/dates.ts (never by the model)
 *    -> LabelEvidence.parse. Any provider/JSON/schema failure throws VisionError; evidence is never fabricated.
 *    Frames >= DETAIL.minTwoPassSide use two-pass detail reading (detailRead.ts): pass 1 on the fast model finds
 *    text regions on a <= 1536 px overview, the regions are cropped from the full-resolution frame, and pass 2
 *    reads overview (HIGH) + crops (ULTRA_HIGH) together. If pass 1 fails or finds nothing, the whole frame is read
 *    in one call (ULTRA_HIGH when >= 1600 px).
 *  - answer: one frame + question (+ short history) -> plain text suitable for TTS.
 *  - locate: find-mode boxes for one queried item, on the fast model (config.locateModel).
 *  - Resilience: a read/answer that fails transiently on config.visionModel (timeout, 5xx, unreachable, model
 *    missing, empty/truncated/invalid output) is retried ONCE on config.locateModel; evidence.model names the
 *    model actually used.
 *
 * Logging is metadata only (model, latency, sizes, counts, error codes): never image data, prompts or text.
 */
import { PartMediaResolutionLevel, ThinkingLevel, type GenerateContentParameters, type Content, type Part } from '@google/genai';
import { z } from 'zod';
import {
  DateLabelType,
  ImageIssue,
  LabelEvidence,
  LIMITS,
  TextSection,
  type DateEvidence,
  type FramePayload,
} from '../../shared/protocol.js';
import { inferDateLabelType, interpretPrintedDate } from '../../shared/dates.js';
import type { AppConfig } from '../config.js';
import { VisionError, type ConversationTurn, type Logger, type VisionService } from '../contracts.js';
import { redactSecrets } from '../log.js';
import {
  DETAIL,
  REGION_KIND_LABEL,
  REGION_RESPONSE_SCHEMA,
  decodeImage,
  encodeCrop,
  encodeOverview,
  planCrops,
  type DecodedImage,
  type EncodedImage,
} from './detailRead.js';
import { LOCATE, LOCATE_RESPONSE_SCHEMA, parseLocateOutput } from './locate.js';
import {
  buildAnswerInstruction,
  buildCropCaption,
  buildDetailExtractionInstruction,
  buildDetailUserText,
  buildExtractionInstruction,
  buildExtractionUserText,
  buildLocateInstruction,
  buildLocateUserText,
  buildRegionInstruction,
  buildRegionUserText,
} from './prompts.js';

/** Minimal structural view of GoogleGenAI used here, so tests can inject a FIXTURE fake. */
export interface GenerateContentClient {
  models: {
    generateContent(params: GenerateContentParameters): Promise<{
      readonly text?: string | undefined;
      readonly candidates?: ReadonlyArray<{ readonly finishReason?: string | undefined }> | undefined;
    }>;
  };
}

export interface GeminiVisionOptions {
  /**
   * Per-attempt provider timeouts (ms). Worst case for a label read is
   * regionTimeoutMs + extractTimeoutMs + fallbackTimeoutMs (6 + 15 + 9 = 30 s by default).
   */
  extractTimeoutMs?: number;
  answerTimeoutMs?: number;
  /** Detail pass 1 (text-region boxes, fast model). */
  regionTimeoutMs?: number;
  locateTimeoutMs?: number;
  /** The single retry on the fast model after a transient vision-model failure. */
  fallbackTimeoutMs?: number;
  /** Thinking levels; null = do not send thinkingConfig. */
  extractThinking?: ThinkingLevel | null;
  /** Detail pass 2 (overview + crops) on the vision model. */
  detailThinking?: ThinkingLevel | null;
  regionThinking?: ThinkingLevel | null;
  answerThinking?: ThinkingLevel | null;
  locateThinking?: ThinkingLevel | null;
  fallbackThinking?: ThinkingLevel | null;
  /** Two-pass detail reading for large frames. Default true. */
  twoPass?: boolean;
}

/** Frames at least this large (longest side, px) are sent at ULTRA_HIGH when sent whole; smaller ones at HIGH. */
export const ULTRA_HIGH_MIN_SIDE = 1_600;

export function mediaLevelFor(frame: Pick<FramePayload, 'width' | 'height'>): PartMediaResolutionLevel {
  return Math.max(frame.width, frame.height) >= ULTRA_HIGH_MIN_SIDE
    ? PartMediaResolutionLevel.MEDIA_RESOLUTION_ULTRA_HIGH
    : PartMediaResolutionLevel.MEDIA_RESOLUTION_HIGH;
}

const imagePart = (data: string, level: PartMediaResolutionLevel): Part => ({
  inlineData: { mimeType: 'image/jpeg', data },
  mediaResolution: { level },
});

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
  extractTimeoutMs: 15_000,
  answerTimeoutMs: 12_000,
  regionTimeoutMs: 6_000,
  locateTimeoutMs: LOCATE.timeoutMs,
  fallbackTimeoutMs: 9_000,
  extractThinking: ThinkingLevel.LOW,
  detailThinking: ThinkingLevel.MEDIUM,
  regionThinking: ThinkingLevel.MINIMAL,
  answerThinking: ThinkingLevel.MINIMAL,
  locateThinking: ThinkingLevel.MINIMAL,
  fallbackThinking: ThinkingLevel.LOW,
  twoPass: true,
} as const;

/** maxOutputTokens: thinking tokens count against this budget, so keep it generous (an empty reply otherwise). */
const MAX_OUTPUT_TOKENS = {
  extract: 16_384,
  regions: 4_096,
  locate: LOCATE.maxOutputTokens,
  answer: 2_048,
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

type Op = 'extract' | 'regions' | 'answer' | 'locate';

interface GenParams {
  contents: Content[];
  config: NonNullable<GenerateContentParameters['config']>;
}

interface GenResult {
  text: string;
  finishReason: string | null;
}

/** Per-request metadata for the extraction log line (never content). */
interface ExtractMeta {
  /** Provider calls made for this read. */
  passes: number;
  regions: number;
  crops: number;
  cropPx: string;
  overviewPx: string;
  pass1Ms: number | null;
  readMs: number | null;
  /** Why the two-pass read was not used (null = it was, or the frame was small). */
  detailSkipped: string | null;
  /** Why the read was retried on the fallback model (null = no retry). */
  modelFallback: string | null;
  imageChars: number;
  outputChars: number;
}

/** Transient provider failures (timeout, 5xx, unreachable, model missing) worth one retry on the fallback model. */
const RETRYABLE_STATUS = new Set([404, 500, 502, 503, 504]);

export function createGeminiVision(deps: {
  ai: GenerateContentClient;
  config: AppConfig;
  log: Logger;
  options?: GeminiVisionOptions;
}): VisionService {
  const { ai, config, log } = deps;
  const model = config.visionModel;
  /** Fast model: detail pass 1, locate, and the one retry when the vision model fails transiently. */
  const fastModel = config.locateModel || config.visionModel;
  const opts = { ...DEFAULTS, ...deps.options };
  /** `${model}|${level}` pairs the API rejected, so later calls with that pair skip thinkingConfig. */
  const thinkingUnsupported = new Set<string>();
  /** VisionErrors produced by transient failures (see RETRYABLE_STATUS) or unusable output. */
  const retryable = new WeakSet<VisionError>();

  function invalidOutput(op: Op, callModel: string, reason: string, outputChars: number, message: string): VisionError {
    log.warn('vision_error', { op, model: callModel, code: 'invalid_output', reason, outputChars });
    const e = new VisionError(message, 'invalid_output');
    retryable.add(e);
    return e;
  }

  async function generate(
    op: Op,
    callModel: string,
    params: GenParams,
    thinkingLevel: ThinkingLevel | null,
    timeoutMs: number,
    callerSignal: AbortSignal | undefined,
  ): Promise<GenResult> {
    const timeoutSignal = AbortSignal.timeout(timeoutMs);
    const signal = callerSignal ? AbortSignal.any([callerSignal, timeoutSignal]) : timeoutSignal;
    const key = `${callModel}|${thinkingLevel ?? ''}`;
    const call = (withThinking: boolean) =>
      ai.models.generateContent({
        model: callModel,
        contents: params.contents,
        config: {
          ...params.config,
          abortSignal: signal,
          ...(withThinking && thinkingLevel ? { thinkingConfig: { thinkingLevel } } : {}),
        },
      });
    try {
      let res;
      const useThinking = !!thinkingLevel && !thinkingUnsupported.has(key);
      try {
        res = await call(useThinking);
      } catch (err) {
        if (useThinking && isThinkingUnsupportedError(err) && !signal.aborted) {
          thinkingUnsupported.add(key);
          log.warn('vision_thinking_unsupported', { model: callModel, op, thinkingLevel });
          res = await call(false);
        } else {
          throw err;
        }
      }
      return { text: res.text ?? '', finishReason: res.candidates?.[0]?.finishReason ?? null };
    } catch (err) {
      if (callerSignal?.aborted) throw err; // caller cancelled: propagate the abort as-is
      if (timeoutSignal.aborted) {
        log.warn('vision_error', { op, model: callModel, code: 'provider_error', reason: 'timeout', timeoutMs });
        const e = new VisionError('The vision request timed out.', 'provider_error');
        retryable.add(e);
        throw e;
      }
      const ve = classifyVisionError(err, callModel);
      const status = errorStatus(err);
      if (status === null ? ve.code === 'provider_error' : RETRYABLE_STATUS.has(status)) retryable.add(ve);
      log.warn('vision_error', { op, model: callModel, code: ve.code, status });
      throw ve;
    }
  }

  /** JSON ops: empty text, a MAX_TOKENS stop (thinking counts against maxOutputTokens) or bad JSON = invalid_output. */
  async function generateJson(op: Op, callModel: string, params: GenParams, thinking: ThinkingLevel | null, timeoutMs: number, signal: AbortSignal | undefined) {
    const res = await generate(op, callModel, params, thinking, timeoutMs, signal);
    if (res.finishReason === 'MAX_TOKENS') throw invalidOutput(op, callModel, 'max_tokens', res.text.length, 'The vision model ran out of output space.');
    let json: unknown;
    try {
      json = JSON.parse(res.text);
    } catch {
      throw invalidOutput(op, callModel, res.text.trim() ? 'json' : 'empty', res.text.length, 'The vision model returned unreadable output.');
    }
    return { json, outputChars: res.text.length };
  }

  /**
   * Run `attempt` on the vision model; on a retryable failure (timeout, 5xx, unreachable, model missing, unusable
   * output) retry ONCE on the fast model. A caller abort is never retried. If the retry also fails, the original
   * error is thrown (it names the configured model).
   */
  async function withModelFallback<T>(
    op: Op,
    signal: AbortSignal | undefined,
    attempt: (callModel: string, isFallback: boolean) => Promise<T>,
    onFallback: (reason: string) => void,
  ): Promise<{ value: T; usedModel: string }> {
    try {
      return { value: await attempt(model, false), usedModel: model };
    } catch (err) {
      if (signal?.aborted || fastModel === model || !(err instanceof VisionError) || !retryable.has(err)) throw err;
      const reason = err.code === 'invalid_output' ? 'invalid_output' : err.message.includes('timed out') ? 'timeout' : err.code;
      onFallback(reason);
      log.info('vision_model_fallback', { op, from: model, to: fastModel, reason });
      try {
        return { value: await attempt(fastModel, true), usedModel: fastModel };
      } catch (err2) {
        if (signal?.aborted) throw err2;
        throw err;
      }
    }
  }

  function parseExtraction(json: unknown, outputChars: number, callModel: string): ModelExtraction {
    const parsed = ModelExtraction.safeParse(json);
    if (!parsed.success) throw invalidOutput('extract', callModel, 'schema', outputChars, 'The vision model returned output in an unexpected shape.');
    return parsed.data;
  }

  interface ReadRequest {
    parts: Part[];
    systemInstruction: string;
    /** Thinking on the vision model; the fallback model always uses opts.fallbackThinking. */
    thinking: ThinkingLevel | null;
  }

  /** Whole frame in one request (small frames, or when the detail pass is unavailable). */
  function singlePassRequest(frame: FramePayload, focus: string | undefined, now: Date): ReadRequest {
    // Text before the image: Gemini image-understanding guidance for single-image prompts.
    return {
      parts: [{ text: buildExtractionUserText(focus) }, imagePart(frame.data, mediaLevelFor(frame))],
      systemInstruction: buildExtractionInstruction(now, config.timeZone),
      thinking: opts.extractThinking,
    };
  }

  /**
   * Detail pass 1 + crops. Returns the pass-2 request, or null when the single-pass read should be used instead
   * (meta.detailSkipped says why). Throws only on caller abort or rejected credentials.
   */
  async function prepareDetailRead(frame: FramePayload, focus: string | undefined, now: Date, signal: AbortSignal | undefined, meta: ExtractMeta): Promise<ReadRequest | null> {
    let decoded: DecodedImage;
    let overview: EncodedImage;
    try {
      decoded = await decodeImage(frame.data);
      signal?.throwIfAborted();
      overview =
        Math.max(decoded.width, decoded.height) <= DETAIL.overviewMaxSide
          ? { data: frame.data, width: decoded.width, height: decoded.height }
          : await encodeOverview(decoded);
    } catch (err) {
      if (signal?.aborted) throw err;
      meta.detailSkipped = 'decode';
      return null;
    }
    signal?.throwIfAborted();
    meta.overviewPx = `${overview.width}x${overview.height}`;

    // Pass 1 (fast model): where is the text?
    const t1 = performance.now();
    meta.passes++;
    let regionsJson: unknown;
    try {
      regionsJson = (
        await generateJson(
          'regions',
          fastModel,
          {
            contents: [{ role: 'user', parts: [{ text: buildRegionUserText(focus) }, imagePart(overview.data, PartMediaResolutionLevel.MEDIA_RESOLUTION_HIGH)] }],
            config: {
              systemInstruction: buildRegionInstruction(),
              responseMimeType: 'application/json',
              responseJsonSchema: REGION_RESPONSE_SCHEMA,
              maxOutputTokens: MAX_OUTPUT_TOKENS.regions,
            },
          },
          opts.regionThinking,
          opts.regionTimeoutMs,
          signal,
        )
      ).json;
    } catch (err) {
      if (signal?.aborted || (err instanceof VisionError && err.code === 'missing_credentials')) throw err;
      meta.pass1Ms = Math.round(performance.now() - t1);
      meta.detailSkipped = err instanceof VisionError ? `regions_${err.code}` : 'regions_error';
      return null;
    }
    meta.pass1Ms = Math.round(performance.now() - t1);
    const planned = planCrops(regionsJson, decoded.width, decoded.height);
    meta.regions = planned.length;
    if (planned.length === 0) {
      meta.detailSkipped = 'no_regions';
      return null;
    }

    // Crops from the full-resolution frame, within the inline request budget.
    let budget = DETAIL.maxInlineBase64Chars - overview.data.length;
    const crops: { image: EncodedImage; kind: (typeof planned)[number]['kind'] }[] = [];
    try {
      for (const p of planned) {
        signal?.throwIfAborted();
        const image = await encodeCrop(decoded, p.rect);
        if (image.data.length > budget) break;
        budget -= image.data.length;
        crops.push({ image, kind: p.kind });
      }
    } catch (err) {
      if (signal?.aborted) throw err;
      meta.detailSkipped = 'crop';
      return null;
    }
    signal?.throwIfAborted();
    if (crops.length === 0) {
      meta.detailSkipped = 'crop_budget';
      return null;
    }
    meta.crops = crops.length;
    meta.cropPx = crops.map((c) => `${c.image.width}x${c.image.height}`).join(' ');

    // Pass 2 request: overview (HIGH) then each caption + crop (ULTRA_HIGH).
    const parts: Part[] = [{ text: buildDetailUserText(focus, crops.length) }, imagePart(overview.data, PartMediaResolutionLevel.MEDIA_RESOLUTION_HIGH)];
    crops.forEach((c, i) => {
      parts.push({ text: buildCropCaption(i + 1, crops.length, REGION_KIND_LABEL[c.kind]) });
      parts.push(imagePart(c.image.data, PartMediaResolutionLevel.MEDIA_RESOLUTION_ULTRA_HIGH));
    });
    return { parts, systemInstruction: buildDetailExtractionInstruction(now, config.timeZone), thinking: opts.detailThinking };
  }

  return {
    model,

    async extractLabel({ frame, focus, now, signal }) {
      const started = performance.now();
      const f = focus?.slice(0, CAP.focusChars);
      const meta: ExtractMeta = {
        passes: 0,
        regions: 0,
        crops: 0,
        cropPx: '',
        overviewPx: '',
        pass1Ms: null,
        readMs: null,
        detailSkipped: null,
        modelFallback: null,
        imageChars: 0,
        outputChars: 0,
      };

      const detail = opts.twoPass && Math.max(frame.width, frame.height) >= DETAIL.minTwoPassSide ? await prepareDetailRead(frame, f, now, signal, meta) : null;
      const request = detail ?? singlePassRequest(frame, f, now);
      meta.imageChars = request.parts.reduce((n, p) => n + (p.inlineData?.data?.length ?? 0), 0);

      const t2 = performance.now();
      const { value: raw, usedModel } = await withModelFallback(
        'extract',
        signal,
        async (callModel, isFallback) => {
          meta.passes++;
          const { json, outputChars } = await generateJson(
            'extract',
            callModel,
            {
              contents: [{ role: 'user', parts: request.parts }],
              config: {
                systemInstruction: request.systemInstruction,
                responseMimeType: 'application/json',
                responseJsonSchema: EXTRACTION_RESPONSE_SCHEMA,
                maxOutputTokens: MAX_OUTPUT_TOKENS.extract,
              },
            },
            isFallback ? opts.fallbackThinking : request.thinking,
            isFallback ? opts.fallbackTimeoutMs : opts.extractTimeoutMs,
            signal,
          );
          meta.outputChars = outputChars;
          return parseExtraction(json, outputChars, callModel);
        },
        (reason) => (meta.modelFallback = reason),
      );
      meta.readMs = Math.round(performance.now() - t2);
      const latencyMs = performance.now() - started;

      let evidence: LabelEvidence;
      try {
        evidence = buildEvidence(raw, { frame, now, timeZone: config.timeZone, model: usedModel, latencyMs });
      } catch {
        log.warn('vision_error', { op: 'extract', model: usedModel, code: 'invalid_output', reason: 'evidence' });
        throw new VisionError('The vision model returned output that could not be used.', 'invalid_output');
      }
      log.info('vision_extract', {
        model: usedModel,
        latencyMs: evidence.latencyMs,
        passes: meta.passes,
        mode: detail ? 'detail' : 'single',
        detailSkipped: meta.detailSkipped,
        modelFallback: meta.modelFallback,
        regions: meta.regions,
        crops: meta.crops,
        cropPx: meta.cropPx,
        overviewPx: meta.overviewPx,
        pass1Ms: meta.pass1Ms,
        readMs: meta.readMs,
        imageChars: meta.imageChars,
        width: frame.width,
        height: frame.height,
        outputChars: meta.outputChars,
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
      const contents: Content[] = [
        ...historyContents(history),
        { role: 'user', parts: [{ text: clip(question, CAP.questionChars) }, imagePart(frame.data, mediaLevelFor(frame))] },
      ];
      const { value: text, usedModel } = await withModelFallback(
        'answer',
        signal,
        async (callModel, isFallback) => {
          const res = await generate(
            'answer',
            callModel,
            { contents, config: { systemInstruction: buildAnswerInstruction(now, config.timeZone, config.language), maxOutputTokens: MAX_OUTPUT_TOKENS.answer } },
            isFallback ? opts.fallbackThinking : opts.answerThinking,
            isFallback ? opts.fallbackTimeoutMs : opts.answerTimeoutMs,
            signal,
          );
          const cleaned = cleanAnswerText(res.text);
          if (!cleaned) {
            throw invalidOutput('answer', callModel, res.finishReason === 'MAX_TOKENS' ? 'max_tokens' : 'empty', res.text.length, 'The vision model returned an empty answer.');
          }
          if (res.finishReason === 'MAX_TOKENS') log.warn('vision_answer_truncated', { model: callModel, answerChars: cleaned.length });
          return cleaned;
        },
        () => {},
      );
      const latencyMs = Math.round(performance.now() - started);
      log.info('vision_answer', { model: usedModel, latencyMs, imageChars: frame.data.length, historyTurns: history.length, answerChars: text.length });
      return { text, latencyMs };
    },

    async locate({ frame, query, signal }) {
      const started = performance.now();
      const q = query.replace(/\s+/g, ' ').trim().slice(0, LIMITS.maxFindQueryChars);
      if (!q) return { boxes: [], model: fastModel, latencyMs: 0 };
      const { json, outputChars } = await generateJson(
        'locate',
        fastModel,
        {
          // Query in the user turn (untrusted), text before the image.
          contents: [{ role: 'user', parts: [{ text: buildLocateUserText(q) }, imagePart(frame.data, PartMediaResolutionLevel.MEDIA_RESOLUTION_HIGH)] }],
          config: {
            systemInstruction: buildLocateInstruction(),
            responseMimeType: 'application/json',
            responseJsonSchema: LOCATE_RESPONSE_SCHEMA,
            maxOutputTokens: MAX_OUTPUT_TOKENS.locate,
          },
        },
        opts.locateThinking,
        opts.locateTimeoutMs,
        signal,
      );
      const boxes = parseLocateOutput(json, q);
      if (!boxes) throw invalidOutput('locate', fastModel, 'schema', outputChars, 'The vision model returned output in an unexpected shape.');
      const latencyMs = Math.round(performance.now() - started);
      log.info('vision_locate', { model: fastModel, latencyMs, boxes: boxes.length, imageChars: frame.data.length, width: frame.width, height: frame.height });
      return { boxes, model: fastModel, latencyMs };
    },
  };
}
