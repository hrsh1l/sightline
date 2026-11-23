/** Environment configuration. OWNER: lead. Secrets are read here and never serialised to clients or logs. */
import { z } from 'zod';

const boolish = z
  .string()
  .optional()
  .transform((v) => v === '1' || v?.toLowerCase() === 'true');

const EnvSchema = z.object({
  NODE_ENV: z.string().optional(),
  GEMINI_API_KEY: z.string().optional(),
  LIVE_MODEL: z.string().min(1).default('gemini-3.8-live'),
  VISION_MODEL: z.string().min(1).default('gemini-3.6-flash'),
  LIVE_VOICE: z.string().min(1).default('Kore'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  HOST: z.string().min(1).default('127.0.0.1'),
  ACCESS_TOKEN: z.string().optional(),
  ALLOWED_ORIGINS: z.string().optional(),
  MAX_SESSION_MINUTES: z.coerce.number().positive().max(120).default(20),
  MAX_CONCURRENT_SESSIONS: z.coerce.number().int().positive().max(20).default(2),
  APP_TIMEZONE: z.string().min(1).default('Europe/London'),
  DETECTOR_URL: z.string().optional(),
  /** Test hook only: freeze "now" (ISO string) for deterministic date comparisons. */
  SIGHTLINE_FAKE_NOW: z.string().optional(),
  LOG_DEBUG: boolish,
});

export interface AppConfig {
  production: boolean;
  /** Present only on the server. Never send to clients. */
  geminiApiKey: string | null;
  liveModel: string;
  visionModel: string;
  liveVoice: string;
  port: number;
  host: string;
  accessToken: string | null;
  allowedOrigins: string[];
  maxSessionMs: number;
  maxConcurrentSessions: number;
  timeZone: string;
  detectorUrl: string | null;
  fakeNow: Date | null;
  debug: boolean;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new Error(`Invalid environment: ${issue?.path.join('.')}: ${issue?.message}`);
  }
  const e = parsed.data;
  const blank = (v: string | undefined) => (v && v.trim() ? v.trim() : null);
  try {
    new Intl.DateTimeFormat('en-GB', { timeZone: e.APP_TIMEZONE });
  } catch {
    throw new Error(`Invalid APP_TIMEZONE: ${e.APP_TIMEZONE}`);
  }
  const detectorUrl = blank(e.DETECTOR_URL);
  if (detectorUrl) {
    const u = new URL(detectorUrl);
    if (!['127.0.0.1', 'localhost', '::1', '[::1]'].includes(u.hostname)) {
      throw new Error('DETECTOR_URL must point to a private local service (localhost/127.0.0.1).');
    }
  }
  const fakeNow = blank(e.SIGHTLINE_FAKE_NOW);
  return {
    production: e.NODE_ENV === 'production',
    geminiApiKey: blank(e.GEMINI_API_KEY),
    liveModel: e.LIVE_MODEL,
    visionModel: e.VISION_MODEL,
    liveVoice: e.LIVE_VOICE,
    port: e.PORT,
    host: e.HOST,
    accessToken: blank(e.ACCESS_TOKEN),
    allowedOrigins: (e.ALLOWED_ORIGINS ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    maxSessionMs: Math.round(e.MAX_SESSION_MINUTES * 60_000),
    maxConcurrentSessions: e.MAX_CONCURRENT_SESSIONS,
    timeZone: e.APP_TIMEZONE,
    detectorUrl,
    fakeNow: fakeNow ? new Date(fakeNow) : null,
    debug: e.LOG_DEBUG,
  };
}
