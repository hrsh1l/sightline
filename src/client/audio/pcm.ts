/**
 * Pure PCM helpers (no DOM dependencies; unit-tested).
 *
 * Wire formats (see src/shared/protocol.ts):
 *  - mic -> server: PCM16 little-endian mono @ 16 kHz, base64
 *  - server -> speaker: PCM16 little-endian mono @ 24 kHz, base64
 */

/** Float32 [-1, 1] -> Int16 with clamping (asymmetric scale so -1 maps to -32768 and 1 to 32767). */
export function floatToInt16(input: Float32Array): Int16Array {
  const out = new Int16Array(input.length);
  for (let i = 0; i < input.length; i++) {
    const v = input[i]!;
    const s = v > 1 ? 1 : v < -1 ? -1 : Number.isNaN(v) ? 0 : v;
    out[i] = s < 0 ? Math.round(s * 0x8000) : Math.round(s * 0x7fff);
  }
  return out;
}

/** Int16 -> Float32 in [-1, 1). */
export function int16ToFloat(input: Int16Array): Float32Array {
  const out = new Float32Array(input.length);
  for (let i = 0; i < input.length; i++) out[i] = input[i]! / 0x8000;
  return out;
}

/** Encode Int16 samples as little-endian bytes regardless of platform endianness. */
export function int16ToLeBytes(samples: Int16Array): Uint8Array {
  const bytes = new Uint8Array(samples.length * 2);
  const view = new DataView(bytes.buffer);
  for (let i = 0; i < samples.length; i++) view.setInt16(i * 2, samples[i]!, true);
  return bytes;
}

/** Decode little-endian PCM16 bytes into Int16 samples. A trailing odd byte is ignored. */
export function leBytesToInt16(bytes: Uint8Array): Int16Array {
  const n = bytes.byteLength >> 1;
  const out = new Int16Array(n);
  const view = new DataView(bytes.buffer, bytes.byteOffset, n * 2);
  for (let i = 0; i < n; i++) out[i] = view.getInt16(i * 2, true);
  return out;
}

const B64_CHUNK = 0x8000;

/** Base64-encode bytes in chunks (no call-stack overflow on large buffers). */
export function bytesToBase64(bytes: Uint8Array | ArrayBuffer): string {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let binary = '';
  for (let i = 0; i < u8.length; i += B64_CHUNK) {
    binary += String.fromCharCode.apply(null, u8.subarray(i, i + B64_CHUNK) as unknown as number[]);
  }
  return btoa(binary);
}

export function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

/** Float32 samples -> base64 PCM16 LE. */
export function encodePcm16Base64(samples: Float32Array): string {
  return bytesToBase64(int16ToLeBytes(floatToInt16(samples)));
}

/** base64 PCM16 LE -> Float32 samples. */
export function decodePcm16Base64(b64: string): Float32Array {
  return int16ToFloat(leBytesToInt16(base64ToBytes(b64)));
}

/** Root-mean-square level of a block, 0..1. */
export function rms(samples: ArrayLike<number>): number {
  if (samples.length === 0) return 0;
  let sum = 0;
  for (let i = 0; i < samples.length; i++) {
    const v = samples[i]!;
    sum += v * v;
  }
  return Math.sqrt(sum / samples.length);
}

/** RMS of base64 PCM16 LE audio (0..1). */
export function rmsOfPcm16Base64(b64: string): number {
  const s = leBytesToInt16(base64ToBytes(b64));
  if (s.length === 0) return 0;
  let sum = 0;
  for (let i = 0; i < s.length; i++) {
    const v = s[i]! / 0x8000;
    sum += v * v;
  }
  return Math.sqrt(sum / s.length);
}

/**
 * Windowed-sinc (Blackman) low-pass FIR. `cutoff` is in cycles/sample of the input rate (0..0.5).
 * Taps are normalised to unity DC gain.
 */
export function designLowPass(cutoff: number, halfLength: number): Float32Array {
  const n = 2 * halfLength + 1;
  const taps = new Float32Array(n);
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const k = i - halfLength;
    const sinc = k === 0 ? 2 * cutoff : Math.sin(2 * Math.PI * cutoff * k) / (Math.PI * k);
    const w = 0.42 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1)) + 0.08 * Math.cos((4 * Math.PI * i) / (n - 1));
    taps[i] = sinc * w;
    sum += taps[i]!;
  }
  for (let i = 0; i < n; i++) taps[i]! /= sum;
  return taps;
}

export interface Resampler {
  readonly inputRate: number;
  readonly outputRate: number;
  /** Feed a block; returns the output samples that are now complete (may be empty). */
  process(input: Float32Array): Float32Array;
  reset(): void;
}

/**
 * Streaming resampler, normally used to downsample the mic (48 kHz or 44.1 kHz) to 16 kHz.
 *
 * Anti-aliasing: when downsampling, the input is low-pass filtered with a linear-phase Blackman FIR
 * (cutoff 0.45 x output rate, 81 taps), evaluated only at the output positions. Fractional positions
 * (e.g. 44.1 kHz -> 16 kHz, ratio 2.75625) are linearly interpolated between two filtered samples.
 * The filter is centred (non-causal) so output sample k corresponds exactly to input time k * ratio;
 * this costs halfLength input samples (~0.8 ms at 48 kHz) of latency. State carries across blocks.
 */
export function createResampler(inputRate: number, outputRate = 16_000, halfLength = 40): Resampler {
  if (!(inputRate > 0) || !(outputRate > 0)) throw new Error('invalid sample rate');
  const ratio = inputRate / outputRate;
  const downsampling = ratio > 1;
  const taps = downsampling ? designLowPass((0.45 * outputRate) / inputRate, halfLength) : null;
  const M = downsampling ? halfLength : 0;

  // buffer holds input samples starting at absolute index `bufStart`.
  let buf = new Float32Array(0);
  let bufStart = 0;
  let totalIn = 0;
  let outCount = 0;

  const sampleAt = (abs: number): number => {
    const i = abs - bufStart;
    return i >= 0 && i < buf.length ? buf[i]! : 0; // before stream start (or trimmed away): zero
  };

  const filteredAt = (abs: number): number => {
    if (!taps) return sampleAt(abs);
    let acc = 0;
    // taps symmetric: y[n] = sum_j h[j] x[n + j - M]
    const base = abs - M - bufStart;
    if (base >= 0 && base + taps.length <= buf.length) {
      for (let j = 0; j < taps.length; j++) acc += taps[j]! * buf[base + j]!;
    } else {
      for (let j = 0; j < taps.length; j++) acc += taps[j]! * sampleAt(abs + j - M);
    }
    return acc;
  };

  return {
    inputRate,
    outputRate,
    process(input: Float32Array): Float32Array {
      // Append input.
      const merged = new Float32Array(buf.length + input.length);
      merged.set(buf, 0);
      merged.set(input, buf.length);
      buf = merged;
      totalIn += input.length;

      const out: number[] = [];
      for (;;) {
        const pos = (outCount * inputRate) / outputRate;
        const i0 = Math.floor(pos);
        const frac = pos - i0;
        const needed = frac > 1e-9 ? i0 + 1 + M : i0 + M; // highest absolute input index required
        if (needed >= totalIn) break;
        const a = filteredAt(i0);
        out.push(frac > 1e-9 ? a + (filteredAt(i0 + 1) - a) * frac : a);
        outCount++;
      }

      // Trim samples no longer needed (keep M before the next position for the filter).
      const nextPos = Math.floor((outCount * inputRate) / outputRate);
      const keepFrom = Math.max(bufStart, nextPos - M);
      if (keepFrom > bufStart) {
        buf = buf.slice(keepFrom - bufStart);
        bufStart = keepFrom;
      }
      return Float32Array.from(out);
    },
    reset() {
      buf = new Float32Array(0);
      bufStart = 0;
      totalIn = 0;
      outCount = 0;
    },
  };
}

/** One-shot convenience: resample a whole buffer (resets state). */
export function downsampleTo16k(input: Float32Array, inputRate: number): Float32Array {
  const r = createResampler(inputRate, 16_000);
  const head = r.process(input);
  // Flush the filter tail with zeros so the last outputs are produced.
  const tail = r.process(new Float32Array(Math.ceil(inputRate / 16_000) + 64));
  const expected = Math.floor((input.length * 16_000) / inputRate);
  const all = new Float32Array(head.length + tail.length);
  all.set(head, 0);
  all.set(tail, head.length);
  return all.subarray(0, expected);
}
