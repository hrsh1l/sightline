import type { AssistantController, AssistantState } from '../contracts.js';
import { CONNECTION_TEXT, cameraText, micText, type StatusText } from './labels.js';
import { StatusIcon } from './StatusIcon.js';

function Item({ name, status, testId }: { name: string; status: StatusText; testId: string }) {
  return (
    <li className={`status-item status-item--${status.tone}`} data-testid={testId}>
      <StatusIcon tone={status.tone} />
      <span className="status-item__name">{name}:</span> <span className="status-item__value">{status.text}</span>
    </li>
  );
}

/**
 * Connection, microphone, camera and speaking state as text + shape. Not a live region: changes are
 * announced through the Announcer only.
 */
export function StatusBar({ state, controller }: { state: AssistantState; controller: AssistantController }) {
  const connection = CONNECTION_TEXT[state.connection];
  const mic = micText(state.mic, { talking: state.talking, pushToTalk: state.settings.pushToTalk });
  const camera = cameraText(state.camera);
  const speaking: StatusText = state.speaking ? { text: 'Speaking', tone: 'ok' } : { text: 'Not speaking', tone: 'off' };

  return (
    <section className="status-bar" aria-labelledby="status-heading">
      <h2 id="status-heading" className="visually-hidden">
        Status
      </h2>
      <ul className="status-list">
        {state.connection === 'paused' ? (
          <li className="status-item status-item--warn" data-testid="status-connection">
            <button type="button" className="status-resume" onClick={() => void controller.resume()}>
              <StatusIcon tone="warn" />
              <span className="status-item__name">Connection:</span> <span className="status-item__value">{connection.text}</span>
            </button>
          </li>
        ) : (
          <Item name="Connection" status={connection} testId="status-connection" />
        )}
        <Item name="Microphone" status={mic} testId="status-mic" />
        <Item name="Camera" status={camera} testId="status-camera" />
        <Item name="Sightline" status={speaking} testId="status-speaking" />
      </ul>
    </section>
  );
}
