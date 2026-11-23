import type { AssistantController, TranscriptEntry } from '../contracts.js';
import { ROLE_TEXT, sourceText } from './labels.js';

/**
 * Conversation history. Deliberately NOT a live region: answers are already spoken, and announcing
 * every streamed fragment would flood the screen reader. Users can review it at their own pace.
 */
export function Transcript({ entries, controller }: { entries: TranscriptEntry[]; controller: AssistantController }) {
  return (
    <section className="transcript" aria-labelledby="transcript-heading">
      <div className="section-header">
        <h2 id="transcript-heading" className="section-heading">
          Transcript
        </h2>
        <button
          type="button"
          className="btn btn--small"
          disabled={entries.length === 0}
          onClick={() => controller.clearTranscript()}
        >
          Clear transcript
        </button>
      </div>
      {entries.length === 0 ? (
        <p className="hint">Nothing yet. Questions and answers appear here.</p>
      ) : (
        <ol className="transcript__list">
          {entries.map((e) => {
            const source = sourceText(e);
            return (
              <li key={e.id} className={`transcript__entry transcript__entry--${e.role}`}>
                <span className="transcript__role">
                  {ROLE_TEXT[e.role]}
                  {source && <span className="transcript__source"> ({source})</span>}:
                </span>{' '}
                <span className="transcript__text">{e.text}</span>
                {!e.final && <span className="transcript__pending"> (transcribing…)</span>}
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}
