/* global AudioWorkletProcessor, registerProcessor */
/**
 * Mic capture AudioWorklet. Plain JS (loaded with audioWorklet.addModule via `new URL(..., import.meta.url)`).
 * Collects mono Float32 samples at the context's native rate and posts fixed-size blocks to the main
 * thread (transferring the buffer). Downsampling/encoding happens on the main thread (see pcm.ts).
 * The main thread sends { type: 'stop' } before disconnecting; the processor then ends.
 */
class PcmCaptureProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const size = options && options.processorOptions && options.processorOptions.blockSize;
    this.size = typeof size === 'number' && size >= 128 ? size : 2048;
    this.buf = new Float32Array(this.size);
    this.len = 0;
    this.running = true;
    this.port.onmessage = (e) => {
      const d = e.data || {};
      if (d.type === 'stop') this.running = false;
    };
  }

  process(inputs) {
    if (!this.running) return false;
    const input = inputs[0];
    const ch = input && input[0];
    if (ch && ch.length) {
      let offset = 0;
      while (offset < ch.length) {
        const n = Math.min(ch.length - offset, this.size - this.len);
        this.buf.set(ch.subarray(offset, offset + n), this.len);
        this.len += n;
        offset += n;
        if (this.len === this.size) {
          const out = this.buf;
          this.port.postMessage(out, [out.buffer]);
          this.buf = new Float32Array(this.size);
          this.len = 0;
        }
      }
    }
    return true;
  }
}

registerProcessor('pcm-capture', PcmCaptureProcessor);
