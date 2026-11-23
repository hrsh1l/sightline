/**
 * Verifies that the configured account can actually use the configured models.
 * A model name appearing in documentation is not proof of account access.
 *
 *   npm run check:models
 *
 * Reads GEMINI_API_KEY from .env / environment. Never prints the key. Sends only a trivial text prompt
 * (no camera, audio or user data). Exit code 0 = both models usable, 1 = a check failed, 2 = no key.
 */
import dotenv from 'dotenv';
import { GoogleGenAI, Modality, type LiveServerMessage } from '@google/genai';
import { loadConfig } from '../src/server/config.js';
import { redactSecrets } from '../src/server/log.js';

dotenv.config({ quiet: true });
const config = loadConfig();

if (!config.geminiApiKey) {
  console.error('GEMINI_API_KEY is not set. Copy .env.example to .env and add your key locally (never paste it into chat).');
  process.exit(2);
}

const ai = new GoogleGenAI({ apiKey: config.geminiApiKey, httpOptions: { apiVersion: 'v1beta' } });
let failed = false;

function describeError(err: unknown): string {
  const status = (err as { status?: number }).status;
  const msg = err instanceof Error ? err.message : String(err);
  return redactSecrets(`${status ? `HTTP ${status}: ` : ''}${msg}`).slice(0, 300);
}

async function checkVision() {
  const model = config.visionModel;
  try {
    const info = await ai.models.get({ model });
    console.info(`[vision] models.get ${model}: ok (${info.displayName ?? info.name ?? 'no display name'})`);
  } catch (err) {
    console.warn(`[vision] models.get ${model}: ${describeError(err)} (continuing with a generate call)`);
  }
  const t0 = performance.now();
  try {
    const res = await ai.models.generateContent({
      model,
      contents: [{ role: 'user', parts: [{ text: 'Reply with the single word OK.' }] }],
      config: { maxOutputTokens: 20 },
    });
    console.info(`[vision] generateContent ${model}: ok in ${Math.round(performance.now() - t0)} ms (reply length ${res.text?.length ?? 0})`);
  } catch (err) {
    failed = true;
    console.error(`[vision] generateContent ${model}: FAILED ${describeError(err)}`);
  }
}

async function checkLive() {
  const model = config.liveModel;
  const t0 = performance.now();
  let firstAudioMs: number | null = null;
  let setupMs: number | null = null;
  let transcript = '';
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('timed out after 20 s waiting for a spoken reply')), 20_000);
      let session: Awaited<ReturnType<typeof ai.live.connect>> | null = null;
      const done = (err?: Error) => {
        clearTimeout(timer);
        try {
          session?.close();
        } catch {
          /* ignore */
        }
        if (err) reject(err);
        else resolve();
      };
      ai.live
        .connect({
          model,
          config: {
            responseModalities: [Modality.AUDIO],
            outputAudioTranscription: {},
            speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: config.liveVoice } } },
          },
          callbacks: {
            onmessage: (msg: LiveServerMessage) => {
              if (msg.setupComplete && setupMs === null) {
                setupMs = Math.round(performance.now() - t0);
                session?.sendRealtimeInput({ text: 'Say the word OK.' });
              }
              for (const part of msg.serverContent?.modelTurn?.parts ?? []) {
                if (part.inlineData?.data && firstAudioMs === null) firstAudioMs = Math.round(performance.now() - t0);
              }
              if (msg.serverContent?.outputTranscription?.text) transcript += msg.serverContent.outputTranscription.text;
              if (msg.serverContent?.turnComplete) done();
            },
            onerror: (e: ErrorEvent) => done(new Error(e.message || 'live error')),
            onclose: (e: CloseEvent) => {
              if (setupMs === null) done(new Error(`closed before setup (code ${e.code}${e.reason ? `: ${e.reason}` : ''})`));
            },
          },
        })
        .then((s) => {
          session = s;
          // Some SDK versions resolve connect after setupComplete: send if setup already arrived.
          if (setupMs !== null) s.sendRealtimeInput({ text: 'Say the word OK.' });
        }, done);
    });
    console.info(
      `[live] ${model}: ok (setup ${setupMs ?? '?'} ms, first audio ${firstAudioMs ?? 'none'} ms after connect, transcript chars ${transcript.length})`,
    );
    if (firstAudioMs === null) {
      failed = true;
      console.error('[live] no audio received');
    }
  } catch (err) {
    failed = true;
    console.error(`[live] ${model}: FAILED ${describeError(err)}`);
  }
}

await checkVision();
await checkLive();
process.exit(failed ? 1 : 0);
