import { useCallback, useEffect, useRef, useState } from 'react';
import type { AssistantController, AssistantState } from './contracts.js';
import { Announcer } from './ui/Announcer.js';
import { ErrorBanner } from './ui/ErrorBanner.js';
import { EvidencePanel } from './ui/EvidencePanel.js';
import { PausedOverlay } from './ui/PausedOverlay.js';
import { SessionScreen } from './ui/SessionScreen.js';
import { SettingsPanel } from './ui/SettingsPanel.js';
import { StartScreen, isMissingCredentials } from './ui/StartScreen.js';
import { Transcript } from './ui/Transcript.js';
import { useAssistantState } from './ui/useAssistant.js';
import './styles.css';

/** The session screen is shown from Start until the session ends (including errors mid-session). */
export function isInSession(state: AssistantState): boolean {
  if (state.connection === 'idle' || state.connection === 'ended') return false;
  if (state.connection === 'error' && isMissingCredentials(state)) return false;
  return true;
}

export function App({ controller }: { controller: AssistantController }) {
  const state = useAssistantState(controller);
  const inSession = isInSession(state);
  const paused = inSession && state.connection === 'paused';

  const [settingsOpen, setSettingsOpen] = useState(false);
  const summaryRef = useRef<HTMLElement>(null);
  const focusSettings = useRef(false);
  const openSettings = useCallback(() => {
    focusSettings.current = true;
    setSettingsOpen(true);
  }, []);
  useEffect(() => {
    if (settingsOpen && focusSettings.current) {
      focusSettings.current = false;
      summaryRef.current?.focus();
    }
  }, [settingsOpen]);

  // Move focus when the screen changes, so a screen-reader user is not left on a removed button.
  const startRef = useRef<HTMLButtonElement>(null);
  const sessionHeadingRef = useRef<HTMLHeadingElement>(null);
  const prevInSession = useRef(inSession);
  useEffect(() => {
    if (prevInSession.current === inSession) return;
    prevInSession.current = inSession;
    if (inSession) sessionHeadingRef.current?.focus();
    else startRef.current?.focus();
  }, [inSession]);

  return (
    <>
      <div className="app" inert={paused}>
        <header className="app-header">
          <h1 className="app-title">
            <span className="app-title__mark" aria-hidden="true" />
            Sightline
          </h1>
        </header>
        <main className="app-main">
          {inSession ? (
            <SessionScreen state={state} controller={controller} headingRef={sessionHeadingRef} onOpenSettings={openSettings} />
          ) : (
            <>
              <StartScreen state={state} controller={controller} startRef={startRef} />
              {state.error && state.error.code !== 'missing_credentials' && (
                <ErrorBanner state={state} controller={controller} onOpenSettings={openSettings} />
              )}
              {state.lastEvidence && <EvidencePanel evidence={state.lastEvidence} />}
              {state.transcript.length > 0 && <Transcript entries={state.transcript} controller={controller} />}
            </>
          )}
          <SettingsPanel
            state={state}
            controller={controller}
            open={settingsOpen}
            onOpenChange={setSettingsOpen}
            summaryRef={summaryRef}
          />
        </main>
      </div>
      {paused && <PausedOverlay controller={controller} />}
      <Announcer announcement={state.announcement} />
    </>
  );
}
