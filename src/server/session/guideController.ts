/**
 * Per-session glue between the browser, Gemini Live tools and the app-owned GuideMachine (instruction companion).
 *
 *  - Inspections always use a FRESH frame that is newer than any frame used before for the guide ("How about now?"
 *    never re-reads the previous image). Latest wins: a newer inspect, stop or end aborts the in-flight extraction
 *    and stale results are ignored by generation and by the machine's inspect token.
 *  - UI guide.inspect is throttled (GUIDE_LIMITS.inspectMinIntervalMs).
 *  - Every change is sent to the client as a ServerGuide snapshot. UI actions in Live mode are also injected into
 *    the model as an ordered app event carrying the exact `say` text; tool calls return the state instead.
 *  - confirm_step is applied only when the model's user_said AND the user's latest real words both read as an
 *    affirmative completion; one utterance confirms at most one step.
 *  - The store keeps the machine across socket reconnects (resumeKey); mutations are never replayed.
 */
import { GUIDE_LIMITS, GuideExtraction } from '../../shared/guide.js';
import type { ClientMessageOf, ErrorCode, FramePayload, ServerMessage } from '../../shared/protocol.js';
import type { Clock, Logger, VisionService } from '../contracts.js';
import type { GuideMachine, GuideResult } from '../guide/GuideMachine.js';
import type { GuideStore } from '../guide/GuideStore.js';
import { isAffirmativeCompletion } from '../guide/text.js';
import {
  compactGuideState,
  CONFIRM_REPLACE_GUIDANCE,
  GUIDE_EVENT_PREFIX,
  GUIDE_EVENT_SAY_SUFFIX,
  NOT_CONFIRMED_GUIDANCE,
  SAY_GUIDANCE,
  SILENT_GUIDANCE,
  type ParsedGuideToolCall,
} from '../live/guideTools.js';

export type GuideToolResult = { output: Record<string, unknown> } | { error: { code: string; message: string } };

export const NO_VISION_GUIDE_MESSAGE = 'Reading instructions is not available because the server has no Gemini API key for vision.';
const UTTERANCE_WAIT_MS = 800;

export class GuideAbortedError extends Error {}

/**
 * ServerGuide.result codes the client understands: stale_revision, wrong_step, duplicate, throttled, invalid,
 * no_guide, invalid_phase, not_confirmed (+ frame_stale, superseded, vision_failed, vision_unavailable for inspect).
 * Finer machine codes are folded into 'invalid'.
 */
function uiCode(code: string | null): string | null {
  return code === 'unknown_section' || code === 'nothing_to_undo' || code === 'guide_active' || code === 'stale_result' ? 'invalid' : code;
}

export interface UserUtterance {
  id: string;
  text: string;
  consumed: boolean;
}

export interface GuideControllerDeps {
  store: GuideStore;
  sessionId: string;
  vision: VisionService | null;
  clock: Clock;
  log: Logger;
  send(msg: ServerMessage): void;
  sendError(code: ErrorCode, message: string, recoverable: boolean, extra?: { requestId?: string | undefined }): void;
  isFresh(frame: FramePayload): boolean;
  liveReady(): boolean;
  /** Ordered app event to the model (sendClientContent, turnComplete true). False when not sent. */
  injectLive(text: string): boolean;
  newController(): AbortController;
  releaseController(ac: AbortController): void;
  visionFailure(err: unknown): { code: string; message: string; logCode: string };
  /** Fresh still for a tool (snapshot.request purpose 'guide'), or an error tool result. */
  snapshotForGuide(signal: AbortSignal): Promise<{ result: GuideToolResult } | { frame: FramePayload; requestId: string }>;
  /** Stop an active find (returns true if one was running). */
  stopFind(): boolean;
  /** Latest user words (Live input transcription for the current turn, or typed text). */
  latestUtterance(): UserUtterance | null;
  /** Resolves on the next utterance update or after ms (never rejects). */
  waitForUtterance(ms: number): Promise<void>;
}

export interface GuideController {
  /** At hello. Unknown/expired key -> fresh guide (restored false). No key -> restored undefined. */
  attach(resumeKey: string | undefined): void;
  readyFields(): { resumeKey: string; guideRestored?: boolean };
  /** After `ready`: send the restored snapshot once. */
  afterReady(): void;
  onInspect(msg: ClientMessageOf<'guide.inspect'>): Promise<void>;
  onAction(msg: ClientMessageOf<'guide.action'>): void;
  runTool(p: Extract<ParsedGuideToolCall, { ok: true }>, callId: string, signal: AbortSignal): Promise<GuideToolResult>;
  dispose(reason: string): void;
  readonly machine: GuideMachine | null;
}

export function createGuideController(deps: GuideControllerDeps): GuideController {
  const { store, sessionId, vision, clock, log } = deps;
  let key: string | null = null;
  let machine: GuideMachine | null = null;
  let restored: boolean | undefined;
  let restoreSent = false;
  let disposed = false;

  let inspectGen = 0;
  let inspectAc: AbortController | null = null;
  let lastInspectAt = Number.NEGATIVE_INFINITY;
  /** Newest frame id used for the guide: later inspections must use a newer frame. */
  let lastFrameId = -1;

  const m = (): GuideMachine => {
    if (!machine) {
      const c = store.create(sessionId);
      key = c.key;
      machine = c.machine;
    }
    return machine;
  };

  const owns = () => key !== null && store.isOwner(key, sessionId);

  function emit(r: GuideResult, requestId: string | null, withResult: boolean) {
    if (disposed) return;
    if (key) store.touch(key);
    deps.send({ type: 'guide', guide: r.snapshot, requestId, result: withResult ? { ok: r.ok, code: uiCode(r.code) } : null });
  }

  function emitCode(requestId: string, ok: boolean, code: string) {
    if (disposed) return;
    deps.send({ type: 'guide', guide: m().snapshot(), requestId, result: { ok, code } });
  }

  function inject(r: GuideResult, event: string) {
    if (!deps.liveReady()) return;
    const payload = { event, say: r.say, ...compactGuideState(r.snapshot) };
    const suffix = r.say ? GUIDE_EVENT_SAY_SUFFIX : r.guidance ? ` ${r.guidance}` : '';
    if (!r.say && !r.guidance) return;
    if (!deps.injectLive(GUIDE_EVENT_PREFIX + JSON.stringify(payload) + suffix)) log.warn('guide_inject_skipped', { event });
  }

  function abortInspect() {
    inspectGen++;
    if (inspectAc) {
      inspectAc.abort();
      deps.releaseController(inspectAc);
      inspectAc = null;
    }
  }

  /**
   * Run vision.extractGuide for the machine's current inspect token. Returns null when superseded (a newer
   * inspect, stop or end); throws GuideAbortedError when `external` (tool cancellation) aborted it.
   */
  async function extract(token: number, frame: FramePayload, external?: AbortSignal): Promise<GuideResult | null> {
    abortInspect();
    const gen = inspectGen;
    const ac = deps.newController();
    inspectAc = ac;
    const onExternal = () => ac.abort();
    external?.addEventListener('abort', onExternal, { once: true });
    const started = Date.now();
    const current = () => gen === inspectGen && !disposed && !ac.signal.aborted;
    try {
      const raw = await vision!.extractGuide({ frame, goal: m().goal ?? 'instructions', now: clock(), signal: ac.signal });
      if (!current()) return null;
      const parsed = GuideExtraction.safeParse(raw);
      if (!parsed.success || !parsed.data.frameIds.includes(frame.frameId)) {
        log.warn('guide_extract_invalid', { schema: parsed.success });
        return m().inspectFailed(token, 'The instructions could not be read because the vision service returned an unusable result. Please try again.');
      }
      log.info('guide_extracted', {
        latencyMs: Date.now() - started,
        readability: parsed.data.readability,
        issue: parsed.data.issue,
        sections: parsed.data.sections.length,
      });
      return m().inspectResult(token, parsed.data);
    } catch (err) {
      if (!current()) return null;
      const f = deps.visionFailure(err);
      log.warn('guide_extract_failed', { code: f.logCode });
      return m().inspectFailed(token, f.message);
    } finally {
      external?.removeEventListener('abort', onExternal);
      deps.releaseController(ac);
      if (inspectAc === ac) inspectAc = null;
      if (external?.aborted && gen === inspectGen) {
        const r = m().cancelInspect(token);
        if (r.changed) emit(r, null, false);
      }
    }
  }

  // ---------------------------------------------------------------------------
  // UI
  // ---------------------------------------------------------------------------

  async function onInspect(msg: ClientMessageOf<'guide.inspect'>) {
    const g = m();
    if (!owns()) return emitCode(msg.requestId, false, 'not_owner');
    if (!vision) {
      const { token } = g.beginInspect(g.hasActiveGuide ? undefined : msg.goal);
      const r = g.inspectFailed(token, NO_VISION_GUIDE_MESSAGE);
      emit({ ...r, code: 'vision_unavailable' }, msg.requestId, true);
      inject(r, 'inspect');
      return;
    }
    const now = Date.now();
    if (now - lastInspectAt < GUIDE_LIMITS.inspectMinIntervalMs) return emitCode(msg.requestId, false, 'throttled');
    if (!deps.isFresh(msg.frame) || msg.frame.frameId <= lastFrameId) {
      deps.sendError('frame_stale', 'That photo was too old to use. Hold the item steady and try again.', true, { requestId: msg.requestId });
      return emitCode(msg.requestId, false, 'frame_stale');
    }
    lastInspectAt = now;
    lastFrameId = msg.frame.frameId;
    const { token, result } = g.beginInspect(msg.goal);
    emit(result, null, false);
    const r = await extract(token, msg.frame);
    if (disposed) return;
    if (!r) return emitCode(msg.requestId, false, 'superseded');
    emit(r, msg.requestId, true);
    inject(r, 'inspect');
  }

  function onAction(msg: ClientMessageOf<'guide.action'>) {
    const g = m();
    if (!owns()) return emitCode(msg.requestId, false, 'not_owner');
    let r = g.act(msg.action, {
      opId: `ui:${msg.requestId}`,
      guideId: msg.guideId,
      revision: msg.revision,
      stepId: msg.stepId,
      section: msg.sectionId,
    });
    if (msg.action === 'stop' && r.ok) abortInspect();
    // "Where were we?" and Explain change nothing, but the client speaks guide.message in snapshot mode.
    if (r.ok && r.code === null && (msg.action === 'status' || msg.action === 'explain')) {
      const text = msg.action === 'status' ? r.say : g.explainText();
      if (text) r = { ...g.note(text), say: r.say, guidance: r.guidance };
    }
    emit(r, msg.requestId, true);
    if (r.ok && r.code !== 'duplicate' && msg.action !== 'pause') inject(r, msg.action);
  }

  // ---------------------------------------------------------------------------
  // Tools
  // ---------------------------------------------------------------------------

  function toolOutput(r: GuideResult, extra: Record<string, unknown> = {}): GuideToolResult {
    if (r.code === 'duplicate') {
      return { output: { status: 'duplicate', code: r.code, ...compactGuideState(r.snapshot), say: null, guidance: r.guidance ?? SILENT_GUIDANCE, ...extra } };
    }
    let guidance: string;
    if (!r.ok) guidance = r.guidance ?? 'Tell the user briefly; progress is unchanged.';
    else if (r.say) guidance = r.guidance ? `${SAY_GUIDANCE} ${r.guidance}` : SAY_GUIDANCE;
    else guidance = r.guidance ?? SILENT_GUIDANCE;
    return {
      output: {
        status: r.ok ? (r.code ?? 'ok') : 'rejected',
        code: r.code,
        ...compactGuideState(r.snapshot),
        say: r.say,
        guidance,
        ...extra,
      },
    };
  }

  async function inspectForTool(token: number, signal: AbortSignal, extra: Record<string, unknown>): Promise<GuideToolResult> {
    const g = m();
    const snap = await deps.snapshotForGuide(signal);
    if (signal.aborted) throw new GuideAbortedError('aborted');
    if ('result' in snap) {
      const message = 'error' in snap.result ? snap.result.error.message : 'The camera did not return a photo.';
      const r = g.inspectFailed(token, 'I could not get a new photo from the camera.');
      if (r.code !== 'stale_result') emit(r, null, false);
      return { error: { code: 'error' in snap.result ? snap.result.error.code : 'camera_unavailable', message } };
    }
    if (snap.frame.frameId <= lastFrameId) {
      const r = g.inspectFailed(token, 'That was not a new photo. Please try again.');
      if (r.code !== 'stale_result') emit(r, null, false);
      return { error: { code: 'frame_not_new', message: 'The camera returned an old photo. Ask the user to try again.' } };
    }
    lastFrameId = snap.frame.frameId;
    lastInspectAt = Date.now();
    const r = await extract(token, snap.frame, signal);
    if (signal.aborted) throw new GuideAbortedError('aborted');
    if (!r || r.code === 'stale_result') return { output: { status: 'superseded', ...compactGuideState(g.snapshot()), guidance: SILENT_GUIDANCE } };
    emit(r, null, false);
    return toolOutput(r, { frameId: snap.frame.frameId, ...extra });
  }

  async function runTool(p: Extract<ParsedGuideToolCall, { ok: true }>, callId: string, signal: AbortSignal): Promise<GuideToolResult> {
    const g = m();
    if (!owns()) return { error: { code: 'not_owner', message: 'This guide is open on another connection. Tell the user briefly.' } };
    const opId = `tool:${callId}`;
    switch (p.name) {
      case 'start_guide':
      case 'inspect_current_view': {
        if (!vision) {
          const { token } = g.beginInspect(g.hasActiveGuide ? undefined : p.args.goal);
          emit(g.inspectFailed(token, NO_VISION_GUIDE_MESSAGE), null, false);
          return { error: { code: 'vision_unavailable', message: `${NO_VISION_GUIDE_MESSAGE} Tell the user briefly; do not guess the instructions.` } };
        }
        let token: number;
        const goal = p.args.goal;
        const differentGoal = !!goal && !!g.goal && goal.trim().toLowerCase() !== g.goal.trim().toLowerCase();
        if (p.name === 'start_guide' || (differentGoal && g.hasActiveGuide)) {
          if (g.hasOp(opId)) return toolOutput(g.act('status', {}), { status: 'duplicate' });
          const replace = p.name === 'start_guide' ? p.args.replace : false;
          const started = g.start(goal!, { opId, replace });
          if (started.token === null) return toolOutput(started.result, { status: 'confirm_replace', guidance: CONFIRM_REPLACE_GUIDANCE });
          token = started.token;
          emit(started.result, null, false);
        } else {
          const b = g.beginInspect(goal);
          token = b.token;
          emit(b.result, null, false);
        }
        const findStopped = deps.stopFind();
        return inspectForTool(token, signal, findStopped ? { findStopped: true } : {});
      }
      case 'choose_section':
        return applied(g.act('choose_section', { opId, section: p.args.section }));
      case 'navigate_step': {
        const { direction, guideId, revision, stepId } = p.args;
        if (direction === 'status') return toolOutput(g.act('status'));
        return applied(g.act(direction, { opId, guideId, revision, stepId }));
      }
      case 'confirm_step': {
        if (g.hasOp(opId)) return toolOutput(g.act('confirm', { opId }));
        const { guideId, revision, stepId, userSaid } = p.args;
        let u = deps.latestUtterance();
        const deadline = Date.now() + UTTERANCE_WAIT_MS;
        // Input transcription can lag the tool call: wait briefly for the user's words to arrive or complete.
        while ((!u || u.consumed || !isAffirmativeCompletion(u.text)) && Date.now() < deadline && !signal.aborted) {
          await deps.waitForUtterance(deadline - Date.now());
          u = deps.latestUtterance();
        }
        if (signal.aborted) throw new GuideAbortedError('aborted');
        if (!isAffirmativeCompletion(userSaid) || !u || u.consumed || !isAffirmativeCompletion(u.text)) {
          log.info('guide_confirm_rejected', { modelArg: isAffirmativeCompletion(userSaid), heard: u ? isAffirmativeCompletion(u.text) : null, consumed: u?.consumed ?? null });
          const r = g.act('status');
          return toolOutput({ ...r, ok: false, code: null, say: null }, { status: 'rejected', code: 'not_confirmed', guidance: NOT_CONFIRMED_GUIDANCE });
        }
        const r = g.act('confirm', { opId, guideId, revision, stepId });
        if (r.ok && r.code !== 'duplicate') u.consumed = true;
        return applied(r);
      }
      case 'undo_completion':
        return applied(g.act('undo', { opId, guideId: p.args.guideId, revision: p.args.revision }));
      case 'pause_guide':
        return applied(g.act('pause', { opId }));
      case 'resume_guide':
        return applied(g.act('resume', { opId }));
      case 'get_guide_status':
        return toolOutput(g.act('status'));
      case 'stop_guide': {
        const r = g.act('stop', { opId });
        if (r.ok) abortInspect();
        return applied(r);
      }
    }
  }

  function applied(r: GuideResult): GuideToolResult {
    if (r.changed) emit(r, null, false);
    return toolOutput(r);
  }

  return {
    get machine() {
      return machine;
    },
    attach(resumeKey) {
      if (resumeKey) {
        const found = store.attach(resumeKey, sessionId);
        if (found) {
          key = resumeKey;
          machine = found;
          restored = true;
          // An inspection that was in flight on the old socket cannot complete: restore the prior phase.
          if (found.inspecting) found.cancelInspect();
          log.info('guide_restored', { phase: found.phase });
          return;
        }
        restored = false;
        log.info('guide_restore_missed', {});
      }
      m();
    },
    readyFields() {
      m();
      return restored === undefined ? { resumeKey: key! } : { resumeKey: key!, guideRestored: restored };
    },
    afterReady() {
      if (!restored || restoreSent || disposed || !machine) return;
      restoreSent = true;
      deps.send({ type: 'guide', guide: machine.snapshot(), requestId: null, result: null });
    },
    onInspect,
    onAction,
    runTool,
    dispose(reason) {
      if (disposed) return;
      abortInspect();
      if (machine?.inspecting && owns()) machine.cancelInspect();
      disposed = true;
      if (!key) return;
      if (reason === 'bye') store.delete(key, sessionId);
      else store.release(key, sessionId);
    },
  };
}
