import type { Ref } from 'react';
import type { AssistantController, AssistantState } from '../contracts.js';
import { AskForm } from './AskForm.js';
import { CameraPreview } from './CameraPreview.js';
import { Controls } from './Controls.js';
import { ErrorBanner } from './ErrorBanner.js';
import { EvidencePanel } from './EvidencePanel.js';
import { FindPanel } from './FindPanel.js';
import { GuidePanel } from './GuidePanel.js';
import { BUSY_TEXT } from './labels.js';
import { StatusBar } from './StatusBar.js';
import { Transcript } from './Transcript.js';

/** Everything needed during a session, in a logical reading/focus order. The preview is decorative. */
export function SessionScreen({
  state,
  controller,
  headingRef,
  onOpenSettings,
}: {
  state: AssistantState;
  controller: AssistantController;
  headingRef?: Ref<HTMLHeadingElement>;
  onOpenSettings: () => void;
}) {
  return (
    <div className="session">
      <h2 id="session-heading" className="visually-hidden" tabIndex={-1} ref={headingRef}>
        Session
      </h2>
      <StatusBar state={state} controller={controller} />

      {state.mode === 'snapshot' && (
        <div className="mode-banner" data-testid="snapshot-banner">
          <p className="mode-banner__text">
            <span className="mode-banner__mark" aria-hidden="true" />
            Snapshot mode — answers use a still photo and typed questions
          </p>
          <button type="button" className="btn btn--small" onClick={() => controller.setMode('live')}>
            Switch to Live
          </button>
        </div>
      )}

      {state.busy && (
        <p className="busy" data-testid="busy">
          <span className="busy__mark" aria-hidden="true" />
          {BUSY_TEXT[state.busy.kind]}
        </p>
      )}

      <ErrorBanner state={state} controller={controller} onOpenSettings={onOpenSettings} />

      <div className={state.settings.showPreview ? 'session__layout' : 'session__layout session__layout--no-preview'}>
        <div className="session__media">
          <CameraPreview
            controller={controller}
            camera={state.camera}
            detections={state.detections}
            find={state.find}
            show={state.settings.showPreview}
          />
        </div>
        <div className="session__panel">
          <Controls state={state} controller={controller} />
          <GuidePanel state={state} controller={controller} />
          <FindPanel state={state} controller={controller} />
          <AskForm state={state} controller={controller} />
        </div>
      </div>

      {state.lastEvidence && <EvidencePanel evidence={state.lastEvidence} timeZone={state.server?.timeZone ?? null} />}
      <Transcript entries={state.transcript} controller={controller} />
    </div>
  );
}
