import type { ServerDetections } from '../../shared/protocol.js';
import { mapBoxToElement, type Size } from './overlayGeometry.js';

const pct = (score: number) => `${Math.round(score * 100)}%`;

/** Visual boxes over the preview (aria-hidden; the summary below carries the same information). */
export function DetectionOverlay({ detections, source, element }: { detections: ServerDetections; source: Size; element: Size }) {
  if (element.width <= 0 || element.height <= 0) return null;
  return (
    <svg
      className="detections"
      width={element.width}
      height={element.height}
      viewBox={`0 0 ${element.width} ${element.height}`}
      aria-hidden="true"
      focusable="false"
      data-testid="detection-overlay"
    >
      {detections.detections.map((d, i) => {
        const r = mapBoxToElement(d.box, source, element, 'contain');
        if (!r) return null;
        const labelY = r.y > 22 ? r.y - 6 : r.y + 18;
        return (
          <g key={`${d.label}-${i}`}>
            <rect className="detections__box" x={r.x} y={r.y} width={r.width} height={r.height} />
            <text className="detections__label" x={r.x + 4} y={labelY}>
              {d.label} {pct(d.score)}
            </text>
          </g>
        );
      })}
    </svg>
  );
}

/**
 * Visually hidden text equivalent of the overlay. Positions are image-relative only: the detector
 * knows nothing about distance or direction, so neither is ever stated.
 */
export function DetectionSummary({ detections }: { detections: ServerDetections | null }) {
  if (!detections || detections.detections.length === 0) return null;
  const items = [...detections.detections]
    .sort((a, b) => b.score - a.score)
    .map((d) => `${d.label} (${pct(d.score)})`)
    .join(', ');
  return (
    <p className="visually-hidden" data-testid="detection-summary">
      Detector sees: {items} — image positions only
    </p>
  );
}
