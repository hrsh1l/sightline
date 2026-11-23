/**
 * Drawing/encoding surface used by CameraController.capture(). Injected so unit tests (jsdom has no
 * canvas encoder) can stub it; the browser default uses OffscreenCanvas when available, else a
 * detached HTMLCanvasElement.
 */
import type { ImageDataLike } from './frameQuality.js';

export interface FrameSurface {
  /** Draw the full source frame into the whole surface. Identity transform: never mirrored. */
  draw(source: CanvasImageSource): void;
  /** Encode the current pixels as JPEG; resolves to base64 WITHOUT a data: prefix. */
  encodeJpeg(quality: number): Promise<string>;
  /** Small RGBA copy (longest side <= maxSide) for frame statistics, or null if unsupported. */
  sample(maxSide: number): ImageDataLike | null;
}

/** Creates a fresh surface of exactly width x height pixels. */
export type SurfaceFactory = (width: number, height: number) => FrameSurface;

type AnyCanvas = OffscreenCanvas | HTMLCanvasElement;
type Ctx2D = OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D;

function makeCanvas(width: number, height: number, doc: Document | undefined): AnyCanvas {
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(width, height);
  if (!doc) throw new Error('No canvas implementation available');
  const c = doc.createElement('canvas');
  c.width = width;
  c.height = height;
  return c;
}

function context2d(canvas: AnyCanvas, opts: CanvasRenderingContext2DSettings): Ctx2D {
  const ctx = canvas.getContext('2d', opts) as Ctx2D | null;
  if (!ctx) throw new Error('2D canvas context unavailable');
  return ctx;
}

function canvasToJpegBlob(canvas: AnyCanvas, quality: number): Promise<Blob> {
  if ('convertToBlob' in canvas) return canvas.convertToBlob({ type: 'image/jpeg', quality });
  return new Promise((resolve, reject) => {
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('JPEG encoding failed'))), 'image/jpeg', quality);
  });
}

/** Base64 of raw bytes, chunked so String.fromCharCode never receives too many arguments. */
export function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

export function createCanvasSurfaceFactory(doc: Document | undefined = globalThis.document): SurfaceFactory {
  return (width, height) => {
    const canvas = makeCanvas(width, height, doc);
    // alpha:false: JPEG has no alpha and an opaque canvas avoids premultiplication work.
    const ctx = context2d(canvas, { alpha: false });
    return {
      draw(source) {
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.drawImage(source, 0, 0, width, height);
      },
      async encodeJpeg(quality) {
        // The canvas bitmap is copied synchronously when encoding starts (per the HTML spec for
        // toBlob/convertToBlob), so later draws on other surfaces cannot leak into this frame.
        const blob = await canvasToJpegBlob(canvas, quality);
        // Browsers silently fall back to PNG for unsupported types; refuse rather than mislabel.
        if (blob.type !== 'image/jpeg') throw new Error(`Encoder produced ${blob.type || 'unknown type'}`);
        return bytesToBase64(new Uint8Array(await blob.arrayBuffer()));
      },
      sample(maxSide) {
        const scale = Math.min(1, maxSide / Math.max(width, height));
        const sw = Math.max(1, Math.round(width * scale));
        const sh = Math.max(1, Math.round(height * scale));
        const small = makeCanvas(sw, sh, doc);
        const sctx = context2d(small, { willReadFrequently: true });
        sctx.drawImage(canvas, 0, 0, sw, sh);
        return sctx.getImageData(0, 0, sw, sh);
      },
    };
  };
}
