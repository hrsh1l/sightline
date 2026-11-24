import { useEffect, useId, useRef, useState, type FormEvent, type ReactNode, type RefObject } from 'react';
import { GUIDE_LIMITS, type GuideAction, type GuideSnapshot, type GuideStepState } from '../../shared/guide.js';
import type { AssistantController, AssistantState } from '../contracts.js';
import { isSessionReady } from './Controls.js';
import {
  GUIDE_DONE_NOTE,
  GUIDE_INTRO,
  GUIDE_LOST_BANNER,
  GUIDE_START_LABEL,
  PHASE_TONE,
  STEP_STATUS_TEXT,
  adjustmentText,
  captureTimeText,
  guidePhaseText,
  isGuideActive,
  sectionChoiceLabel,
  stepPositionText,
  stepStatus,
  type StepStatus,
} from './guideText.js';
import { StatusIcon } from './StatusIcon.js';

/** Focus follows a pressed control that disappeared only if the change arrives within this time. */
const FOCUS_FOLLOW_MS = 40_000;

/** Decorative shape per step status (text is primary): tick = confirmed, open eye-dot = read, dashed ring = unread. */
function StepStatusIcon({ status }: { status: StepStatus }) {
  return (
    <svg className={`guide-chip__icon guide-chip__icon--${status}`} viewBox="0 0 20 20" aria-hidden="true" focusable="false">
      {status === 'confirmed' && <path d="M3.5 10.5 L8 15 L16.5 5" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />}
      {status === 'read' && (
        <>
          <circle cx="10" cy="10" r="7" fill="none" stroke="currentColor" strokeWidth="2" />
          <circle cx="10" cy="10" r="2.75" fill="currentColor" />
        </>
      )}
      {status === 'unread' && <circle cx="10" cy="10" r="7" fill="none" stroke="currentColor" strokeWidth="2" strokeDasharray="3 2.5" />}
    </svg>
  );
}

export function StepChip({ step }: { step: GuideStepState }) {
  const status = stepStatus(step);
  return (
    <span className={`guide-chip guide-chip--${status}`} data-testid="guide-chip" data-status={status}>
      <StepStatusIcon status={status} />
      {STEP_STATUS_TEXT[status]}
    </span>
  );
}

/**
 * A guide control. When not applicable it stays focusable with aria-disabled and says why (aria-describedby), so
 * focus is not lost when a press makes it unavailable (e.g. Done after confirming).
 */
function GuideButton({
  label,
  ariaLabel,
  sub,
  reason,
  className = '',
  onPress,
  testId,
}: {
  label: string;
  ariaLabel?: string;
  sub?: ReactNode;
  reason: string | null;
  className?: string;
  onPress: () => void;
  testId?: string;
}) {
  const reasonId = useId();
  const subId = useId();
  // The sub-line is a description (e.g. "Partly readable"), unless the aria-label already says it (Done).
  const describedBy = reason ? reasonId : sub && !ariaLabel ? subId : undefined;
  return (
    <button
      type="button"
      className={`btn ${className}`.trim()}
      aria-label={ariaLabel}
      aria-disabled={reason ? true : undefined}
      aria-describedby={describedBy}
      data-testid={testId}
      onClick={() => {
        if (!reason) onPress();
      }}
    >
      <span className="btn__label">{label}</span>
      {sub && !reason && (
        <span className="btn__state" id={subId} aria-hidden="true">
          {sub}
        </span>
      )}
      {reason && (
        <span className="btn__state" id={reasonId} aria-hidden="true">
          {reason}
        </span>
      )}
    </button>
  );
}

function GuideIdle({ ready, controller, onStart }: { ready: boolean; controller: AssistantController; onStart: () => void }) {
  const introId = useId();
  const goalId = useId();
  const goalHintId = useId();
  const unavailableId = useId();
  const [goal, setGoal] = useState('');
  const describe = (id: string) => (ready ? id : `${id} ${unavailableId}`);

  const onSubmit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!ready) return;
    onStart();
    void controller.guideInspect(goal.trim() || 'instructions');
    setGoal('');
  };

  return (
    <div className="guide-idle">
      <p className="guide__intro" id={introId}>
        {GUIDE_INTRO}
      </p>
      <button
        type="button"
        className="btn btn--primary btn--guide-start"
        disabled={!ready}
        aria-describedby={describe(introId)}
        onClick={() => {
          onStart();
          void controller.guideInspect('instructions');
        }}
      >
        {GUIDE_START_LABEL}
      </button>
      <form className="guide-goal" onSubmit={onSubmit}>
        <label htmlFor={goalId} className="ask-form__label">
          What instructions?
        </label>
        <p className="hint" id={goalHintId}>
          For example: storage instructions, or microwave instructions.
        </p>
        <div className="ask-form__row">
          <input
            id={goalId}
            className="text-input"
            type="text"
            inputMode="text"
            enterKeyHint="go"
            autoComplete="off"
            maxLength={GUIDE_LIMITS.maxGoalChars}
            aria-describedby={describe(goalHintId)}
            value={goal}
            onChange={(e) => setGoal(e.target.value)}
          />
          <button type="submit" className="btn ask-form__submit" disabled={!ready} aria-describedby={describe(goalHintId)}>
            Guide me
          </button>
        </div>
      </form>
      {!ready && (
        <p className="hint" id={unavailableId}>
          Available once connected.
        </p>
      )}
    </div>
  );
}

function StepControls({ g, ready, controller, onFocusAfter }: { g: GuideSnapshot; ready: boolean; controller: AssistantController; onFocusAfter: () => void }) {
  const idx = g.currentIndex;
  const step = idx !== null ? (g.steps[idx] ?? null) : null;
  const x = idx !== null ? idx + 1 : null;
  const paused = g.phase === 'paused';
  const act = (a: GuideAction) => () => controller.guideAction(a);
  const offline = ready ? null : 'Available once connected';
  const stepReason = offline ?? (paused ? 'Paused — tap Resume first' : !step ? 'No step yet' : null);
  const prevReason = stepReason ?? (idx === 0 ? 'Already at step 1' : null);
  const nextReason = stepReason ?? (idx !== null && idx >= g.steps.length - 1 ? 'This is the last step' : null);
  const doneReason =
    stepReason ?? (g.phase === 'completed' ? 'All steps are done' : step?.confirmed ? `Step ${x} is already done` : null);
  const canPause = g.phase === 'guiding' || g.phase === 'paused';
  const doneLabel = x !== null ? `Done — I've finished step ${x}` : 'Done';

  return (
    <div className="guide-controls" role="group" aria-label="Step controls">
      <GuideButton
        label="Done"
        ariaLabel={doneLabel}
        sub={x !== null ? `I've finished step ${x}` : undefined}
        reason={doneReason}
        className="btn--guide-done guide-controls__wide"
        onPress={act('confirm')}
        testId="guide-done"
      />
      <GuideButton label="Previous" reason={prevReason} onPress={act('previous')} />
      <GuideButton label="Next" reason={nextReason} onPress={act('next')} />
      <GuideButton label="Repeat" reason={stepReason} onPress={act('repeat')} />
      <GuideButton label="Explain" reason={stepReason} onPress={act('explain')} />
      {g.confirmations.length > 0 && (
        <GuideButton
          label="Undo last done"
          reason={offline}
          onPress={() => {
            onFocusAfter();
            controller.guideAction('undo');
          }}
        />
      )}
      {canPause && (
        <GuideButton
          label={paused ? 'Resume' : 'Pause'}
          reason={offline}
          className={paused ? 'btn--toggle is-active' : ''}
          onPress={act(paused ? 'resume' : 'pause')}
        />
      )}
    </div>
  );
}

function SourceText({ g }: { g: GuideSnapshot }) {
  return (
    <details className="guide-source" data-testid="guide-source">
      <summary className="guide-source__summary">Show source text</summary>
      <div className="guide-source__body">
        <p className="hint">Exactly as read from the photo, so you can check what was extracted.</p>
        {g.steps.length > 0 && (
          <ol className="guide-source__steps">
            {g.steps.map((s, i) => (
              <li key={s.id} className={i === g.currentIndex ? 'guide-source__step is-current' : 'guide-source__step'}>
                <p className="guide-source__head">
                  <span className="field-name">
                    Step {i + 1}
                    {i === g.currentIndex ? ' (current)' : ''}:
                  </span>{' '}
                  <StepChip step={s} />
                </p>
                <p className="verbatim">{s.sourceText}</p>
                {s.warnings.length > 0 && (
                  <ul className="verbatim-list">
                    {s.warnings.map((w, j) => (
                      <li key={j} className="verbatim">
                        {w}
                      </li>
                    ))}
                  </ul>
                )}
              </li>
            ))}
          </ol>
        )}
        {g.warnings.length > 0 && (
          <>
            <h4>Warnings printed with these instructions</h4>
            <ul className="verbatim-list">
              {g.warnings.map((w, i) => (
                <li key={i} className="verbatim">
                  {w}
                </li>
              ))}
            </ul>
          </>
        )}
        {g.missing.length > 0 && (
          <>
            <h4>Not readable</h4>
            <ul className="verbatim-list">
              {g.missing.map((m, i) => (
                <li key={i}>{m}</li>
              ))}
            </ul>
          </>
        )}
        {g.sourceFrames.length > 0 && (
          <p className="hint" data-testid="guide-source-frames">
            From {g.sourceFrames.length === 1 ? 'a photo' : `${g.sourceFrames.length} photos`} taken at{' '}
            {g.sourceFrames.map((f) => captureTimeText(f.capturedAt)).join(', ')}.
          </p>
        )}
      </div>
    </details>
  );
}

function ActiveGuide({
  state,
  controller,
  statusRef,
  onFocusAfter,
}: {
  state: AssistantState;
  controller: AssistantController;
  statusRef: RefObject<HTMLParagraphElement | null>;
  onFocusAfter: () => void;
}) {
  const g = state.guide;
  const ready = isSessionReady(state);
  const checking = state.busy?.kind === 'checking_view';
  const statusId = useId();
  const partialId = useId();
  const step = g.currentIndex !== null ? (g.steps[g.currentIndex] ?? null) : null;
  const pos = stepPositionText(g);
  const adjustment = g.phase === 'needs_better_view' ? adjustmentText(g) : null;
  const showMessage = g.message && g.phase !== 'needs_better_view' && g.phase !== 'error';
  const hasDoc = g.steps.length > 0;
  const confirmed = g.steps.filter((s) => s.confirmed).length;
  const showStepControls = hasDoc && (g.phase === 'guiding' || g.phase === 'paused' || g.phase === 'completed');
  const partial = g.partial || g.missing.length > 0;
  const offline = ready ? null : 'Available once connected';

  return (
    <div className="guide-active">
      <div className={`guide-status guide-status--${g.phase}`} data-testid="guide-status">
        <p className="guide-status__text" id={statusId} ref={statusRef} tabIndex={-1} data-testid="guide-status-text">
          <StatusIcon tone={PHASE_TONE[g.phase]} />
          <span>{guidePhaseText(g)}</span>
        </p>
        {adjustment && (
          <p className="guide-adjustment" data-testid="guide-adjustment">
            {adjustment}
          </p>
        )}
        {showMessage && (
          <p className="guide-message" data-testid="guide-message">
            {g.message}
          </p>
        )}
      </div>

      {g.phase === 'choosing_section' && g.sectionChoices.length > 0 && (
        <div className="guide-choices" role="group" aria-labelledby={statusId} data-testid="guide-choices">
          {g.sectionChoices.map((c) => (
            <GuideButton
              key={c.id}
              label={sectionChoiceLabel(c)}
              sub={c.complete ? undefined : 'Partly readable'}
              reason={offline}
              className="btn--candidate"
              onPress={() => {
                onFocusAfter();
                controller.guideAction('choose_section', { sectionId: c.id });
              }}
            />
          ))}
        </div>
      )}

      {partial && (
        <p className="guide-partial" id={partialId} data-testid="guide-partial">
          <span className="field-name">Only part of the instructions was readable{g.missing.length ? ':' : '.'}</span>
          {g.missing.length > 0 && ` ${g.missing.join(' ')}`} Move the phone, then tap Check this view.
        </p>
      )}

      <GuideButton
        label="Check this view"
        sub={checking ? 'Checking…' : 'Takes a fresh photo'}
        reason={offline}
        className="btn--guide-check"
        onPress={() => void controller.guideInspect()}
        testId="guide-check"
      />

      {(g.title || g.section) && (
        <div className="guide-doc" data-testid="guide-doc">
          {g.title && (
            <p className="guide-doc__line">
              <span className="field-name">Instructions:</span> {g.title}
            </p>
          )}
          {g.section && (
            <p className="guide-doc__line">
              <span className="field-name">Method:</span> {g.section.title}
            </p>
          )}
        </div>
      )}

      {g.warnings.length > 0 && hasDoc && (
        <div className="guide-warnings" data-testid="guide-warnings">
          <h3 className="find__subheading">Warnings</h3>
          <ul>
            {g.warnings.map((w, i) => (
              <li key={i}>{w}</li>
            ))}
          </ul>
        </div>
      )}

      {step && pos && (
        <div className="guide-step" data-testid="guide-step">
          <div className="guide-step__head">
            <h3 className="guide-step__pos" data-testid="guide-step-pos">
              {pos}
            </h3>
            <StepChip step={step} />
          </div>
          <p className="guide-step__text" data-testid="guide-step-text">
            {step.spoken}
          </p>
          {step.quantities.length > 0 && (
            <p className="guide-step__quantities" data-testid="guide-quantities">
              <span className="field-name">Quantities:</span> {step.quantities.map((q) => q.text).join(', ')}
            </p>
          )}
          {step.warnings.length > 0 && (
            <ul className="guide-step__warnings" data-testid="guide-step-warnings">
              {step.warnings.map((w, i) => (
                <li key={i}>
                  <span className="field-name">Warning:</span> {w}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {hasDoc && (
        <p className="guide-progress" data-testid="guide-progress">
          {confirmed} of {g.steps.length} steps confirmed done. <span className="hint">{GUIDE_DONE_NOTE}</span>
        </p>
      )}

      {showStepControls && <StepControls g={g} ready={ready} controller={controller} onFocusAfter={onFocusAfter} />}

      <div className="guide-controls guide-controls--session">
        <GuideButton label="Where were we?" reason={offline} onPress={() => controller.guideAction('status')} />
        <GuideButton
          label="Stop guide"
          reason={null}
          className="btn--guide-stop"
          onPress={() => {
            onFocusAfter();
            controller.guideAction('stop');
          }}
        />
      </div>

      {(hasDoc || g.sourceFrames.length > 0) && <SourceText g={g} />}
    </div>
  );
}

/**
 * "Instructions" panel: idle entry (Guide me through instructions / What instructions?), or the active guide driven
 * by the server's authoritative snapshot: status per phase, current step, per-step Read vs Confirmed done, step
 * controls and the verbatim source text. Not a live region (the Announcer is the only one).
 */
export function GuidePanel({ state, controller }: { state: AssistantState; controller: AssistantController }) {
  const g = state.guide;
  const ready = isSessionReady(state);
  const active = isGuideActive(g);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const statusRef = useRef<HTMLParagraphElement>(null);
  /** Time of the press whose control may disappear; a stale press (no answer) never moves focus later. */
  const focusPending = useRef<number | null>(null);
  const onFocusAfter = () => {
    focusPending.current = Date.now();
  };
  const hasConfirmations = g.confirmations.length > 0;

  // When the pressed control disappears (a section choice, Stop guide, Undo, Start again, the idle entry), move
  // focus to the status text (or the heading) so a screen-reader user is not dropped at the top of the page.
  useEffect(() => {
    const pressedAt = focusPending.current;
    if (pressedAt === null) return;
    focusPending.current = null;
    if (Date.now() - pressedAt > FOCUS_FOLLOW_MS) return;
    (statusRef.current ?? headingRef.current)?.focus();
  }, [g.phase, state.guideLost, hasConfirmations]);

  return (
    <section className={active ? 'guide guide--active' : 'guide'} aria-labelledby="guide-heading" data-testid="guide-panel">
      <h2 id="guide-heading" className="section-heading" ref={headingRef} tabIndex={-1}>
        Instructions
      </h2>

      {state.guideLost && (
        <div className="guide-lost" data-testid="guide-lost">
          <p className="guide-lost__text">
            <StatusIcon tone="warn" />
            <span>{GUIDE_LOST_BANNER}</span>
          </p>
          <button
            type="button"
            className="btn btn--small"
            disabled={!ready}
            onClick={() => {
              onFocusAfter();
              void controller.guideInspect(g.goal ?? 'instructions');
            }}
          >
            Start again
          </button>
        </div>
      )}

      {active ? (
        <ActiveGuide state={state} controller={controller} statusRef={statusRef} onFocusAfter={onFocusAfter} />
      ) : (
        <GuideIdle ready={ready} controller={controller} onStart={onFocusAfter} />
      )}
    </section>
  );
}
