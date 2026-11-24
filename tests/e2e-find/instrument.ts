/**
 * Test-only page instrumentation (injected with page.addInitScript; no product code changes).
 * Records: StereoPannerNode pan automation values, oscillator/buffer starts (cue pulses), speechSynthesis
 * utterances (and fires their end events, since headless Chromium has no voices), and when the camera opened.
 */
import type { Page } from '@playwright/test';

export interface CueLog {
  t0: number | null;
  pans: { t: number; v: number }[];
  starts: { t: number; kind: 'osc' | 'buffer' }[];
  speech: { t: number; text: string }[];
}

export async function instrument(page: Page) {
  await page.addInitScript(() => {
    const log = { t0: null as number | null, pans: [] as { t: number; v: number }[], starts: [] as { t: number; kind: string }[], speech: [] as { t: number; text: string }[] };
    (window as unknown as { __cues: typeof log }).__cues = log;
    const tagged = new WeakSet<AudioParam>();
    const origCreate = BaseAudioContext.prototype.createStereoPanner;
    BaseAudioContext.prototype.createStereoPanner = function (this: BaseAudioContext) {
      const n = origCreate.call(this);
      tagged.add(n.pan);
      return n;
    };
    const Orig = window.StereoPannerNode;
    window.StereoPannerNode = class extends Orig {
      constructor(ctx: BaseAudioContext, o?: StereoPannerOptions) {
        super(ctx, o);
        tagged.add(this.pan);
      }
    } as typeof StereoPannerNode;
    for (const m of ['setValueAtTime', 'setTargetAtTime', 'linearRampToValueAtTime'] as const) {
      const o = AudioParam.prototype[m] as (...a: unknown[]) => AudioParam;
      (AudioParam.prototype as unknown as Record<string, unknown>)[m] = function (this: AudioParam, v: number, ...rest: unknown[]) {
        if (tagged.has(this)) log.pans.push({ t: performance.now(), v });
        return o.call(this, v, ...rest);
      };
    }
    const desc = Object.getOwnPropertyDescriptor(AudioParam.prototype, 'value')!;
    Object.defineProperty(AudioParam.prototype, 'value', {
      configurable: true,
      get(this: AudioParam) {
        return desc.get!.call(this);
      },
      set(this: AudioParam, v: number) {
        if (tagged.has(this)) log.pans.push({ t: performance.now(), v });
        desc.set!.call(this, v);
      },
    });
    const os = OscillatorNode.prototype.start;
    OscillatorNode.prototype.start = function (this: OscillatorNode, ...a: [number?]) {
      log.starts.push({ t: performance.now(), kind: 'osc' });
      return os.apply(this, a);
    };
    const bs = AudioBufferSourceNode.prototype.start;
    AudioBufferSourceNode.prototype.start = function (this: AudioBufferSourceNode, ...a: [number?, number?, number?]) {
      log.starts.push({ t: performance.now(), kind: 'buffer' });
      return bs.apply(this, a);
    };
    speechSynthesis.speak = (u: SpeechSynthesisUtterance) => {
      log.speech.push({ t: performance.now(), text: u.text });
      setTimeout(() => {
        u.dispatchEvent(new Event('start'));
        u.onstart?.(new Event('start') as SpeechSynthesisEvent);
        setTimeout(() => {
          u.dispatchEvent(new Event('end'));
          u.onend?.(new Event('end') as SpeechSynthesisEvent);
        }, 400);
      }, 20);
    };
    const gum = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    navigator.mediaDevices.getUserMedia = async (c?: MediaStreamConstraints) => {
      const s = await gum(c);
      if (c && c.video && log.t0 === null) log.t0 = performance.now();
      return s;
    };
  });
}

export async function readLog(page: Page): Promise<CueLog> {
  return page.evaluate(() => (window as unknown as { __cues: CueLog }).__cues);
}

/** Target pan in effect at time t (last automation value at or before t). */
export function panAt(log: CueLog, t: number): number | null {
  let v: number | null = null;
  for (const p of log.pans) if (p.t <= t) v = p.v;
  return v;
}
