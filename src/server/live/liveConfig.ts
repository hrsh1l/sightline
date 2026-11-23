/**
 * Gemini Live connect configuration.
 *
 * Verified against @google/genai 3.6.1 genai.d.ts (LiveConnectConfig) and the lead's provider notes:
 *  - contextWindowCompression is REQUIRED: audio+video sessions are limited to ~2 minutes without it.
 *  - sessionResumption is always requested so the server sends resumable handles (valid ~2 h).
 *  - For gemini-3.8-live, thinkingConfig, enableAffectiveDialog and proactivity must be omitted.
 *  - Native audio models do not accept a language code, so speechConfig only names the voice.
 */
import { Modality, type LiveConnectConfig } from '@google/genai';
import { buildSystemInstruction } from './systemPrompt.js';
import { functionDeclarations } from './tools.js';

export interface LiveConfigInput {
  voiceName: string;
  timeZone: string;
  now: Date;
  /** Latest resumable handle when reconnecting; omitted for a fresh session. */
  resumptionHandle?: string | null | undefined;
}

export function buildLiveConnectConfig(input: LiveConfigInput): LiveConnectConfig {
  return {
    responseModalities: [Modality.AUDIO],
    speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: input.voiceName } } },
    systemInstruction: buildSystemInstruction({ now: input.now, timeZone: input.timeZone }),
    inputAudioTranscription: {},
    outputAudioTranscription: {},
    tools: [{ functionDeclarations }],
    contextWindowCompression: { slidingWindow: {} },
    sessionResumption: input.resumptionHandle ? { handle: input.resumptionHandle } : {},
  };
}
