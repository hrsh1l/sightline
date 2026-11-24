import type { Detection, NormalizedBox, ServerDetections } from '../../shared/protocol.js';
import type { FindStatus } from '../contracts.js';
import { candidatePositionText, findSummaryText, isFindRunning } from './findText.js';
import { DETECTION_SOURCE_TEXT } from './labels.js';
import { mapBoxToElement, type Size } from './overlayGeometry.js';

const pct = (score: number) => `${Math.round(score * 100)}%`;

/** Chip height allowance (px) above a box; boxes nearer the top get their chip inside instead. */
const CHIP_ABOVE_MIN_Y = 32;

export type OverlaySource = 'yolo' | 'gemini';

/** One box to draw. `kind` picks the style; `chip` is the visible label text. */
export interface OverlayItem {
  kind: 'detection' | 'target' | 'candidate';
  box: NormalizedBox;
  chip: string;
}

const sameBox = (a: NormalizedBox, b: NormalizedBox) =>
  Math.abs(a.x - b.x) < 0.01 && Math.abs(a.y - b.y) < 0.01 && Math.abs(a.w - b.w) < 0.01 && Math.abs(a.h - b.h) < 0.01;

const detectionItem = (d: Detection): OverlayItem => ({
  kind: d.target === true ? 'target' : 'detection',
  box: d.box,
  chip: `${d.label} ${pct(d.score)}`,
});

const RANK: Record<OverlayItem['kind'], number> = { detection: 0, candidate: 1, target: 2 };

/**
 * Boxes to draw: the latest detections; the find target from find mode when the detections do not already carry
 * one (e.g. the detector is off but Gemini find is running); and, while the user must choose, each candidate
 * labelled "Left" / "Middle" / "Right" (replacing the matching plain detection box). Order: plain detections,
 * candidates, then the target on top.
 */
export function overlayItems(detections: ServerDetections | null, find: FindStatus | null): OverlayItem[] {
  const dets = detections ? detections.detections : [];
  const candidates = isFindRunning(find) && find.state === 'needs_selection' ? (find.candidates ?? []) : [];
  const items: OverlayItem[] = dets
    .filter((d) => d.target === true || !candidates.some((c) => sameBox(c.box, d.box)))
    .map(detectionItem);
  for (const c of candidates) items.push({ kind: 'candidate', box: c.box, chip: candidatePositionText(c) });
  const hasTarget = items.some((d) => d.kind === 'target');
  if (!hasTarget && isFindRunning(find) && find.target && (find.state === 'tracking' || find.state === 'centered')) {
    items.push({ kind: 'target', box: find.target.box, chip: `${find.target.label} ${pct(find.target.score)}` });
  }
  return items.sort((a, b) => RANK[a.kind] - RANK[b.kind]);
}

export function overlaySource(detections: ServerDetections | null, find: FindStatus | null): OverlaySource {
  if (detections) return detections.source ?? 'yolo';
  return find?.source ?? 'yolo';
}

const BOX_CLASS: Record<OverlayItem['kind'], string> = {
  detection: 'detections__box',
  target: 'detections__box detections__box--target',
  candidate: 'detections__box detections__box--candidate',
};

const BOX_TESTID: Record<OverlayItem['kind'], string> = {
  detection: 'detection-box',
  target: 'detection-box-target',
  candidate: 'detection-box-candidate',
};

/**
 * Green boxes over the preview, positioned in element CSS pixels (object-fit: contain mapping).
 * Decorative (aria-hidden): DetectionSummary and the Find panel carry the same information as text, and no
 * action needs the preview.
 */
export function DetectionOverlay({
  items,
  source,
  sourceSize,
  element,
}: {
  items: OverlayItem[];
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
        const emphasised = d.kind !== 'detection';
        const above = r.y >= CHIP_ABOVE_MIN_Y;
        return (
          <div key={`${d.kind}-${d.chip}-${i}`} className="detections__item">
            <div
              className={BOX_CLASS[d.kind]}
              data-testid={BOX_TESTID[d.kind]}
              style={{ left: r.x, top: r.y, width: r.width, height: r.height }}
            />
            <span
              className={[
                'detections__chip',
                above ? 'detections__chip--above' : 'detections__chip--inside',
                d.kind === 'target' ? 'detections__chip--target' : '',
                d.kind === 'candidate' ? 'detections__chip--candidate' : '',
              ]
                .filter(Boolean)
                .join(' ')}
              style={{ left: r.x, top: above ? r.y : r.y + (emphasised ? 5 : 3), maxWidth: Math.max(element.width - r.x, 48) }}
            >
              {d.chip}
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
