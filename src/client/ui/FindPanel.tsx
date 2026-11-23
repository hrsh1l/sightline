import { useId, useState, type FormEvent } from 'react';
import { LIMITS, type FindState } from '../../shared/protocol.js';
import type { AssistantController, AssistantState } from '../contracts.js';
import { isSessionReady } from './Controls.js';
import { findStatusText, isFindRunning } from './labels.js';

export const FIND_HELP =
  'Beeps guide you: left/right in your ears = left/right in the picture, higher pitch = higher in the picture, faster = closer to the centre. Headphones work best.';

/**
 * Decorative shape per find state so the state is never shown by colour alone (the text is primary):
 * searching = magnifier, tracking = frame with an off-centre dot, centered = crosshair on a filled centre,
 * lost = dashed ring, not_found = cross, stopped/timeout = square.
 */
export function FindIcon({ state }: { state: FindState }) {
  return (
    <svg className={`find-icon find-icon--${state}`} viewBox="0 0 24 24" aria-hidden="true" focusable="false" data-state={state}>
      {state === 'searching' && (
        <>
          <circle cx="10" cy="10" r="6" fill="none" stroke="currentColor" strokeWidth="2.5" />
          <path d="M14.5 14.5 L21 21" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
        </>
      )}
      {state === 'tracking' && (
        <>
          <rect x="2.5" y="2.5" width="19" height="19" rx="3" fill="none" stroke="currentColor" strokeWidth="2" />
          <circle cx="7.5" cy="8" r="3" fill="currentColor" />
        </>
      )}
      {state === 'centered' && (
        <>
          <circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" strokeWidth="2" />
          <circle cx="12" cy="12" r="4" fill="currentColor" />
          <path d="M12 0.5 V5 M12 19 V23.5 M0.5 12 H5 M19 12 H23.5" stroke="currentColor" strokeWidth="2" />
        </>
      )}
      {state === 'lost' && (
        <circle cx="12" cy="12" r="8.5" fill="none" stroke="currentColor" strokeWidth="2.5" strokeDasharray="4 3" />
      )}
      {state === 'not_found' && (
        <path d="M5 5 L19 19 M19 5 L5 19" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
      )}
      {(state === 'stopped' || state === 'timeout') && <rect x="5" y="5" width="14" height="14" fill="currentColor" />}
    </svg>
  );
}

/** "Find something": typed query -> controller.find; while running, a prominent status line and Stop finding. */
export function FindPanel({ state, controller }: { state: AssistantState; controller: AssistantController }) {
  const [text, setText] = useState('');
  const inputId = useId();
  const helpId = useId();
  const ready = isSessionReady(state);
  const find = state.find;
  const running = isFindRunning(find);

  const onSubmit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const q = text.trim();
    if (!q || !ready) return;
    // Synchronous inside the user gesture: the controller unlocks the cue AudioContext here.
    void controller.find(q);
    setText('');
  };

  return (
    <section className="find" aria-labelledby="find-heading">
      <h2 id="find-heading" className="section-heading">
        Find something
      </h2>

      {find && (
        <div className={`find-status find-status--${find.state}`} data-testid="find-status">
          <p className="find-status__text">
            <FindIcon state={find.state} />
            <span>{findStatusText(find)}</span>
          </p>
          {running && (
            <button type="button" className="btn btn--find-stop" onClick={() => controller.stopFind()}>
              <span className="btn__mark" aria-hidden="true" />
              <span className="btn__label">Stop finding</span>
            </button>
          )}
        </div>
      )}

      <form className="find-form" onSubmit={onSubmit}>
        <label htmlFor={inputId} className="ask-form__label">
          What should I find?
        </label>
        <p id={helpId} className="hint">
          {FIND_HELP}
          {!state.settings.spatialAudio && ' Aiming beeps are off in Settings.'}
          {!ready && ' Available once connected.'}
        </p>
        <div className="ask-form__row">
          <input
            id={inputId}
            className="text-input"
            type="text"
            inputMode="search"
            enterKeyHint="search"
            autoComplete="off"
            maxLength={LIMITS.maxFindQueryChars}
            aria-describedby={helpId}
            value={text}
            onChange={(e) => setText(e.target.value)}
          />
          <button type="submit" className="btn btn--primary ask-form__submit" disabled={!ready} aria-describedby={helpId}>
            Find
          </button>
        </div>
      </form>
    </section>
  );
}
