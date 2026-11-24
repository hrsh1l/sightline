import { useEffect, useId, useRef } from 'react';
import type { AssistantController, AssistantState, CalibrationState, CalibrationStep } from '../contracts.js';
import {
  CALIBRATION_MIC_ADVICE,
  CALIBRATION_NO,
  CALIBRATION_QUESTION,
  CALIBRATION_STEP_TEXT,
  CALIBRATION_YES,
  SAMSUNG_360_NOTE,
  calibrationMicText,
} from './findText.js';

const IDLE: CalibrationState = { step: 'idle', heardSeparation: null, micActive: false };

const isPlaying = (step: CalibrationStep): step is 'left' | 'right' | 'centre' =>
  step === 'left' || step === 'right' || step === 'centre';

/** Decorative ear marker for the tone steps: which side is playing, shown by position not colour. */
function ToneIcon({ step }: { step: 'left' | 'right' | 'centre' }) {
  return (
    <svg className="tone-icon" viewBox="0 0 32 16" aria-hidden="true" focusable="false" data-step={step}>
      <circle cx="5" cy="8" r="4" fill={step !== 'right' ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="1.5" />
      <circle cx="27" cy="8" r="4" fill={step !== 'left' ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="1.5" />
      {step === 'centre' && <circle cx="16" cy="8" r="2.5" fill="currentColor" />}
    </svg>
  );
}

function resultText(c: CalibrationState, guidanceMode: 'stereo' | 'spoken'): string {
  if (c.heardSeparation === true) return 'Stereo works: you heard left, right and centre. Stereo beeps can guide you.';
  if (c.heardSeparation === false) {
    return guidanceMode === 'spoken'
      ? 'Thanks. Spoken directions is now on: Sightline will say left, right, up or down.'
      : 'Thanks. Choose Spoken directions under Guidance mode to hear spoken left, right, up or down.';
  }
  return 'Stereo check finished.';
}

/**
 * User-started stereo check: left tone, right tone, centre tone, then a yes/no question. Inline (no dialog), with
 * focus moved to the step text, the question and the result as they appear, and back to the start button after
 * Cancel, so nothing has to be found again by a screen-reader user.
 */
export function StereoCheck({ state, controller }: { state: AssistantState; controller: AssistantController }) {
  const c = state.calibration ?? IDLE;
  const headingId = useId();
  const questionId = useId();
  const noHintId = useId();
  const groupRef = useRef<HTMLDivElement>(null);
  const startRef = useRef<HTMLButtonElement>(null);
  const stepRef = useRef<HTMLParagraphElement>(null);
  const questionRef = useRef<HTMLParagraphElement>(null);
  const resultRef = useRef<HTMLParagraphElement>(null);
  const prevStep = useRef<CalibrationStep>(c.step);

  const active = isPlaying(c.step) || c.step === 'confirm';

  useEffect(() => {
    const prev = prevStep.current;
    if (prev === c.step) return;
    prevStep.current = c.step;
    // Only move focus if it is in this section or nowhere (never pull it away from elsewhere in the app).
    const focused = document.activeElement;
    const ours = !focused || focused === document.body || !!groupRef.current?.contains(focused);
    if (!ours) return;
    if (isPlaying(c.step) && !isPlaying(prev)) stepRef.current?.focus();
    else if (c.step === 'confirm') questionRef.current?.focus();
    else if (c.step === 'done') resultRef.current?.focus();
    else if (c.step === 'idle') startRef.current?.focus();
  }, [c.step]);

  return (
    <div className="stereo-check" role="group" aria-labelledby={headingId} ref={groupRef} data-testid="stereo-check">
      <h3 id={headingId} className="find__subheading">
        Stereo check
      </h3>
      <p className="hint">{SAMSUNG_360_NOTE}</p>

      {!active && (
        <button
          ref={startRef}
          type="button"
          className="btn"
          // Synchronous inside the tap: the controller resumes the shared AudioContext here.
          onClick={() => void controller.startCalibration()}
        >
          <span className="btn__label">Check stereo (calibrate)</span>
        </button>
      )}

      {isPlaying(c.step) && (
        <p className="calibration__step" ref={stepRef} tabIndex={-1} data-testid="calibration-step">
          <ToneIcon step={c.step} />
          <span>{CALIBRATION_STEP_TEXT[c.step]}</span>
        </p>
      )}

      {c.step === 'confirm' && (
        <>
          <p className="calibration__question" id={questionId} ref={questionRef} tabIndex={-1} data-testid="calibration-question">
            {CALIBRATION_QUESTION}
          </p>
          <div className="calibration__answers" role="group" aria-labelledby={questionId}>
            <button type="button" className="btn btn--primary" onClick={() => controller.answerCalibration(true)}>
              <span className="btn__label">{CALIBRATION_YES}</span>
            </button>
            <button type="button" className="btn" aria-describedby={noHintId} onClick={() => controller.answerCalibration(false)}>
              <span className="btn__label">{CALIBRATION_NO}</span>
            </button>
          </div>
          <p className="hint" id={noHintId}>
            Answering No turns on Spoken directions.
          </p>
        </>
      )}

      {c.step === 'done' && (
        <p className="calibration__result" ref={resultRef} tabIndex={-1} data-testid="calibration-result">
          {resultText(c, state.settings.guidanceMode)}
        </p>
      )}

      {c.step !== 'idle' && (
        <p className="hint" data-testid="calibration-mic">
          {calibrationMicText(c.micActive)}
          {c.micActive && ` ${CALIBRATION_MIC_ADVICE}`}
        </p>
      )}

      {active && (
        <button type="button" className="btn" onClick={() => controller.cancelCalibration()}>
          <span className="btn__label">Cancel</span>
        </button>
      )}
    </div>
  );
}
