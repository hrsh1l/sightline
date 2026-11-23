// PLACEHOLDER (lead scaffold). Vision agent replaces this with the real implementation.
import type { GoogleGenAI } from '@google/genai';
import type { AppConfig } from '../config.js';
import { VisionError, type Logger, type VisionService } from '../contracts.js';

export function createGeminiVision(deps: { ai: GoogleGenAI; config: AppConfig; log: Logger }): VisionService {
  return {
    model: deps.config.visionModel,
    extractLabel: () => Promise.reject(new VisionError('not implemented', 'provider_error')),
    answer: () => Promise.reject(new VisionError('not implemented', 'provider_error')),
  };
}
