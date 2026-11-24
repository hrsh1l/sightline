/**
 * Directional Find for the supported YOLO targets (src/shared/findTargets.ts). Pure: no timers, no I/O; time is
 * passed in (server epoch ms) and output is ServerFind messages.
 *
 * TrackSet: a small ByteTrack-style multi-object tracker for ONE COCO class.
 *   - detections below 0.30 are ignored; "high" = score >= 0.45, "low" = 0.30..0.45
 *   - association, best-first and greedy: high-score detections first against all live tracks, then low-score
 *     detections only against tracks still unmatched; within a stage IoU >= 0.3 pairs (largest IoU first), then
 *     centre distance <= 0.12 pairs (smallest first)
 *   - unmatched HIGH-score detections start new tracks; low-score ones never do
 *   - a track unmatched for > 1.0 s (frame capture time) expires; ids are per-find counters, not identities
 *   - a track is "confirmed" once matched in 2 consecutive processed frames
 *
 * FindMachine (one per find request):
 *   searching --exactly one confirmed track (and nothing else visible)--> tracking (auto-selected)
 *   searching --two or more confirmed tracks visible--> needs_selection (prompt 'select')
 *   needs_selection --select(id) / selectByPosition(choice)--> tracking (prompt 'tracking')
 *   tracking --fresh in-enter-zone observations spanning >= findCenteredDwellMs--> centered (prompt 'centred')
 *   centered --box centre leaves the exit zone--> tracking
 *   tracking|centered --no fresh observation of the SELECTED track for > findObservationMaxAgeMs--> lost ('lost')
 *   lost --exactly one confirmed track visible AND (never more than one seen at once OR within 0.2 of the last
 *          known position)--> tracking (same or new track id, no prompt)
 *   lost --otherwise, with confirmed tracks visible--> needs_selection (prompt 'reselect')
 *   any --stop()--> stopped | timeout | error (terminal)
 *
 * BINDING: once selected, only that track id is followed; another same-class track never takes over because it
 * is bigger or more confident. Positions are IMAGE-RELATIVE (aiming the camera), never distance or directions.
 */
import { LIMITS, type Detection, type FindCandidate, type FindPromptKind, type FindState, type NormalizedBox, type ServerFind } from '../../shared/protocol.js';
import {
  boxCenter,
  centerDistance,
  centerError,
  describePosition,
  FIND_PROMPT_TEXT,
  horizontalThird,
  inCenterZone,
  iou,
  placePhrase,
  positionsLeftToRight,
  type CandidatePosition,
} from '../../shared/find.js';
import type { FindTarget } from '../../shared/findTargets.js';

export const TRACKER_TUNING = {
  minScore: 0.3,
  highScore: 0.45,
  iouMatch: 0.3,
  centerMatch: 0.12,
  trackTtlMs: 1_000,
  confirmFrames: 2,
} as const;

export const FIND_TUNING = {
  /** Reacquire after loss only within this normalised distance of the last target position (unless only one was ever seen). */
  reacquireRadius: 0.2,
  /** 'not_seen' prompt: first after this long searching with nothing, then at most this often. */
  notSeenFirstMs: 2_500,
  notSeenRepeatMs: 10_000,
  /** Tilt prompts only after the target has been tracked this long. */
  tiltMinTrackedMs: 1_000,
  /** After leaving the centre, a new 'centred' prompt is suppressed this long (boundary chatter). */
  recentreSuppressMs: 5_000,
  /** read_label binds to the target only if it was observed within this long (or is centred). */
  readFreshMs: 1_000,
} as const;

export const TERMINAL_FIND_STATES: ReadonlySet<FindState> = new Set<FindState>(['not_found', 'stopped', 'timeout', 'unsupported', 'error']);

export interface FrameInput {
  frameId: number;
  /** Client-clock capture time (echoed to the client as observedAt). */
  capturedAt: number;
  /** Capture time on the server clock (capturedAt + skew). All ages and dwell spans use this. */
  serverCapturedAt: number;
}

export interface Track {
  readonly id: number;
  detection: Detection;
  /** Server-clock capture time of the first / latest match. */
  firstSeenAt: number;
  lastSeenAt: number;
  lastCapturedAt: number;
  lastFrameId: number;
  /** Consecutive processed frames in which this track was matched (0 when missed in the latest frame). */
  streak: number;
  confirmed: boolean;
}

export class TrackSet {
  private nextId = 1;
  private list: Track[] = [];

  constructor(private readonly tuning: typeof TRACKER_TUNING = TRACKER_TUNING) {}

  get tracks(): readonly Track[] {
    return this.list;
  }

  get(id: number): Track | undefined {
    return this.list.find((t) => t.id === id);
  }

  /** Tracks matched in this frame. */
  visible(frameId: number): Track[] {
    return this.list.filter((t) => t.lastFrameId === frameId);
  }

  /** Associate one frame's detections (already filtered to the target class). Returns track id -> detection. */
  update(detections: readonly Detection[], f: FrameInput): Map<number, Detection> {
    const t = f.serverCapturedAt;
    const tu = this.tuning;
    this.list = this.list.filter((tr) => t - tr.lastSeenAt <= tu.trackTtlMs);
    const byScore = (a: Detection, b: Detection) => b.score - a.score;
    const usable = detections.filter((d) => d.score >= tu.minScore);
    const high = usable.filter((d) => d.score >= tu.highScore).sort(byScore);
    const low = usable.filter((d) => d.score < tu.highScore).sort(byScore);
    const free = new Set(this.list);
    const matched = new Map<Track, Detection>();
    const unmatchedHigh = this.associate(high, free, matched);
    this.associate(low, free, matched);
    for (const [tr, d] of matched) {
      tr.detection = d;
      tr.lastSeenAt = t;
      tr.lastCapturedAt = f.capturedAt;
      tr.lastFrameId = f.frameId;
      tr.streak++;
      if (tr.streak >= tu.confirmFrames) tr.confirmed = true;
    }
    for (const tr of free) tr.streak = 0;
    for (const d of unmatchedHigh) {
      const tr: Track = {
        id: this.nextId++,
        detection: d,
        firstSeenAt: t,
        lastSeenAt: t,
        lastCapturedAt: f.capturedAt,
        lastFrameId: f.frameId,
        streak: 1,
        confirmed: tu.confirmFrames <= 1,
      };
      this.list.push(tr);
      matched.set(tr, d);
    }
    const out = new Map<number, Detection>();
    for (const [tr, d] of matched) out.set(tr.id, d);
    return out;
  }

  /** Greedy best-first: IoU pairs (largest first), then centre-distance pairs (smallest first). Returns unmatched detections. */
  private associate(dets: readonly Detection[], free: Set<Track>, matched: Map<Track, Detection>): Detection[] {
    const left = new Set(dets);
    const take = (pairs: { d: Detection; tr: Track; v: number }[]) => {
      pairs.sort((a, b) => b.v - a.v || b.d.score - a.d.score);
      for (const p of pairs) {
        if (!left.has(p.d) || !free.has(p.tr)) continue;
        matched.set(p.tr, p.d);
        left.delete(p.d);
        free.delete(p.tr);
      }
    };
    const byIou: { d: Detection; tr: Track; v: number }[] = [];
    for (const d of left) {
      for (const tr of free) {
        const v = iou(tr.detection.box, d.box);
        if (v >= this.tuning.iouMatch) byIou.push({ d, tr, v });
      }
    }
    take(byIou);
    const byDist: { d: Detection; tr: Track; v: number }[] = [];
    for (const d of left) {
      for (const tr of free) {
        const dist = centerDistance(tr.detection.box, d.box);
        if (dist <= this.tuning.centerMatch) byDist.push({ d, tr, v: -dist });
      }
    }
    take(byDist);
    return [...left];
  }
}

export interface FindMachineOptions {
  target: FindTarget;
  query: string;
  requestId: string | null;
  startedAt: number;
}

export type SelectFailureCode = 'not_selecting' | 'unknown_candidate' | 'no_candidate' | 'ambiguous' | 'not_visible';

export type SelectResult =
  | { ok: true; message: ServerFind; position: CandidatePosition; trackId: number }
  /** `message` is short, model-facing text. */
  | { ok: false; code: SelectFailureCode; message: string };

export type ReadSubject = { kind: 'none' } | { kind: 'bound'; focus: string } | { kind: 'unconfirmed'; noun: string };

interface Observation {
  frameId: number;
  capturedAt: number;
  serverAt: number;
  detection: Detection;
}

type Prompt = { kind: FindPromptKind; text: string };

/** A terminal ServerFind without a machine (unsupported query, no detector). */
export function terminalFindMessage(o: {
  requestId: string | null;
  query: string;
  state: Extract<FindState, 'unsupported' | 'error'>;
  prompt: Prompt | null;
  now: number;
}): ServerFind {
  return {
    type: 'find',
    requestId: o.requestId,
    query: o.query.slice(0, LIMITS.maxFindQueryChars),
    state: o.state,
    source: 'yolo',
    target: null,
    frameId: null,
    description: null,
    at: o.now,
    trackId: null,
    observedAt: null,
    prompt: o.prompt,
  };
}

export class FindMachine {
  readonly target: FindTarget;
  readonly query: string;
  readonly requestId: string | null;
  private _state: FindState = 'searching';
  private readonly tracks = new TrackSet();
  private selectedId: number | null = null;
  private obs: Observation | null = null;
  private lastFrameId = -1;
  private candidates: FindCandidate[] = [];
  private candidateSig = '';
  private selectionKind: 'select' | 'reselect' = 'select';
  /** Most confirmed tracks visible in one frame during this find. */
  private maxSimultaneous = 0;
  /** Server capture time of the first of the current run of consecutive fresh in-zone observations. */
  private dwellStart: number | null = null;
  private trackedSince: number | null = null;
  private leftCentredAt = Number.NEGATIVE_INFINITY;
  private autoFoundPrompted = false;
  private searchingSince: number;
  private lastNotSeenAt: number | null = null;
  private readonly lastPromptAt = new Map<FindPromptKind, number>();

  constructor(o: FindMachineOptions) {
    this.target = o.target;
    this.query = o.query.slice(0, LIMITS.maxFindQueryChars);
    this.requestId = o.requestId;
    this.searchingSince = o.startedAt;
  }

  get state(): FindState {
    return this._state;
  }

  get terminal(): boolean {
    return TERMINAL_FIND_STATES.has(this._state);
  }

  get selectedTrackId(): number | null {
    return this.selectedId;
  }

  get currentCandidates(): readonly FindCandidate[] {
    return this.candidates;
  }

  /** The initial 'searching' message. */
  start(now: number): ServerFind {
    return this.message(now, null);
  }

  /**
   * One detector result. Out-of-order frames (frameId <= last) are ignored; stale frames (captured more than
   * findObservationMaxAgeMs ago) are never used and break any dwell in progress. `target` is the selected track's
   * detection in this frame (for the overlay flag), only when it is a fresh tracking/centred observation.
   */
  observe(input: FrameInput & { detections: readonly Detection[] }, now: number): { message: ServerFind | null; target: Detection | null } {
    if (this.terminal || input.frameId <= this.lastFrameId) return { message: null, target: null };
    this.lastFrameId = input.frameId;
    if (now - input.serverCapturedAt > LIMITS.findObservationMaxAgeMs) {
      this.dwellStart = null;
      return { message: this.checkLost(now), target: null };
    }
    const dets = input.detections.filter((d) => d.label.toLowerCase() === this.target.coco);
    const matched = this.tracks.update(dets, input);
    const visible = this.tracks.visible(input.frameId);
    const confirmed = visible.filter((t) => t.streak >= TRACKER_TUNING.confirmFrames);
    this.maxSimultaneous = Math.max(this.maxSimultaneous, confirmed.length);

    let message: ServerFind | null = null;
    switch (this._state) {
      case 'searching':
        if (confirmed.length >= 2) message = this.enterSelection('select', input.serverCapturedAt, now);
        else if (confirmed.length === 1 && visible.length === 1) message = this.acquire(confirmed[0]!, input, now, 'auto');
        break;
      case 'needs_selection':
        message = this.refreshSelection(input.serverCapturedAt, now);
        break;
      case 'tracking':
      case 'centered': {
        const d = this.selectedId !== null ? matched.get(this.selectedId) : undefined;
        if (d) message = this.applyObservation(d, input, now, null);
        else {
          this.dwellStart = null; // a processed frame without the target breaks the dwell
          message = this.checkLost(now);
        }
        break;
      }
      case 'lost':
        message = this.tryReacquire(visible, confirmed, input, now);
        break;
    }
    const fresh =
      (this._state === 'tracking' || this._state === 'centered') && this.obs?.frameId === input.frameId && this.selectedId !== null
        ? (matched.get(this.selectedId) ?? null)
        : null;
    return { message, target: fresh };
  }

  /** Time-based transitions: lost (no fresh observation), not_seen prompt. Call every ~100 ms. */
  tick(now: number): ServerFind | null {
    if (this.terminal) return null;
    if (this._state === 'tracking' || this._state === 'centered') return this.checkLost(now);
    if (this._state === 'searching') {
      const anyRecent = this.tracks.tracks.some((t) => now - t.lastSeenAt <= TRACKER_TUNING.trackTtlMs);
      if (anyRecent || now - this.searchingSince < FIND_TUNING.notSeenFirstMs) return null;
      if (this.lastNotSeenAt !== null && now - this.lastNotSeenAt < FIND_TUNING.notSeenRepeatMs) return null;
      this.lastNotSeenAt = now;
      const p = this.prompt('not_seen', FIND_PROMPT_TEXT.notSeen(this.target), now);
      return p ? this.message(now, p) : null;
    }
    return null;
  }

  /** Accessible control: choose a candidate by id (only in needs_selection, only while it is in view). */
  select(candidateId: number, now: number): SelectResult {
    if (this._state !== 'needs_selection') return { ok: false, code: 'not_selecting', message: 'There is nothing to choose between right now.' };
    const c = this.candidates.find((x) => x.id === candidateId);
    if (!c) return { ok: false, code: 'unknown_candidate', message: 'That choice is no longer available.' };
    const tr = this.tracks.get(candidateId);
    if (!tr || now - tr.lastSeenAt > LIMITS.findObservationMaxAgeMs) {
      return { ok: false, code: 'not_visible', message: `That ${this.target.noun} is not in the picture right now.` };
    }
    this.selectedId = tr.id;
    this._state = 'tracking';
    this.dwellStart = null;
    this.trackedSince = null;
    const p = this.prompt('tracking', FIND_PROMPT_TEXT.foundChosen(this.target, c.position), now, true);
    const message = this.applyObservation(tr.detection, { frameId: tr.lastFrameId, capturedAt: tr.lastCapturedAt, serverCapturedAt: tr.lastSeenAt }, now, p);
    return { ok: true, message, position: c.position, trackId: tr.id };
  }

  /** Voice selection ("the left one"): maps the choice to the current candidate in that position. */
  selectByPosition(choice: CandidatePosition, now: number): SelectResult {
    if (this._state !== 'needs_selection') return { ok: false, code: 'not_selecting', message: 'There is nothing to choose between right now.' };
    const m = this.candidates.filter((c) => c.position === choice);
    if (m.length === 0) return { ok: false, code: 'no_candidate', message: `There is no ${this.target.noun} ${placePhrase(choice)} right now.` };
    if (m.length > 1) {
      return {
        ok: false,
        code: 'ambiguous',
        message: `More than one ${this.target.noun} is ${placePhrase(choice)}. Ask the user to use the on-screen choices, or to move the camera so fewer are in view.`,
      };
    }
    return this.select(m[0]!.id, now);
  }

  stop(state: Extract<FindState, 'stopped' | 'timeout' | 'error'>, now: number, prompt: Prompt | null): ServerFind | null {
    if (this.terminal) return null;
    this._state = state;
    this.dwellStart = null;
    return this.message(now, prompt);
  }

  /** Subject binding for "read its label". */
  readSubject(now: number): ReadSubject {
    if (this.terminal || this._state === 'searching') return { kind: 'none' };
    const o = this.obs;
    if (this.selectedId !== null && o) {
      if (this._state === 'centered') return { kind: 'bound', focus: `the ${this.target.noun} ${placePhrase('centre')}` };
      if (this._state === 'tracking' && now - o.serverAt <= FIND_TUNING.readFreshMs) {
        return { kind: 'bound', focus: `the ${this.target.noun} ${placePhrase(horizontalThird(o.detection.box))}` };
      }
    }
    return { kind: 'unconfirmed', noun: this.target.noun };
  }

  // -------------------------------------------------------------------------

  private acquire(track: Track, input: FrameInput, now: number, how: 'auto' | 'reacquire'): ServerFind {
    this.selectedId = track.id;
    this._state = 'tracking';
    this.dwellStart = null;
    this.trackedSince = null;
    let p: Prompt | null = null;
    if (how === 'auto' && !this.autoFoundPrompted) {
      this.autoFoundPrompted = true;
      p = this.prompt('tracking', FIND_PROMPT_TEXT.foundAuto(this.target), now);
    }
    return this.applyObservation(track.detection, input, now, p);
  }

  private applyObservation(d: Detection, input: FrameInput, now: number, pending: Prompt | null): ServerFind {
    this.obs = { frameId: input.frameId, capturedAt: input.capturedAt, serverAt: input.serverCapturedAt, detection: d };
    this.trackedSince ??= input.serverCapturedAt;
    let p = pending;
    if (this._state === 'centered') {
      if (!inCenterZone(d.box, LIMITS.findCenterExit)) {
        this._state = 'tracking';
        this.leftCentredAt = now;
        this.dwellStart = null;
      }
    } else if (inCenterZone(d.box, LIMITS.findCenterEnter)) {
      this.dwellStart ??= input.serverCapturedAt;
      if (input.serverCapturedAt - this.dwellStart >= LIMITS.findCenteredDwellMs) {
        this._state = 'centered';
        this.dwellStart = null;
        if (now - this.leftCentredAt >= FIND_TUNING.recentreSuppressMs) p = this.prompt('centred', FIND_PROMPT_TEXT.centred(this.target), now) ?? p;
      }
    } else {
      this.dwellStart = null;
    }
    if (this._state === 'tracking' && !p) p = this.tiltPrompt(now);
    return this.message(now, p);
  }

  private tiltPrompt(now: number): Prompt | null {
    const o = this.obs;
    if (!o || this.trackedSince === null || o.serverAt - this.trackedSince < FIND_TUNING.tiltMinTrackedMs) return null;
    const { dx, dy } = centerError(o.detection.box);
    if (Math.abs(dx) > LIMITS.findCenterExit.x || Math.abs(dy) <= LIMITS.findCenterEnter.y) return null;
    return dy < 0 ? this.prompt('tilt_up', FIND_PROMPT_TEXT.tiltUp(), now) : this.prompt('tilt_down', FIND_PROMPT_TEXT.tiltDown(), now);
  }

  private checkLost(now: number): ServerFind | null {
    if (this._state !== 'tracking' && this._state !== 'centered') return null;
    if (this.obs && now - this.obs.serverAt <= LIMITS.findObservationMaxAgeMs) return null;
    if (this._state === 'centered') this.leftCentredAt = now;
    this._state = 'lost';
    this.dwellStart = null;
    this.trackedSince = null;
    return this.message(now, this.prompt('lost', FIND_PROMPT_TEXT.lost(this.target), now));
  }

  private tryReacquire(visible: readonly Track[], confirmed: readonly Track[], input: FrameInput, now: number): ServerFind | null {
    if (confirmed.length >= 2) return this.enterSelection('reselect', input.serverCapturedAt, now);
    if (confirmed.length !== 1 || visible.length !== 1) return null;
    const c = confirmed[0]!;
    const near = this.obs !== null && centerDistance(c.detection.box, this.obs.detection.box) <= FIND_TUNING.reacquireRadius;
    if (this.maxSimultaneous <= 1 || near) return this.acquire(c, input, now, 'reacquire');
    return this.enterSelection('reselect', input.serverCapturedAt, now);
  }

  private enterSelection(kind: 'select' | 'reselect', t: number, now: number): ServerFind {
    this._state = 'needs_selection';
    this.selectionKind = kind;
    this.dwellStart = null;
    this.trackedSince = null;
    this.rebuildCandidates(t);
    return this.message(now, this.selectionPrompt(now));
  }

  private selectionPrompt(now: number): Prompt | null {
    const n = this.candidates.length;
    if (this.selectionKind === 'select') return n >= 2 ? this.prompt('select', FIND_PROMPT_TEXT.select(this.target, n), now) : null;
    return n >= 1 ? this.prompt('reselect', FIND_PROMPT_TEXT.reselect(this.target, this.candidates.map((c) => c.position)), now) : null;
  }

  private refreshSelection(t: number, now: number): ServerFind | null {
    const before = this.candidates.length;
    if (!this.rebuildCandidates(t)) return null;
    if (this.candidates.length === 0) {
      // Everything left the picture: go back to looking (or to lost, if a target was selected before).
      if (this.selectionKind === 'select') {
        this._state = 'searching';
        this.searchingSince = now;
      } else this._state = 'lost';
      return this.message(now, null);
    }
    const countChanged = this.candidates.length !== before && this.candidates.length >= 2;
    return this.message(now, countChanged ? this.selectionPrompt(now) : null);
  }

  /** Candidates = confirmed tracks seen within findObservationMaxAgeMs, best 4 by score, sorted left -> right. Returns true if changed. */
  private rebuildCandidates(t: number): boolean {
    const recent = this.tracks.tracks
      .filter((tr) => tr.confirmed && t - tr.lastSeenAt <= LIMITS.findObservationMaxAgeMs)
      .sort((a, b) => b.detection.score - a.detection.score)
      .slice(0, LIMITS.maxFindCandidates)
      .sort((a, b) => boxCenter(a.detection.box).cx - boxCenter(b.detection.box).cx);
    const positions = positionsLeftToRight(recent.map((tr) => tr.detection.box));
    this.candidates = recent.map((tr, i) => ({
      id: tr.id,
      label: tr.detection.label.slice(0, 80),
      score: tr.detection.score,
      box: tr.detection.box,
      position: positions[i]!,
    }));
    const sig = this.candidates.map((c) => `${c.id}:${c.position}`).join(',');
    const changed = sig !== this.candidateSig;
    this.candidateSig = sig;
    return changed;
  }

  /** Throttled per kind (findPromptMinIntervalMs) unless forced (a direct answer to a user choice). */
  private prompt(kind: FindPromptKind, text: string, now: number, force = false): Prompt | null {
    const last = this.lastPromptAt.get(kind);
    if (!force && last !== undefined && now - last < LIMITS.findPromptMinIntervalMs) return null;
    this.lastPromptAt.set(kind, now);
    return { kind, text };
  }

  private message(now: number, prompt: Prompt | null): ServerFind {
    const o = this.obs;
    const showTarget = (this._state === 'tracking' || this._state === 'centered') && o !== null && now - o.serverAt <= LIMITS.findObservationMaxAgeMs;
    const box: NormalizedBox | null = showTarget ? o.detection.box : null;
    const m: ServerFind = {
      type: 'find',
      requestId: this.requestId,
      query: this.query,
      state: this._state,
      source: 'yolo',
      target: showTarget && box ? { label: o.detection.label.slice(0, 80), score: o.detection.score, box } : null,
      frameId: showTarget ? o.frameId : null,
      description: showTarget && box ? describePosition(box, this._state === 'centered') : null,
      at: now,
      // Selected target id while it is being followed or was just lost; null while choosing or searching.
      trackId: this._state === 'tracking' || this._state === 'centered' || this._state === 'lost' ? this.selectedId : null,
      observedAt: showTarget ? o.capturedAt : null,
      prompt,
    };
    if (this._state === 'needs_selection') m.candidates = this.candidates.map((c) => ({ ...c }));
    return m;
  }
}
