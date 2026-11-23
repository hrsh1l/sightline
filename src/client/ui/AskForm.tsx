import { useId, useState, type FormEvent } from 'react';
import { LIMITS } from '../../shared/protocol.js';
import type { AssistantController, AssistantState } from '../contracts.js';
import { isSessionReady } from './Controls.js';

/** Typed question. Works in both modes; in snapshot mode it is the main way to ask. */
export function AskForm({ state, controller }: { state: AssistantState; controller: AssistantController }) {
  const [text, setText] = useState('');
  const inputId = useId();
  const hintId = useId();
  const ready = isSessionReady(state);
  const snapshot = state.mode === 'snapshot';

  const onSubmit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const q = text.trim();
    if (!q || !ready) return;
    void controller.sendText(q);
    setText('');
  };

  return (
    <section className="ask" aria-labelledby="ask-heading">
      <h2 id="ask-heading" className="section-heading">
        Type a question
      </h2>
      <form className="ask-form" onSubmit={onSubmit}>
        <label htmlFor={inputId} className="ask-form__label">
          Question
        </label>
        <p id={hintId} className="hint">
          {snapshot
            ? 'A fresh photo is taken with each question.'
            : 'Sightline answers out loud using what the camera sees now.'}
          {!ready && ' Available once connected.'}
        </p>
        <div className="ask-form__row">
          <input
            id={inputId}
            className="text-input"
            type="text"
            inputMode="text"
            enterKeyHint="send"
            autoComplete="off"
            maxLength={LIMITS.maxTextChars}
            aria-describedby={hintId}
            value={text}
            onChange={(e) => setText(e.target.value)}
          />
          <button type="submit" className="btn btn--primary ask-form__submit" disabled={!ready} aria-describedby={hintId}>
            Ask
          </button>
        </div>
      </form>
    </section>
  );
}
