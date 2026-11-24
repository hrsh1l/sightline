import { useEffect, useId, useRef, type ChangeEvent, type RefObject } from 'react';
import type { FindState } from '../../shared/protocol.js';
import { FIND_TARGETS } from '../../shared/findTargets.js';
import type { AssistantController, AssistantState, FindStatus } from '../contracts.js';
import { isSessionReady } from './Controls.js';
import {
  FIND_INTRO,
  FIND_INTRO_DETAIL,
  FIND_ONLY_THESE,
  candidateDescription,
  candidateNames,
  findStatusText,
  isFindRunning,
} from './findText.js';
import { RadioGroup } from './FormControls.js';
import { PushToTalkButton } from './PushToTalkButton.js';
import { StereoCheck } from './StereoCheck.js';

/**
 * Decorative shape per find state so the state is never shown by colour alone (the text is primary):
 * searching = magnifier, needs_selection = three dots (choices), tracking = frame with an off-centre dot,
 * centered = crosshair on a filled centre, lost = dashed ring, not_found = cross, stopped/timeout = square,
 * unsupported = circle with a slash, error = triangle with "!".
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
      {state === 'needs_selection' && (
        <>
          <circle cx="4.5" cy="12" r="3" fill="currentColor" />
          <circle cx="12" cy="12" r="3" fill="none" stroke="currentColor" strokeWidth="2" />
          <circle cx="19.5" cy="12" r="3" fill="currentColor" />
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
      {state === 'not_found' && <path d="M5 5 L19 19 M19 5 L5 19" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />}
      {(state === 'stopped' || state === 'timeout') && <rect x="5" y="5" width="14" height="14" fill="currentColor" />}
      {state === 'unsupported' && (
        <>
          <circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" strokeWidth="2.5" />
          <path d="M5.6 18.4 L18.4 5.6" stroke="currentColor" strokeWidth="2.5" />
        </>
      )}
      {state === 'error' && (
        <>
          <path d="M12 2 L22.5 21 H1.5 Z" fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" />
          <path d="M12 9 V14.5" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" />
          <circle cx="12" cy="17.75" r="1.4" fill="currentColor" />
        </>
      )}
    </svg>
  );
}

/** Status line, candidate choices, last prompt, Stop guidance and (mic released) Hold to talk. Not a live region. */
function FindStatusBlock({
  find,
  state,
  controller,
  statusRef,
  onFocusAfter,
}: {
  find: FindStatus;
  state: AssistantState;
  controller: AssistantController;
  statusRef: RefObject<HTMLParagraphElement | null>;
  onFocusAfter: () => void;
}) {
  const statusTextId = useId();
  const talkHintId = useId();
  const running = isFindRunning(find);
  const candidates = find.state === 'needs_selection' ? (find.candidates ?? []) : [];
  const names = candidateNames({ ...find, candidates });
  const prompt = find.state !== 'error' ? find.lastPrompt?.text.trim() : '';
  // Released mic: offer Hold to talk here, unless Controls already shows one (push-to-talk in Live).
  const controlsShowTalk = state.settings.pushToTalk && state.mode === 'live';
  const showTalk = running && state.settings.findMicPolicy === 'release' && state.mode === 'live' && !controlsShowTalk;

  return (
    <div className={`find-status find-status--${find.state}`} data-testid="find-status">
      <p className="find-status__text" id={statusTextId} ref={statusRef} tabIndex={-1} data-testid="find-status-text">
        <FindIcon state={find.state} />
        <span>{findStatusText(find)}</span>
      </p>

      {candidates.length > 0 && (
        <div className="find-candidates" role="group" aria-labelledby={statusTextId} data-testid="find-candidates">
          {candidates.map((c, i) => {
            const descId = `${statusTextId}-c${c.id}`;
            return (
              <button
                key={c.id}
                type="button"
                className="btn btn--candidate"
                aria-describedby={descId}
                onClick={() => {
                  onFocusAfter();
                  controller.selectTarget(c.id);
                }}
              >
                <span className="btn__label">{names[i]}</span>
                <span className="btn__state" id={descId} aria-hidden="true">
                  {candidateDescription(c)}
                </span>
              </button>
            );
          })}
        </div>
      )}

      {prompt && (
        <p className="find-status__prompt" data-testid="find-last-prompt">
          <span className="field-name">Last prompt:</span> {prompt}
        </p>
      )}

      {running && (
        <button
          type="button"
          className="btn btn--find-stop"
          onClick={() => {
            onFocusAfter();
            controller.stopFind();
          }}
        >
          <span className="btn__mark" aria-hidden="true" />
          <span className="btn__label">Stop guidance</span>
        </button>
      )}

      {showTalk && (
        <div className="find-talk">
          <PushToTalkButton
            talking={state.talking}
            disabled={!isSessionReady(state)}
            describedBy={talkHintId}
            onTalk={(down) => controller.setTalking(down)}
          />
          <p className="hint" id={talkHintId}>
            The microphone is released so earbuds can play stereo. Hold the button while you speak.
          </p>
        </div>
      )}
    </div>
  );
}

/** Cue volume, guidance mode and microphone policy during Find. */
function GuidanceOptions({ state, controller }: { state: AssistantState; controller: AssistantController }) {
  const s = state.settings;
  const volumeId = useId();
  const volumeHintId = useId();
  const volume = Math.round(Math.min(1, Math.max(0, s.cueVolume)) * 100);
  const onVolume = (e: ChangeEvent<HTMLInputElement>) => {
    const v = Number(e.target.value);
    if (Number.isFinite(v)) controller.updateSettings({ cueVolume: Math.min(100, Math.max(0, v)) / 100 });
  };
  return (
    <div className="find-options">
      <h3 className="find__subheading">Guidance</h3>
      <div className="range-setting">
        <div className="range-setting__row">
          <label htmlFor={volumeId} className="range-setting__label">
            Cue volume
          </label>
          <span className="range-setting__value" aria-hidden="true" data-testid="cue-volume-value">
            {volume}%
          </span>
        </div>
        <input
          id={volumeId}
          className="range-input"
          type="range"
          min={0}
          max={100}
          step={5}
          value={volume}
          aria-valuetext={`${volume}%`}
          aria-describedby={volumeHintId}
          onChange={onVolume}
        />
        <p className="hint" id={volumeHintId}>
          Beeps and event sounds. The phone’s media volume also applies.
        </p>
      </div>
      <RadioGroup
        legend="Guidance mode"
        name="findGuidanceMode"
        value={s.guidanceMode}
        onChange={(v) => controller.updateSettings({ guidanceMode: v })}
        options={[
          {
            value: 'stereo',
            label: 'Stereo beeps',
            hint: s.spatialAudio
              ? 'A beep in your left or right ear; faster beeps mean nearer the centre of the camera view.'
              : 'The stereo beacon is off in Settings, so no beeps will play.',
          },
          { value: 'spoken', label: 'Spoken directions', hint: 'Sightline says left, right, up or down instead of beeping.' },
        ]}
      />
      <RadioGroup
        legend="Microphone during Find"
        name="findMicPolicy"
        value={s.findMicPolicy}
        onChange={(v) => controller.updateSettings({ findMicPolicy: v })}
        options={[
          { value: 'keep', label: 'Keep microphone on (voice commands work; Bluetooth earbuds may switch to mono)' },
          { value: 'release', label: 'Release microphone for stereo (hold Talk to speak)' },
        ]}
      />
    </div>
  );
}

/** "Find an object": supported-object buttons -> controller.find(noun); status, choices and Stop guidance. */
export function FindPanel({ state, controller }: { state: AssistantState; controller: AssistantController }) {
  const ready = isSessionReady(state);
  const find = state.find;
  const chooseId = useId();
  const onlyId = useId();

  // When the control the user pressed disappears (a candidate, Stop guidance), move focus to the status text
  // (or the heading if the status is gone) so a screen-reader user is not dropped at the top of the page.
  const headingRef = useRef<HTMLHeadingElement>(null);
  const statusRef = useRef<HTMLParagraphElement>(null);
  const focusPending = useRef(false);
  const findState = find?.state ?? null;
  useEffect(() => {
    if (!focusPending.current) return;
    focusPending.current = false;
    (statusRef.current ?? headingRef.current)?.focus();
  }, [findState]);

  return (
    <section className="find" aria-labelledby="find-heading">
      <h2 id="find-heading" className="section-heading" ref={headingRef} tabIndex={-1}>
        Find an object
      </h2>
      <p className="find__intro">{FIND_INTRO}</p>
      <p className="hint">{FIND_INTRO_DETAIL}</p>

      {find && (
        <FindStatusBlock
          find={find}
          state={state}
          controller={controller}
          statusRef={statusRef}
          onFocusAfter={() => {
            focusPending.current = true;
          }}
        />
      )}

      <div className="find-choose" role="group" aria-labelledby={chooseId} aria-describedby={onlyId}>
        <h3 id={chooseId} className="find__subheading">
          What should I find?
        </h3>
        <div className="find-targets">
          {FIND_TARGETS.map((t) => (
            <button
              key={t.coco}
              type="button"
              className="btn btn--target"
              disabled={!ready}
              // Synchronous inside the user gesture: the controller unlocks the cue audio here.
              onClick={() => void controller.find(t.noun)}
            >
              <span className="btn__label">{t.label}</span>
            </button>
          ))}
        </div>
        <p id={onlyId} className="hint">
          {FIND_ONLY_THESE}
          {!ready && ' Available once connected.'}
        </p>
      </div>

      <GuidanceOptions state={state} controller={controller} />
      <StereoCheck state={state} controller={controller} />
    </section>
  );
}
