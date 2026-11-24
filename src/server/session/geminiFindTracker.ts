/**
 * LEGACY single-box find state machine, used ONLY for the optional Gemini-locate path (config.findGemini, for
 * items outside the supported YOLO list). The supported-list YOLO path uses FindMachine in findTracker.ts.
 * Pure: time is passed in, output is ServerFind messages.
 *
 *   searching --target seen--> tracking <--centred / off-centre--> centered
 *   tracking|centered --unseen for lostAfterMs--> lost --seen--> tracking|centered
 *   searching --nothing for notFoundAfterMs--> not_found (terminal)
 *   lost --unseen for notFoundAfterMs--> not_found (terminal)
 *   any --stop()--> stopped | timeout (terminal)
 *
 * Messages are emitted on every state change, and while the target is visible at most once per
 * minUpdateIntervalMs (~4/s) so aiming cues stay fresh without flooding the socket.
 *
 * Positions are IMAGE-RELATIVE (aiming help for the camera), never physical distance or directions.
 */
import { LIMITS, type Detection, type FindState, type NormalizedBox, type ServerFind } from '../../shared/protocol.js';
import { describePosition, isCentered } from '../../shared/find.js';

export type FindSource = 'yolo' | 'gemini';
export type TerminalFindState = Extract<FindState, 'not_found' | 'stopped' | 'timeout'>;

export const FIND_TIMINGS = {
  /** YOLO runs ~4/s: unseen this long = lost. */
  yoloLostAfterMs: 1_500,
  /** Gemini locate runs ~every 1.2 s with ~1 s latency: allow two misses. */
  geminiLostAfterMs: Math.max(3_000, LIMITS.locateMinIntervalMs * 2 + 600),
  /** Nothing seen for this long while searching (or since lost) = not_found. */
  notFoundAfterMs: 10_000,
  /** Max update rate while tracking. */
  minUpdateIntervalMs: 250,
  /** Hysteresis: once centred, the box may drift this much further before it counts as off-centre. */
  centeredSlack: 0.04,
} as const;

export const TERMINAL_FIND_STATES: ReadonlySet<FindState> = new Set<FindState>(['not_found', 'stopped', 'timeout']);

export interface GeminiFindTrackerOptions {
  query: string;
  requestId: string | null;
  source: FindSource;
  startedAt: number;
  lostAfterMs?: number;
  notFoundAfterMs?: number;
  minUpdateIntervalMs?: number;
}

export class GeminiFindTracker {
  readonly query: string;
  readonly requestId: string | null;
  readonly source: FindSource;
  private _state: FindState = 'searching';
  private lastSeenAt: number | null = null;
  private stateSince: number;
  private lastSentAt = Number.NEGATIVE_INFINITY;
  private lastTarget: Detection | null = null;
  private lastFrameId: number | null = null;
  private readonly lostAfterMs: number;
  private readonly notFoundAfterMs: number;
  private readonly minUpdateIntervalMs: number;
  /** True once the target has been centred at least once in this find. */
  centeredOnce = false;

  constructor(o: GeminiFindTrackerOptions) {
    this.query = o.query;
    this.requestId = o.requestId;
    this.source = o.source;
    this.stateSince = o.startedAt;
    this.lostAfterMs = o.lostAfterMs ?? (o.source === 'yolo' ? FIND_TIMINGS.yoloLostAfterMs : FIND_TIMINGS.geminiLostAfterMs);
    this.notFoundAfterMs = o.notFoundAfterMs ?? FIND_TIMINGS.notFoundAfterMs;
    this.minUpdateIntervalMs = o.minUpdateIntervalMs ?? FIND_TIMINGS.minUpdateIntervalMs;
  }

  get state(): FindState {
    return this._state;
  }

  get terminal(): boolean {
    return TERMINAL_FIND_STATES.has(this._state);
  }

  /** Previous target box, for continuity in pickTarget. */
  get previousBox(): NormalizedBox | null {
    return this.lastTarget?.box ?? null;
  }

  get target(): Detection | null {
    return this._state === 'tracking' || this._state === 'centered' ? this.lastTarget : null;
  }

  /** The initial 'searching' message. */
  start(now: number): ServerFind {
    this.lastSentAt = now;
    return this.message(now);
  }

  /** A detection/locate result for frameId: the chosen target, or null when not seen in that frame. */
  observe(frameId: number, target: Detection | null, now: number): ServerFind | null {
    if (this.terminal) return null;
    if (this.lastFrameId !== null && frameId < this.lastFrameId) return null; // late result for an older frame
    this.lastFrameId = frameId;
    if (!target) return this.tick(now);
    this.lastSeenAt = now;
    this.lastTarget = target;
    const wasCentered = this._state === 'centered';
    const centered = isCentered(target.box, wasCentered ? FIND_TIMINGS.centeredSlack : 0);
    const next: FindState = centered ? 'centered' : 'tracking';
    if (next !== this._state) return this.transition(next, now);
    if (now - this.lastSentAt >= this.minUpdateIntervalMs) {
      this.lastSentAt = now;
      return this.message(now);
    }
    return null;
  }

  /** Time-based transitions (lost / not_found). Call ~every 250 ms. */
  tick(now: number): ServerFind | null {
    if (this.terminal) return null;
    if ((this._state === 'tracking' || this._state === 'centered') && this.lastSeenAt !== null && now - this.lastSeenAt >= this.lostAfterMs) {
      return this.transition('lost', now);
    }
    if ((this._state === 'searching' || this._state === 'lost') && now - this.stateSince >= this.notFoundAfterMs) {
      return this.transition('not_found', now);
    }
    return null;
  }

  stop(state: Extract<TerminalFindState, 'stopped' | 'timeout'>, now: number): ServerFind | null {
    if (this.terminal) return null;
    return this.transition(state, now);
  }

  private transition(next: FindState, now: number): ServerFind {
    this._state = next;
    this.stateSince = now;
    this.lastSentAt = now;
    if (next === 'centered') this.centeredOnce = true;
    return this.message(now);
  }

  private message(now: number): ServerFind {
    const t = this.target;
    return {
      type: 'find',
      requestId: this.requestId,
      query: this.query,
      state: this._state,
      source: this.source,
      target: t ? { label: t.label.slice(0, 80), score: t.score, box: t.box } : null,
      frameId: t ? this.lastFrameId : null,
      description: t ? describePosition(t.box) : null,
      at: now,
    };
  }
}
