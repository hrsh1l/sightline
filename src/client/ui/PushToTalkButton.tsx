import { useRef, type KeyboardEvent, type PointerEvent } from 'react';

/**
 * Momentary "Hold to talk" control. Pointer (touch/mouse/pen) and keyboard (Space/Enter) both work.
 * Release is reported on pointerup, pointercancel, pointerleave, keyup and blur so the mic is never
 * left open by accident.
 */
export function PushToTalkButton({
  talking,
  disabled,
  onTalk,
  describedBy,
}: {
  talking: boolean;
  disabled?: boolean;
  onTalk: (down: boolean) => void;
  describedBy?: string;
}) {
  const down = useRef(false);

  const press = () => {
    if (down.current) return;
    down.current = true;
    onTalk(true);
  };
  const release = () => {
    if (!down.current) return;
    down.current = false;
    onTalk(false);
  };

  const onPointerDown = (e: PointerEvent<HTMLButtonElement>) => {
    if (e.button !== undefined && e.button > 0) return; // primary button / touch only
    try {
      // Keep receiving events if the finger drifts slightly off the button.
      e.currentTarget.setPointerCapture?.(e.pointerId);
    } catch {
      /* capture is best-effort */
    }
    press();
  };

  const isTalkKey = (e: KeyboardEvent) => e.key === ' ' || e.key === 'Enter' || e.key === 'Spacebar';

  return (
    <button
      type="button"
      className={`btn btn--talk${talking ? ' is-active' : ''}`}
      aria-pressed={talking}
      aria-describedby={describedBy}
      disabled={disabled}
      onPointerDown={onPointerDown}
      onPointerUp={release}
      onPointerCancel={release}
      onPointerLeave={release}
      onBlur={release}
      onContextMenu={(e) => e.preventDefault()}
      onKeyDown={(e) => {
        if (!isTalkKey(e)) return;
        e.preventDefault();
        if (!e.repeat) press();
      }}
      onKeyUp={(e) => {
        if (!isTalkKey(e)) return;
        e.preventDefault();
        release();
      }}
    >
      <span className="btn__label">Hold to talk</span>
      <span className="btn__state" aria-hidden="true">
        {talking ? 'Listening — release to send' : 'Press and hold, then speak'}
      </span>
    </button>
  );
}
