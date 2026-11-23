import { describe, expect, it } from 'vitest';
import {
  base64ToBytes,
  bytesToBase64,
  createResampler,
  decodePcm16Base64,
  downsampleTo16k,
  encodePcm16Base64,
  floatToInt16,
  int16ToFloat,
  int16ToLeBytes,
  leBytesToInt16,
  rms,
  rmsOfPcm16Base64,
} from './pcm.js';

const sine = (freq: number, rate: number, n: number, amp = 0.8) => {
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = amp * Math.sin((2 * Math.PI * freq * i) / rate);
  return out;
};

describe('int16 conversion', () => {
  it('clamps and scales', () => {
    expect(Array.from(floatToInt16(Float32Array.from([0, 1, -1, 2, -2, 0.5, Number.NaN])))).toEqual([0, 32767, -32768, 32767, -32768, 16384, 0]);
    const back = int16ToFloat(Int16Array.from([0, -32768, 16384]));
    expect(Array.from(back)).toEqual([0, -1, 0.5]);
  });

  it('encodes little-endian explicitly', () => {
    const bytes = int16ToLeBytes(Int16Array.from([0x0102, -2]));
    expect(Array.from(bytes)).toEqual([0x02, 0x01, 0xfe, 0xff]);
    expect(Array.from(leBytesToInt16(bytes))).toEqual([0x0102, -2]);
  });
});

describe('base64', () => {
  it('round-trips large buffers without stack overflow', () => {
    const big = new Uint8Array(3_000_000);
    for (let i = 0; i < big.length; i++) big[i] = (i * 31) & 0xff;
    const b64 = bytesToBase64(big);
    expect(b64.length).toBe(Math.ceil(big.length / 3) * 4);
    const back = base64ToBytes(b64);
    expect(back.length).toBe(big.length);
    expect(back[123_457]).toBe(big[123_457]);
    expect(bytesToBase64(Uint8Array.from([1, 2, 3]))).toBe('AQID');
  });

  it('pcm16 base64 round trip', () => {
    const s = Float32Array.from([0, 0.25, -0.25, 0.999]);
    const back = decodePcm16Base64(encodePcm16Base64(s));
    for (let i = 0; i < s.length; i++) expect(back[i]).toBeCloseTo(s[i]!, 3);
  });
});

describe('rms', () => {
  it('computes level', () => {
    expect(rms(new Float32Array(10))).toBe(0);
    expect(rms(sine(1000, 48000, 48000, 1))).toBeCloseTo(Math.SQRT1_2, 3);
    expect(rmsOfPcm16Base64(encodePcm16Base64(sine(440, 16000, 16000, 0.5)))).toBeCloseTo(0.5 * Math.SQRT1_2, 2);
  });
});

describe('resampling to 16 kHz', () => {
  it.each([48_000, 44_100])('preserves a 1 kHz tone from %i Hz (amplitude and phase)', (rate) => {
    const input = sine(1000, rate, rate); // 1 s
    const out = downsampleTo16k(input, rate);
    expect(out.length).toBe(16_000);
    const expected = sine(1000, 16_000, 16_000);
    let maxErr = 0;
    for (let i = 200; i < out.length - 200; i++) maxErr = Math.max(maxErr, Math.abs(out[i]! - expected[i]!));
    expect(maxErr).toBeLessThan(0.01);
  });

  it.each([48_000, 44_100])('attenuates a 12 kHz tone (above the 8 kHz Nyquist) from %i Hz', (rate) => {
    const out = downsampleTo16k(sine(12_000, rate, rate), rate);
    expect(rms(out.subarray(200, out.length - 200))).toBeLessThan(0.005); // > 40 dB below 0.57 RMS input
  });

  it('streaming in 128-sample blocks equals one-shot processing', () => {
    const rate = 44_100;
    const input = sine(700, rate, 44_100);
    const r = createResampler(rate);
    const parts: number[] = [];
    for (let i = 0; i < input.length; i += 128) parts.push(...r.process(input.subarray(i, i + 128)));
    const oneShot = createResampler(rate).process(input);
    expect(parts.length).toBe(oneShot.length);
    for (let i = 0; i < oneShot.length; i += 97) expect(parts[i]).toBeCloseTo(oneShot[i]!, 6);
  });

  it('passes through at 16 kHz and produces the right count for 48 kHz blocks', () => {
    const same = createResampler(16_000).process(Float32Array.from([0.1, 0.2, 0.3]));
    expect(Array.from(same)).toEqual([expect.closeTo(0.1, 6), expect.closeTo(0.2, 6), expect.closeTo(0.3, 6)]);
    const r = createResampler(48_000);
    let n = 0;
    for (let i = 0; i < 100; i++) n += r.process(new Float32Array(480)).length;
    // 48 000 samples in -> 16 000 out, minus the filter look-ahead (40 input samples ~ 14 outputs).
    expect(n).toBeGreaterThan(15_980);
    expect(n).toBeLessThanOrEqual(16_000);
  });
});
