// @vitest-environment jsdom
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Announcement } from '../contracts.js';
import { ANNOUNCE_CLEAR_MS, ANNOUNCE_DEDUPE_MS, Announcer } from './Announcer.js';

const polite = () => screen.getByTestId('announcer-polite');
const assertive = () => screen.getByTestId('announcer-assertive');
const a = (id: number, text: string, politeness: Announcement['politeness'] = 'polite'): Announcement => ({ id, text, politeness });

describe('Announcer', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it('renders two live regions with the right politeness, empty initially', () => {
    render(<Announcer announcement={null} />);
    expect(polite().getAttribute('aria-live')).toBe('polite');
    expect(assertive().getAttribute('aria-live')).toBe('assertive');
    expect(polite().textContent).toBe('');
    expect(assertive().textContent).toBe('');
  });

  it('routes polite and assertive announcements to their own region', () => {
    const { rerender } = render(<Announcer announcement={a(1, 'Connected. Live.')} />);
    expect(polite().textContent?.trim()).toBe('Connected. Live.');
    expect(assertive().textContent).toBe('');
    rerender(<Announcer announcement={a(2, 'Camera permission denied', 'assertive')} />);
    expect(assertive().textContent?.trim()).toBe('Camera permission denied');
    expect(polite().textContent?.trim()).toBe('Connected. Live.');
  });

  it('announces each id once (re-render with the same id does not re-announce)', () => {
    const ann = a(5, 'Reading label');
    const { rerender } = render(<Announcer announcement={ann} />);
    expect(polite().textContent?.trim()).toBe('Reading label');
    act(() => vi.advanceTimersByTime(ANNOUNCE_CLEAR_MS + 10));
    expect(polite().textContent).toBe('');
    rerender(<Announcer announcement={{ ...ann }} />);
    expect(polite().textContent).toBe('');
  });

  it('drops a rapid duplicate of the same text but re-announces it after the dedupe window', () => {
    const { rerender } = render(<Announcer announcement={a(1, 'Muted')} />);
    const first = polite().textContent;
    rerender(<Announcer announcement={a(2, 'Muted')} />);
    expect(polite().textContent).toBe(first);
    act(() => vi.advanceTimersByTime(ANNOUNCE_DEDUPE_MS + 50));
    rerender(<Announcer announcement={a(3, 'Muted')} />);
    // Text content must change in the DOM so screen readers re-announce identical text.
    expect(polite().textContent).not.toBe(first);
    expect(polite().textContent?.trim()).toBe('Muted');
  });

  it('clears text after a few seconds', () => {
    render(<Announcer announcement={a(1, 'Paused')} />);
    expect(polite().textContent?.trim()).toBe('Paused');
    act(() => vi.advanceTimersByTime(ANNOUNCE_CLEAR_MS - 100));
    expect(polite().textContent?.trim()).toBe('Paused');
    act(() => vi.advanceTimersByTime(200));
    expect(polite().textContent).toBe('');
  });

  it('ignores empty text', () => {
    render(<Announcer announcement={a(1, '   ')} />);
    expect(polite().textContent).toBe('');
  });
});
