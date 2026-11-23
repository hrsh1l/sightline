import type { AssistantController, AssistantState } from '../contracts.js';
import { ERROR_ACTION_TEXT, errorHelp } from './labels.js';

/**
 * Persistent error with concrete recovery buttons. Not a live region: the controller's announcement
 * reports the error once, and the banner stays for reference.
 */
export function ErrorBanner({
  state,
  controller,
  onOpenSettings,
}: {
  state: AssistantState;
  controller: AssistantController;
  onOpenSettings: () => void;
}) {
  const error = state.error;
  if (!error) return null;
  const help = errorHelp(error, state.camera, state.mic);
  const action = error.action && error.action !== 'none' ? error.action : null;

  const runAction = () => {
    switch (action) {
      case 'retry':
        // Called directly in the tap handler: start() unlocks audio and requests media.
        void controller.start();
        break;
      case 'tap_to_resume':
        void controller.resume();
        break;
      case 'use_snapshot':
        controller.setMode('snapshot');
        break;
      case 'open_settings':
        onOpenSettings();
        break;
      default:
        break;
    }
  };

  return (
    <section className="error-banner" aria-labelledby="error-heading" data-testid="error-banner">
      <h2 id="error-heading" className="error-banner__title">
        <span aria-hidden="true" className="error-banner__mark">
          !
        </span>{' '}
        {error.recoverable ? 'Problem' : 'Cannot continue'}
      </h2>
      <p className="error-banner__message">{error.message}</p>
      {help && help !== error.message && <p className="error-banner__help">{help}</p>}
      <div className="button-row">
        {action && (
          <button type="button" className="btn btn--primary" onClick={runAction}>
            {ERROR_ACTION_TEXT[action]}
          </button>
        )}
        <button type="button" className="btn" onClick={() => controller.dismissError()}>
          Dismiss
        </button>
      </div>
    </section>
  );
}
