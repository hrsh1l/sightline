/**
 * Server-side turn tracking for Gemini Live output.
 *
 * Turn ids are assigned by the server, per client session, monotonically increasing from 1.
 * A turn is created lazily by its first content (user transcription or model output) and "starts"
 * (turn{start} to the client) at its first model output. After `interrupted` (barge-in) or a client
 * playback.stop, the turn is cancelled: any further model audio / output transcription until the
 * provider's turnComplete belongs to that cancelled turn and is discarded. User speech transcribed while
 * a cancelled turn is draining belongs to the next turn.
 */

export interface TurnState {
  id: number;
  /** turn{start} has been sent. */
  started: boolean;
  /** Interrupted or stopped: drop further model output of this turn. */
  cancelled: boolean;
  /** Next audio seq for this turn. */
  audioSeq: number;
  /** Accumulated transcripts, kept in session memory only (history for snapshot answers). Never logged. */
  userText: string;
  assistantText: string;
}

const MAX_TURN_TEXT = 4_000;

export class TurnTracker {
  private nextId = 1;
  private current: TurnState | null = null;
  private next: TurnState | null = null;

  private create(): TurnState {
    return { id: this.nextId++, started: false, cancelled: false, audioSeq: 0, userText: '', assistantText: '' };
  }

  get active(): TurnState | null {
    return this.current;
  }

  /** Highest turn id handed out so far (0 if none). */
  get lastAssignedId(): number {
    return this.nextId - 1;
  }

  /** Turn that receives model output, or null when the current turn is cancelled (discard). */
  forOutput(): TurnState | null {
    if (!this.current) {
      this.current = this.next ?? this.create();
      this.next = null;
    }
    return this.current.cancelled ? null : this.current;
  }

  /** Turn that receives the user's transcribed speech. */
  forUser(): TurnState {
    if (!this.current) {
      this.current = this.next ?? this.create();
      this.next = null;
      return this.current;
    }
    if (!this.current.cancelled) return this.current;
    this.next ??= this.create();
    return this.next;
  }

  /** Mark the current turn cancelled. Returns it if it changed state. */
  cancelCurrent(): TurnState | null {
    const t = this.current;
    if (!t || t.cancelled) return null;
    t.cancelled = true;
    return t;
  }

  /** Provider turnComplete: return the finished turn and advance. */
  complete(): TurnState | null {
    const t = this.current;
    this.current = this.next;
    this.next = null;
    return t;
  }

  /** Provider connection reset: forget in-progress turns (ids keep increasing). */
  reset(): TurnState | null {
    const t = this.current;
    this.current = null;
    this.next = null;
    return t;
  }

  static appendText(existing: string, fragment: string): string {
    const s = existing + fragment;
    return s.length > MAX_TURN_TEXT ? s.slice(s.length - MAX_TURN_TEXT) : s;
  }
}
