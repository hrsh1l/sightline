import { useEffect, useRef } from 'react';
import type { AssistantController } from '../contracts.js';

/**
 * Full-screen resume target shown while the session is paused (backgrounded or audio suspended).
 * The whole screen is one button so it can be found without sight; it takes focus on appearance.
 */
export function PausedOverlay({ controller }: { controller: AssistantController }) {
  const ref = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    ref.current?.focus();
  }, []);
  return (
    <div className="paused-overlay">
      <button ref={ref} type="button" className="paused-overlay__button" onClick={() => void controller.resume()}>
        <span className="paused-overlay__title">Tap to resume</span>
        <span className="paused-overlay__detail" aria-hidden="true">
          Sightline paused the camera and microphone. Nothing is sent while paused.
        </span>
      </button>
    </div>
  );
}
