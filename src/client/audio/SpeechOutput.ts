/**
 * Browser speechSynthesis wrapper for snapshot-mode answers. Prefers an en-GB voice when available.
 * Also exposes onSpeakingChange (beyond the SpeechOutput contract) so the controller can track `speaking`.
 */
import type { SpeechOutput, Unsubscribe } from '../contracts.js';

export interface SpeechOutputWithEvents extends SpeechOutput {
  onSpeakingChange(cb: (speaking: boolean) => void): Unsubscribe;
}

export interface SpeechOutputOptions {
  synth?: SpeechSynthesis | null;
  createUtterance?: (text: string) => SpeechSynthesisUtterance | null;
  lang?: string;
}

export function pickVoice(voices: readonly SpeechSynthesisVoice[], lang = 'en-GB'): SpeechSynthesisVoice | null {
  const norm = (s: string) => s.replace('_', '-').toLowerCase();
  const want = norm(lang);
  const exact = voices.filter((v) => norm(v.lang) === want);
  return exact.find((v) => v.localService) ?? exact[0] ?? voices.find((v) => norm(v.lang).startsWith('en')) ?? null;
}

export function createSpeechOutput(opts: SpeechOutputOptions = {}): SpeechOutputWithEvents {
  const synth = opts.synth !== undefined ? opts.synth : typeof window !== 'undefined' && 'speechSynthesis' in window ? window.speechSynthesis : null;
  const createUtterance =
    opts.createUtterance ?? ((text: string) => (typeof SpeechSynthesisUtterance !== 'undefined' ? new SpeechSynthesisUtterance(text) : null));
  const lang = opts.lang ?? 'en-GB';
  const listeners = new Set<(speaking: boolean) => void>();
  let speaking = false;
  let current: SpeechSynthesisUtterance | null = null;
  let voice: SpeechSynthesisVoice | null = null;

  const refreshVoice = () => {
    try {
      voice = synth ? pickVoice(synth.getVoices(), lang) : null;
    } catch {
      voice = null;
    }
  };
  refreshVoice();
  synth?.addEventListener?.('voiceschanged', refreshVoice);

  const setSpeaking = (v: boolean) => {
    if (speaking === v) return;
    speaking = v;
    for (const l of [...listeners]) l(v);
  };

  return {
    get supported() {
      return synth !== null && (opts.createUtterance !== undefined || typeof SpeechSynthesisUtterance !== 'undefined');
    },
    get speaking() {
      return speaking;
    },
    speak(text: string) {
      if (!synth) return;
      const t = text.trim();
      if (!t) return;
      synth.cancel();
      const u = createUtterance(t);
      if (!u) return;
      u.lang = lang;
      if (!voice) refreshVoice();
      if (voice) u.voice = voice;
      u.rate = 1;
      current = u;
      const done = () => {
        if (current === u) {
          current = null;
          setSpeaking(false);
        }
      };
      u.onstart = () => {
        if (current === u) setSpeaking(true);
      };
      u.onend = done;
      u.onerror = done;
      setSpeaking(true);
      synth.speak(u);
    },
    cancel() {
      current = null;
      try {
        synth?.cancel();
      } catch {
        /* ignore */
      }
      setSpeaking(false);
    },
    onSpeakingChange(cb) {
      listeners.add(cb);
      return (() => listeners.delete(cb)) as Unsubscribe;
    },
  };
}
