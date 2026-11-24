// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { DetectionOverlay, overlayItems, overlaySource } from './DetectionOverlay.js';
import { makeCandidates, makeDetections, makeFind } from './__fixtures__/fakeController.js';

afterEach(cleanup);

const source = { width: 1280, height: 720 };
// 400x400 element: contain -> content 400x225, letterboxed 87.5px top and bottom.
const element = { width: 400, height: 400 };

describe('DetectionOverlay', () => {
  it('renders one green box per detection, mapped with object-fit contain, plus a chip with label and score', () => {
    const items = overlayItems(makeDetections(), null);
    render(<DetectionOverlay items={items} source="yolo" sourceSize={source} element={element} />);
    const overlay = screen.getByTestId('detection-overlay');
    expect(overlay.getAttribute('aria-hidden')).toBe('true');
    const boxes = screen.getAllByTestId('detection-box');
    expect(boxes).toHaveLength(2);
    expect(screen.queryByTestId('detection-box-target')).toBeNull();
    // cup: x 0.6, y 0.2, w 0.2, h 0.3 -> left 240, top 87.5 + 45 = 132.5, 80 x 67.5
    const cup = boxes[0]!;
    expect(cup.style.left).toBe('240px');
    expect(cup.style.top).toBe('132.5px');
    expect(cup.style.width).toBe('80px');
    expect(cup.style.height).toBe('67.5px');
    const chips = Array.from(overlay.querySelectorAll('.detections__chip')).map((c) => c.textContent);
    expect(chips).toEqual(['cup 61%', 'bottle 82%']);
    expect(screen.getByTestId('detection-legend').textContent).toBe('YOLO · generic objects');
  });

  it('emphasises the find target, draws it last, and marks the Gemini source', () => {
    const base = makeDetections();
    const dets = makeDetections({
      source: 'gemini',
      detections: [{ label: 'salt', score: 0.9, box: { x: 0.4, y: 0.4, w: 0.2, h: 0.2 }, target: true }, ...base.detections],
    });
    const items = overlayItems(dets, makeFind());
    expect(items.map((d) => d.chip)).toEqual(['cup 61%', 'bottle 82%', 'salt 90%']);
    expect(items.map((d) => d.kind)).toEqual(['detection', 'detection', 'target']);
    render(<DetectionOverlay items={items} source={overlaySource(dets, null)} sourceSize={source} element={element} />);
    const target = screen.getByTestId('detection-box-target');
    expect(target.className).toContain('detections__box--target');
    expect(screen.getAllByTestId('detection-box')).toHaveLength(2);
    expect(document.querySelector('.detections__chip--target')?.textContent).toBe('salt 90%');
    expect(screen.getByTestId('detection-legend').textContent).toBe('Gemini · searched item');
  });

  it('adds the find target from find mode when detections carry none (detector off)', () => {
    const items = overlayItems(null, makeFind({ state: 'centered', source: 'gemini' }));
    expect(items).toEqual([{ kind: 'target', chip: 'bottle 90%', box: { x: 0.05, y: 0.05, w: 0.2, h: 0.2 } }]);
    expect(overlaySource(null, makeFind({ source: 'gemini' }))).toBe('gemini');
    render(<DetectionOverlay items={items} source="gemini" sourceSize={source} element={{ width: 640, height: 360 }} />);
    // Near the top edge: chip goes inside the box rather than above it.
    expect(document.querySelector('.detections__chip--inside')).not.toBeNull();
  });

  it('does not add a stale find target while searching, lost or stopped', () => {
    for (const state of ['searching', 'lost', 'stopped', 'timeout', 'unsupported', 'error', 'needs_selection'] as const) {
      expect(overlayItems(null, makeFind({ state }))).toEqual([]);
    }
  });

  it('needs_selection: candidate boxes are labelled Left / Middle / Right and replace the matching plain boxes', () => {
    const candidates = makeCandidates();
    const dets = makeDetections({
      detections: [
        ...candidates.map((c) => ({ label: 'cup', score: c.score, box: c.box })),
        { label: 'bottle', score: 0.82, box: { x: 0.1, y: 0.7, w: 0.1, h: 0.2 } },
      ],
    });
    const find = makeFind({ state: 'needs_selection', query: 'cup', target: null, candidates });
    const items = overlayItems(dets, find);
    expect(items.map((d) => [d.kind, d.chip])).toEqual([
      ['detection', 'bottle 82%'],
      ['candidate', 'Left'],
      ['candidate', 'Middle'],
      ['candidate', 'Right'],
    ]);
    render(<DetectionOverlay items={items} source="yolo" sourceSize={source} element={element} />);
    const boxes = screen.getAllByTestId('detection-box-candidate');
    expect(boxes).toHaveLength(3);
    expect(boxes[0]!.className).toContain('detections__box--candidate');
    const chips = Array.from(document.querySelectorAll('.detections__chip--candidate')).map((c) => c.textContent);
    expect(chips).toEqual(['Left', 'Middle', 'Right']);
    expect(screen.getByTestId('detection-overlay').getAttribute('aria-hidden')).toBe('true');
  });

  it('candidates are only drawn while the user must choose', () => {
    const candidates = makeCandidates(['left', 'right']);
    expect(overlayItems(null, makeFind({ state: 'needs_selection', candidates })).map((d) => d.chip)).toEqual(['Left', 'Right']);
    expect(overlayItems(null, makeFind({ state: 'tracking', candidates })).map((d) => d.kind)).toEqual(['target']);
    expect(overlayItems(null, makeFind({ state: 'stopped', candidates }))).toEqual([]);
  });

  it('renders nothing without a measured element or items', () => {
    const items = overlayItems(makeDetections(), null);
    const { rerender } = render(<DetectionOverlay items={items} source="yolo" sourceSize={source} element={{ width: 0, height: 0 }} />);
    expect(screen.queryByTestId('detection-overlay')).toBeNull();
    rerender(<DetectionOverlay items={[]} source="yolo" sourceSize={source} element={element} />);
    expect(screen.queryByTestId('detection-overlay')).toBeNull();
  });
});
