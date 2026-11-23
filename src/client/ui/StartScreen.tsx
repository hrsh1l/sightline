import type { Ref } from 'react';
import type { AssistantController, AssistantState } from '../contracts.js';
import { MISSING_CREDENTIALS_TEXT } from './labels.js';

export function isMissingCredentials(state: AssistantState): boolean {
  return state.server?.configured === false || state.error?.code === 'missing_credentials';
}

/** First screen: what Sightline is, what is sent where, and one large Start button. */
export function StartScreen({
  state,
  controller,
  startRef,
}: {
  state: AssistantState;
  controller: AssistantController;
  startRef?: Ref<HTMLButtonElement>;
}) {
  const notConfigured = isMissingCredentials(state);
  const ended = state.connection === 'ended';

  return (
    <section className="start" aria-labelledby="start-heading">
      <h2 id="start-heading" className="start__tagline">
        Ask about what’s in front of you
      </h2>
      <p className="start__purpose">
        Point the phone’s rear camera at an object or printed label and ask out loud — for example “What am I holding?” or “Read
        the cooking instructions”. Sightline answers briefly by voice.
      </p>

      <section className="start__privacy" aria-labelledby="privacy-heading">
        <h3 id="privacy-heading">Privacy</h3>
        <p>
          While a session is active, selected camera frames and your microphone audio are sent to the configured AI provider
          (Google Gemini) to answer you. Nothing is saved by Sightline after you end the session.
        </p>
      </section>

      {ended && (
        <p className="start__ended" data-testid="session-ended">
          Session ended. The camera and microphone are off.
        </p>
      )}

      {notConfigured && (
        <section className="config-message" aria-labelledby="config-heading" data-testid="config-message">
          <h3 id="config-heading">Not set up yet</h3>
          <p id="config-detail">{MISSING_CREDENTIALS_TEXT}</p>
        </section>
      )}

      <button
        ref={startRef}
        type="button"
        className="btn btn--primary btn--start"
        disabled={notConfigured}
        aria-describedby={notConfigured ? 'config-detail' : undefined}
        // start() MUST run synchronously inside the tap: it unlocks audio and requests camera + mic.
        onClick={() => {
          void controller.start();
        }}
      >
        Start assistant
      </button>
      <p className="hint">Chrome will ask to use the camera and microphone.</p>
    </section>
  );
}
