import type { AssistantController, AssistantState } from '../contracts.js';
import { PushToTalkButton } from './PushToTalkButton.js';

export function isSessionReady(state: AssistantState): boolean {
  return state.connection === 'live' || state.connection === 'snapshot';
}

/** Primary controls, in the order they are most often needed. */
export function Controls({ state, controller }: { state: AssistantState; controller: AssistantController }) {
  const ready = isSessionReady(state);
  const muted = state.mic.status === 'muted';
  const micUsable = state.mic.status === 'active' || state.mic.status === 'muted';
  const showTalk = state.settings.pushToTalk && state.mode === 'live';
  const canSwitch = state.camera.canSwitch && state.camera.status === 'active';
  const torchUsable = state.camera.torch.supported && state.camera.status === 'active';
  const torchOn = torchUsable && state.camera.torch.on;
  const cameraPaused = state.cameraPaused;
  const cameraHint = cameraPaused ? 'camera-hint' : undefined;

  return (
    <section className="controls" aria-labelledby="controls-heading">
      <h2 id="controls-heading" className="section-heading">
        Controls
      </h2>
      {!ready && (
        <p className="hint" id="controls-unavailable">
          Reading, looking and repeating are available once Sightline is connected.
        </p>
      )}
      <div className="control-grid">
        <button
          type="button"
          className="btn btn--stop"
          disabled={!state.speaking}
          aria-describedby={state.speaking ? undefined : 'stop-hint'}
          onClick={() => controller.stopSpeaking()}
        >
          <span className="btn__label">Stop speaking</span>
          {!state.speaking && (
            <span className="btn__state" id="stop-hint" aria-hidden="true">
              Available while Sightline is speaking
            </span>
          )}
        </button>

        {showTalk && (
          <div className="control-grid__wide">
            <PushToTalkButton
              talking={state.talking}
              disabled={!ready || !micUsable || muted}
              describedBy={!ready || !micUsable || muted ? 'talk-hint' : undefined}
              onTalk={(down) => controller.setTalking(down)}
            />
            {(!ready || !micUsable || muted) && (
              <p className="hint" id="talk-hint">
                {muted ? 'Unmute the microphone to talk.' : !micUsable ? 'The microphone is not available.' : 'Available once connected.'}
              </p>
            )}
          </div>
        )}

        <button
          type="button"
          className={`btn btn--toggle${muted ? ' is-active' : ''}`}
          aria-pressed={muted}
          disabled={!micUsable}
          aria-describedby={micUsable ? undefined : 'mute-hint'}
          onClick={() => controller.setMuted(!muted)}
        >
          <span className="btn__label">Mute microphone</span>
          <span className="btn__state" id="mute-hint" aria-hidden="true">
            {micUsable ? (muted ? 'Muted — tap to unmute' : 'Microphone on') : 'Microphone not available'}
          </span>
        </button>

        <button
          type="button"
          className="btn btn--primary"
          disabled={!ready}
          aria-describedby={ready ? cameraHint : 'controls-unavailable'}
          onClick={() => void controller.readLabel()}
        >
          <span className="btn__label">Read label</span>
        </button>
        <button
          type="button"
          className={`btn btn--toggle${torchOn ? ' is-active' : ''}`}
          aria-pressed={torchOn}
          disabled={!torchUsable}
          aria-describedby={torchUsable ? undefined : 'torch-hint'}
          onClick={() => void controller.setTorch(!torchOn)}
        >
          <span className="btn__label">Torch</span>
          <span className="btn__state" id="torch-hint" aria-hidden="true">
            {!torchUsable
              ? state.camera.status === 'active'
                ? 'Torch not available on this camera'
                : 'Needs the camera on'
              : torchOn
                ? 'On — tap to turn off'
                : 'Off — light for reading labels'}
          </span>
        </button>
        <button
          type="button"
          className="btn"
          disabled={!ready}
          aria-describedby={ready ? cameraHint : 'controls-unavailable'}
          onClick={() => void controller.lookAgain()}
        >
          <span className="btn__label">Look again</span>
        </button>
        <button
          type="button"
          className="btn"
          disabled={!ready}
          aria-describedby={ready ? undefined : 'controls-unavailable'}
          onClick={() => controller.repeat()}
        >
          <span className="btn__label">Repeat</span>
        </button>
        <button
          type="button"
          className={`btn btn--toggle${cameraPaused ? ' is-active' : ''}`}
          disabled={!ready && !cameraPaused}
          aria-describedby="camera-hint"
          data-testid="camera-pause"
          onClick={() => void controller.setCameraPaused(!cameraPaused)}
        >
          <span className="btn__label">{cameraPaused ? 'Resume camera' : 'Pause camera'}</span>
          <span className="btn__state" id="camera-hint" aria-hidden="true">
            {cameraPaused ? 'Camera off — Sightline can still hear you' : 'Turn the camera off; keep talking'}
          </span>
        </button>
        <button
          type="button"
          className="btn"
          disabled={!canSwitch}
          aria-describedby={canSwitch ? undefined : 'switch-hint'}
          onClick={() => void controller.switchCamera()}
        >
          <span className="btn__label">Switch camera</span>
          {!canSwitch && (
            <span className="btn__state" id="switch-hint" aria-hidden="true">
              {cameraPaused ? 'Camera paused' : state.camera.status === 'active' ? 'Only one camera found' : 'Camera is not on'}
            </span>
          )}
        </button>
        <button type="button" className="btn btn--end control-grid__wide" onClick={() => controller.end()}>
          <span className="btn__mark" aria-hidden="true" />
          <span className="btn__label">End session</span>
        </button>
      </div>
    </section>
  );
}
