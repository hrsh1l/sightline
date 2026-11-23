import type { LabelEvidence, TextSection } from '../../shared/protocol.js';
import {
  DATE_LABEL_TEXT,
  ISSUE_TEXT,
  READABILITY_TEXT,
  SECTION_ORDER,
  SECTION_TEXT,
  comparisonText,
  dateInterpretationText,
} from './labels.js';

function groupBySection(exact: LabelEvidence['exactText']): Array<{ section: TextSection; texts: string[] }> {
  const map = new Map<TextSection, string[]>();
  for (const item of exact) {
    const list = map.get(item.section) ?? [];
    list.push(item.text);
    map.set(item.section, list);
  }
  return SECTION_ORDER.filter((s) => map.has(s)).map((section) => ({ section, texts: map.get(section) ?? [] }));
}

/**
 * The latest label reading. Verbatim text and Sightline's interpretation are kept in clearly separate
 * sections so a user can tell what was printed from what was inferred.
 */
export function EvidencePanel({ evidence }: { evidence: LabelEvidence }) {
  const groups = groupBySection(evidence.exactText);
  const time = new Date(evidence.capturedAt).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });

  return (
    <section className="evidence" aria-labelledby="evidence-heading" data-testid="evidence">
      <h2 id="evidence-heading" className="section-heading">
        Label reading
      </h2>
      <p className="evidence__meta">
        Photo taken at {time}. Readability: <strong>{READABILITY_TEXT[evidence.readability]}</strong>
        {evidence.issues.length > 0 && <> ({evidence.issues.map((i) => ISSUE_TEXT[i]).join(', ')})</>}.
      </p>
      {evidence.suggestion && (
        <p className="evidence__suggestion">
          <strong>Suggestion:</strong> {evidence.suggestion}
        </p>
      )}

      <section className="evidence__block evidence__block--exact" aria-labelledby="exact-heading" data-testid="evidence-exact">
        <h3 id="exact-heading">Exact text read from the label</h3>
        {groups.length === 0 && evidence.instructions.length === 0 && <p>No text could be read.</p>}
        {groups.map((g) => (
          <div key={g.section} className="evidence__group">
            <h4>{SECTION_TEXT[g.section]}</h4>
            {g.texts.map((t, i) => (
              <p key={i} className="verbatim">
                {t}
              </p>
            ))}
          </div>
        ))}
        {evidence.instructions.map((ins, i) => (
          <div key={`ins-${i}`} className="evidence__group">
            <h4>Instructions: {ins.method || 'Method not stated'}</h4>
            <ol className="verbatim-list">
              {ins.steps.map((s, j) => (
                <li key={j} className="verbatim">
                  {s}
                </li>
              ))}
            </ol>
          </div>
        ))}
      </section>

      {evidence.dates.length > 0 && (
        <section className="evidence__block" aria-labelledby="dates-heading" data-testid="evidence-dates">
          <h3 id="dates-heading">Dates</h3>
          <ul className="evidence__dates">
            {evidence.dates.map((d, i) => (
              <li key={i}>
                <p>
                  <span className="field-name">Printed:</span> <span className="verbatim">{d.printedText}</span>
                </p>
                <p>
                  <span className="field-name">Type:</span> {DATE_LABEL_TEXT[d.labelType]}
                </p>
                <p>
                  <span className="field-name">Interpretation:</span> {dateInterpretationText(d)}
                </p>
                <p>{comparisonText(d.interpretation.comparison)}</p>
              </li>
            ))}
          </ul>
        </section>
      )}

      {evidence.batchCodes.length > 0 && (
        <section className="evidence__block" aria-labelledby="batch-heading" data-testid="evidence-batch">
          <h3 id="batch-heading">Batch/lot codes (not dates)</h3>
          <ul>
            {evidence.batchCodes.map((c, i) => (
              <li key={i} className="verbatim">
                {c}
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="evidence__block evidence__block--interp" aria-labelledby="interp-heading" data-testid="evidence-interpretation">
        <h3 id="interp-heading">Interpretation</h3>
        <p>
          {evidence.itemGuess ? (
            <>
              Probably: <strong>{evidence.itemGuess}</strong>. This is a guess, not printed text.
            </>
          ) : (
            'No guess about what this item is.'
          )}
        </p>
      </section>
    </section>
  );
}
