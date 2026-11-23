import { useEffect, useRef, useState } from 'react';
import type { Announcement } from '../contracts.js';

/** How long an announcement stays in the live region before it is cleared. */
export const ANNOUNCE_CLEAR_MS = 5_000;
/** Identical text with the same politeness inside this window is treated as a duplicate. */
export const ANNOUNCE_DEDUPE_MS = 1_000;

type Region =Announcement['politeness'];
type Regions = Record<Region, string>;

/**
 * The only live regions in the app. Status changes reach screen readers through here, driven by
 * state.announcement (monotonic id). Each id is announced at most once; rapid duplicates are dropped;
 * text is cleared after a few seconds so stale messages are not re-read when navigating.
 */
export function Announcer({ announcement }: { announcement: Announcement | null }) {
  const [regions, setRegions] = useState<Regions>({ polite: '', assertive: '' });
  const lastId = useRef<number | null>(null);
  const last = useRef<{ text: string; politeness: Region; at: number } | null>(null);
  const timers = useRef<Partial<Record<Region, ReturnType<typeof setTimeout>>>>({});
  // Alternating invisible suffix forces a DOM text change so a repeated message is re-announced.
  const flip = useRef(false);

  useEffect(() => {
    if (!announcement || announcement.id === lastId.current) return;
    lastId.current = announcement.id;
    const text = announcement.text.trim();
    if (!text) return;
    const region = announcement.politeness;
    const now = Date.now();
    const prev = last.current;
    if (prev && prev.text === text && prev.politeness === region && now - prev.at < ANNOUNCE_DEDUPE_MS) return;
    last.current = { text, politeness: region, at: now };
    flip.current = !flip.current;
    const value = flip.current ? text : `${text}\u00a0`;
    setRegions((r) => ({ ...r, [region]: value }));
    clearTimeout(timers.current[region]);
    timers.current[region] = setTimeout(() => setRegions((r) => ({ ...r, [region]: '' })), ANNOUNCE_CLEAR_MS);
  }, [announcement]);

  useEffect(() => {
    const t = timers.current;
    return () => {
      clearTimeout(t.polite);
      clearTimeout(t.assertive);
    };
  }, []);

  return (
    <div className="visually-hidden">
      <div aria-live="polite" aria-atomic="true" data-testid="announcer-polite">
        {regions.polite}
      </div>
      <div aria-live="assertive" aria-atomic="true" data-testid="announcer-assertive">
        {regions.assertive}
      </div>
    </div>
  );
}
