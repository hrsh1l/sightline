import type { Detection, ServerDetections } from '../../shared/protocol.js';
import type { FindStatus } from '../contracts.js';
import { DETECTION_SOURCE_TEXT, findSummaryText, isFindRunning } from './labels.js';
import { mapBoxToElement, type Size } from './overlayGeometry.js';

const pct = (score: number) => `${Math.round(score * 100)}%`;

/** Chip height allowance (px) above a box; boxes nearer the top get their chip inside instead. */
const CHIP_ABOVE_MIN_Y = 32;

export type OverlaySource = 'yolo' | 'gemini';

/**
 * Boxes to draw: the latest detections, plus the find target from find mode when the detections do not
 * already carry one (e.g. the detector is off but Gemini find is running). The target is drawn last (on top).
 */
export function overlayItems(detections: ServerDetections | null, find: FindStatus | null): Detection[] {
  const items: Detection[] = detections ? [...detections.detections] : [];
  const hasTarget = items.some((d) => d.target === true);
  if (!hasTarget && isFindRunning(find) && find.target && (find.state === 'tracking' || find.state === 'centered')) {
    items.push({ label: find.target.label, score: find.target.score, box: find.target.box, target: true });
  }
  return items.sort((a, b) => Number(a.target === true) - Number(b.target === true));
}

export function overlaySource(detections: ServerDetections | null, find: FindStatus | null): OverlaySource {
  if (detections) return detections.source ?? 'yolo';
  return find?.source ?? 'yolo';
}

/**
 * Green boxes over the preview, positioned in element CSS pixels (object-fit: contain mapping).
 * Decorative (aria-hidden): DetectionSummary carries the same information as text.
 */
export function DetectionOverlay({
  items,
  source,
  sourceSize,
  element,
}: {
  items: Detection[];
  source: OverlaySource;
  sourceSize: Size;
  element: Size;
}) {
  if (element.width <= 0 || element.height <= 0 || items.length === 0) return null;
  return (
    <div className="detections" aria-hidden="true" data-testid="detection-overlay" data-source={source}>
      {items.map((d, i) => {
        const r = mapBoxToElement(d.box, sourceSize, element, 'contain');
        if (!r) return null;
        const target = d.target === true;
        const above = r.y >= CHIP_ABOVE_MIN_Y;
        return (
          <div key={`${d.label}-${i}`} className="detections__item">
            <div
              className={target ? 'detections__box detections__box--target' : 'detections__box'}
              data-testid={target ? 'detection-box-target' : 'detection-box'}
              style={{ left: r.x, top: r.y, width: r.width, height: r.height }}
            />
            <span
              className={[
                'detections__chip',
                above ? 'detections__chip--above' : 'detections__chip--inside',
                target ? 'detections__chip--target' : '',
              ]
                .filter(Boolean)
                .join(' ')}
              style={{ left: r.x, top: above ? r.y : r.y + (target ? 5 : 3), maxWidth: Math.max(element.width - r.x, 48) }}
            >
              {d.label} {pct(d.score)}
            </span>
          </div>
        );
      })}
      <span className="detections__legend" data-testid="detection-legend">
        {DETECTION_SOURCE_TEXT[source]}
      </span>
    </div>
  );
}

/**
 * Visually hidden text equivalent of the overlay. The find target comes first. Positions are image-relative
 * only: neither the detector nor find mode knows distance or direction, so neither is ever stated.
 */
export function DetectionSummary({ detections, find }: { detections: ServerDetections | null; find: FindStatus | null }) {
  const parts: string[] = [];
  if (isFindRunning(find)) parts.push(findSummaryText(find));
  const others = (detections?.detections ?? []).filter((d) => d.target !== true);
  if (others.length > 0) {
    const items = [...others]
      .sort((a, b) => b.score - a.score)
      .map((d) => `${d.label} (${pct(d.score)})`)
      .join(', ');
    parts.push(`Detector sees: ${items} — image positions only`);
  }
  if (parts.length === 0) return null;
  return (
    <p className="visually-hidden" data-testid="detection-summary">
      {parts.join('. ')}
    </p>
  );
}
