import { useId, type ReactNode } from 'react';

/** Native checkbox with a visible label and optional hint (aria-describedby). */
export function Checkbox({
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

/** Native radio group in a fieldset/legend, so the group name is announced with each option. */
export function RadioGroup<T extends string>({
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
