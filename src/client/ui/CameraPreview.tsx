import { useCallback, useEffect, useState } from 'react';
import type { AssistantController, CameraState } from '../contracts.js';
import type { ServerDetections } from '../../shared/protocol.js';
import { DetectionOverlay, DetectionSummary } from './DetectionOverlay.js';
import type { Size } from './overlayGeometry.js';

/**
 * The <video> the controller captures frames from. It stays mounted for the whole session; when the
 * preview is hidden it collapses to a tiny, still-rendered element (never display:none, which can
 * stop decoding). It is decorative for screen readers: everything it shows is available as text.
 */
export function CameraPreview({
  controller,
  camera,
  detections,
  show,
}: {
  controller: AssistantController;
  camera: CameraState;
  detections: ServerDetections | null;
  show: boolean;
}) {
  const [videoEl, setVideoEl] = useState<HTMLVideoElement | null>(null);
  const [elementSize, setElementSize] = useState<Size>({ width: 0, height: 0 });

  // Stable ref callback: attach once on mount, detach on unmount (React 19 ref cleanup).
  const videoRef = useCallback(
    (el: HTMLVideoElement | null) => {
      controller.attachVideo(el);
      setVideoEl(el);
      return () => {
        controller.attachVideo(null);
        setVideoEl(null);
      };
    },
    [controller],
  );

  useEffect(() => {
    if (!videoEl) return;
    const measure = () => setElementSize({ width: videoEl.clientWidth, height: videoEl.clientHeight });
    measure();
    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', measure);
      return () => window.removeEventListener('resize', measure);
    }
    const ro = new ResizeObserver(measure);
    ro.observe(videoEl);
    return () => ro.disconnect();
  }, [videoEl, show]);

  // Displayed content aspect is the video's intrinsic size; fall back to the detection source size.
  const source: Size =
    camera.videoWidth > 0 && camera.videoHeight > 0
      ? { width: camera.videoWidth, height: camera.videoHeight }
      : { width: detections?.sourceWidth ?? 0, height: detections?.sourceHeight ?? 0 };

  return (
    <>
      <div className={show ? 'preview' : 'preview preview--collapsed'} aria-hidden="true" data-testid="preview">
        <video ref={videoRef} className="preview__video" playsInline muted autoPlay disablePictureInPicture />
        {show && detections && detections.detections.length > 0 && (
          <DetectionOverlay detections={detections} source={source} element={elementSize} />
        )}
        {show && camera.status !== 'active' && <p className="preview__placeholder">Camera off</p>}
      </div>
      <DetectionSummary detections={detections} />
    </>
  );
}
