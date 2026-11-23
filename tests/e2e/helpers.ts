/** Helpers for Playwright e2e tests against the FIXTURE server. */
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { expect, type Page } from '@playwright/test';
import { E2E_CONTROL_PORT } from './ports.js';

const CONTROL = `http://127.0.0.1:${E2E_CONTROL_PORT}`;

export interface FixtureSessionStats {
  index: number;
  openedAt: number;
  closed: boolean;
  closedAt: number | null;
  sendsAfterClose: number;
  frames: number;
  frameTimes: number[];
  audio: number;
  audioTimes: number[];
  audioMimes: (string | null)[];
  audioStreamEnds: number;
  texts: string[];
  clientContent: string[];
  toolResponses: string[];
}

export interface FixtureStats {
  fixture: true;
  sessions: FixtureSessionStats[];
  vision: {
    extractCalls: { frameId: number; width: number; height: number; capturedAt: number }[];
    answerCalls: { frameId: number; question: string }[];
  };
  log: { level: string; event: string; fields: Record<string, unknown> }[];
}

export async function stats(): Promise<FixtureStats> {
  const r = await fetch(`${CONTROL}/stats`);
  return (await r.json()) as FixtureStats;
}

export async function newestSession(afterIndex = -1): Promise<FixtureSessionStats> {
  let s: FixtureSessionStats | undefined;
  await expect
    .poll(async () => {
      const all = (await stats()).sessions;
      s = all.filter((x) => x.index > afterIndex).at(-1);
      return s !== undefined;
    })
    .toBe(true);
  return s!;
}

export async function sessionByIndex(index: number): Promise<FixtureSessionStats> {
  const s = (await stats()).sessions.find((x) => x.index === index);
  if (!s) throw new Error(`no FIXTURE session ${index}`);
  return s;
}

export async function triggerReply(ms: number, text = 'FIXTURE long reply') {
  const r = await fetch(`${CONTROL}/reply?ms=${ms}&text=${encodeURIComponent(text)}`, { method: 'POST' });
  expect(r.status).toBe(200);
}

export async function triggerToolReadLabel(): Promise<string> {
  const r = await fetch(`${CONTROL}/tool`, { method: 'POST' });
  expect(r.status).toBe(200);
  return ((await r.json()) as { id: string }).id;
}

/** Highest provider session index so far (-1 if none). */
export async function lastIndex(): Promise<number> {
  return (await stats()).sessions.reduce((m, s) => Math.max(m, s.index), -1);
}

/** Record every MediaStream the page obtains so tests can check that all tracks were stopped. */
export async function recordMediaStreams(page: Page) {
  await page.addInitScript(() => {
    const md = navigator.mediaDevices;
    if (!md?.getUserMedia) return;
    const orig = md.getUserMedia.bind(md);
    const w = window as unknown as { __streams: MediaStream[] };
    w.__streams = [];
    md.getUserMedia = async (c?: MediaStreamConstraints) => {
      const s = await orig(c);
      w.__streams.push(s);
      return s;
    };
  });
}

export async function trackStates(page: Page): Promise<{ kind: string; readyState: string }[]> {
  return page.evaluate(() =>
    ((window as unknown as { __streams?: MediaStream[] }).__streams ?? []).flatMap((s) =>
      s.getTracks().map((t) => ({ kind: t.kind, readyState: t.readyState })),
    ),
  );
}

/** Make getUserMedia reject camera requests with NotAllowedError (simulates "Block" on the camera prompt). */
export async function denyCamera(page: Page) {
  await page.addInitScript(() => {
    const md = navigator.mediaDevices;
    const orig = md.getUserMedia.bind(md);
    md.getUserMedia = async (c?: MediaStreamConstraints) => {
      if (c?.video) throw new DOMException('Permission denied', 'NotAllowedError');
      return orig(c);
    };
  });
}

export async function screenshot(page: Page, name: string) {
  const dir = path.resolve('test-results/screenshots');
  mkdirSync(dir, { recursive: true });
  await page.screenshot({ path: path.join(dir, `${name}.png`), fullPage: true });
}

/** Elements that stick out past the right edge of the viewport (ignores visually hidden / zero-size nodes). */
export async function horizontalOverflow(page: Page): Promise<{ scroll: boolean; offenders: string[] }> {
  return page.evaluate(() => {
    const vw = document.documentElement.clientWidth;
    const offenders: string[] = [];
    for (const el of Array.from(document.querySelectorAll('body *'))) {
      const r = el.getBoundingClientRect();
      if (r.width <= 1 || r.height <= 1) continue;
      const cs = getComputedStyle(el);
      if (cs.visibility === 'hidden' || cs.display === 'none' || cs.position === 'fixed') continue;
      if (r.right > vw + 1 || r.left < -1) {
        const id = `${el.tagName.toLowerCase()}${el.className && typeof el.className === 'string' ? '.' + el.className.split(' ').join('.') : ''}`;
        offenders.push(`${id} [${Math.round(r.left)}..${Math.round(r.right)} > ${vw}]`);
      }
    }
    const scroll = document.documentElement.scrollWidth > vw + 1 || document.body.scrollWidth > vw + 1;
    return { scroll, offenders: offenders.slice(0, 10) };
  });
}

export async function startAssistant(page: Page) {
  await page.getByRole('button', { name: 'Start assistant' }).click();
  await expect(page.getByTestId('status-connection')).toContainText('Live');
  await expect(page.getByRole('button', { name: 'Read label' })).toBeEnabled();
  await page.waitForTimeout(300); // let button colour transitions settle before screenshots
}
