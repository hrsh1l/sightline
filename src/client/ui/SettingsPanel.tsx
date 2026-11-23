import { useId, type ReactNode, type Ref } from 'react';
import type { AssistantController, AssistantSettings, AssistantState } from '../contracts.js';
import { Diagnostics } from './Diagnostics.js';

function Checkbox({
  label,
  checked,
  onChange,
  disabled,
  hint,
}: {
  label: string;
  checked: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
  hint?: ReactNode;
}) {
  const id = useId();
  const hintId = useId();
  return (
    <div className="setting">
      <input
        id={id}
        type="checkbox"
        className="setting__check"
        checked={checked}
        disabled={disabled}
        aria-describedby={hint ? hintId : undefined}
        onChange={(e) => onChange(e.target.checked)}
      />
      <label htmlFor={id} className="setting__label">
        {label}
      </label>
      {hint && (
        <p id={hintId} className="hint setting__hint">
          {hint}
        </p>
      )}
    </div>
  );
}

function RadioGroup<T extends string>({
  legend,
  name,
  value,
  options,
  onChange,
}: {
  legend: string;
  name: string;
  value: T;
  options: Array<{ value: T; label: string; hint?: string }>;
  onChange: (v: T) => void;
}) {
  const base = useId();
  return (
    <fieldset className="setting-group">
      <legend>{legend}</legend>
      {options.map((o) => {
        const id = `${base}-${o.value}`;
        return (
          <div className="setting" key={o.value}>
            <input
              id={id}
              type="radio"
              className="setting__check"
              name={name}
              value={o.value}
              checked={value === o.value}
              aria-describedby={o.hint ? `${id}-hint` : undefined}
              onChange={() => onChange(o.value)}
            />
            <label htmlFor={id} className="setting__label">
              {o.label}
            </label>
            {o.hint && (
              <p id={`${id}-hint`} className="hint setting__hint">
                {o.hint}
              </p>
            )}
          </div>
        );
      })}
    </fieldset>
  );
}

/** Secondary settings in a native <details>, so it is keyboard and screen-reader operable without custom focus traps. */
export function SettingsPanel({
  state,
  controller,
  open,
  onOpenChange,
  summaryRef,
}: {
  state: AssistantState;
  controller: AssistantController;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  summaryRef?: Ref<HTMLElement>;
}) {
  const s = state.settings;
  const set = (patch: Partial<AssistantSettings>) => controller.updateSettings(patch);
  const detectorAvailable = state.server?.detector === true;

  return (
    <section className="settings" aria-labelledby="settings-heading">
      <h2 id="settings-heading" className="visually-hidden">
        Settings
      </h2>
      <details className="settings__details" open={open} onToggle={(e) => onOpenChange(e.currentTarget.open)}>
        <summary ref={summaryRef} className="settings__summary">
          Settings and diagnostics
        </summary>
        <div className="settings__body">
          <RadioGroup
            legend="Mode"
            name="mode"
            value={state.mode}
            onChange={(v) => controller.setMode(v)}
            options={[
              { value: 'live', label: 'Live — talk naturally', hint: 'Continuous conversation with spoken answers.' },
              { value: 'snapshot', label: 'Snapshot', hint: 'Answers use a still photo and typed questions.' },
            ]}
          />
          <Checkbox
            label="Push to talk"
            checked={s.pushToTalk}
            onChange={(v) => set({ pushToTalk: v })}
            hint="Only listen while the Hold to talk button is held."
          />
          <RadioGroup
            legend="Microphone during replies"
            name="micDuringReplies"
            value={s.micDuringReplies}
            onChange={(v) => set({ micDuringReplies: v })}
            options={[
              { value: 'barge_in', label: 'Allow interruptions (barge-in)', hint: 'You can talk over Sightline. Works best with headphones.' },
              { value: 'pause', label: 'Pause while Sightline speaks', hint: 'Avoids Sightline hearing itself through the speaker.' },
            ]}
          />
          <Checkbox
            label="Show object detection boxes"
            checked={s.detections && detectorAvailable}
            disabled={!detectorAvailable}
            onChange={(v) => set({ detections: v })}
            hint={detectorAvailable ? 'Optional detector labels over the preview, image positions only.' : 'Unavailable: no object detector is configured on the server.'}
          />
          <Checkbox label="Show camera preview" checked={s.showPreview} onChange={(v) => set({ showPreview: v })} hint="The camera keeps running either way during a session." />
          <Checkbox
            label="Speak snapshot answers"
            checked={s.speakSnapshotAnswers}
            onChange={(v) => set({ speakSnapshotAnswers: v })}
            hint="Read snapshot-mode answers aloud with the phone’s voice."
          />
          <Checkbox label="Show diagnostics" checked={s.showDiagnostics} onChange={(v) => set({ showDiagnostics: v })} />
          {s.showDiagnostics && <Diagnostics state={state} />}
        </div>
      </details>
    </section>
  );
}
