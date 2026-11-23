import type { AssistantState } from '../contracts.js';

const DASH = '—';
const ms = (v: number | null) => (v === null || !Number.isFinite(v) ? DASH : `${Math.round(v)} ms`);
const txt = (v: string | null | undefined) => (v ? v : DASH);

/** Developer diagnostics. Plain definition list; values are text so they can be read and copied. */
function detectionsText(state: AssistantState, now: number): string {
  const d = state.detections;
  if (!d) return DASH;
  const age = Math.max(0, now - d.detectedAt);
  return `${d.source ?? 'yolo'} · ${d.detections.length} · ${ms(age)} old`;
}

function findText(state: AssistantState): string {
  const f = state.find;
  if (!f) return DASH;
  return `${f.state} “${f.query}” (${f.source})`;
}

export function Diagnostics({ state, now = Date.now() }: { state: AssistantState; now?: number }) {
  const m = state.metrics;
  const ec = state.mic.echoCancellation;
  const rows: Array<[string, string]> = [
    ['Provider', 'Google Gemini'],
    ['Live model', txt(state.server?.liveModel)],
    ['Vision model', txt(state.server?.visionModel)],
    ['Session id', txt(state.server?.sessionId)],
    ['Frame age at question', ms(m.frameAgeAtQuestionMs)],
    ['Question to first text', ms(m.questionToFirstTextMs)],
    ['Question to first audio', ms(m.questionToFirstAudioMs)],
    ['Frames sent', String(m.framesSent)],
    ['Frames dropped', String(m.framesDropped)],
    ['Reconnects', String(m.reconnects)],
    ['Mic echo cancellation (reported)', ec === null ? DASH : ec ? 'On' : 'Off'],
    [
      'Camera resolution',
      state.camera.videoWidth > 0 && state.camera.videoHeight > 0 ? `${state.camera.videoWidth}×${state.camera.videoHeight}` : DASH,
    ],
    ['Camera device', txt(state.camera.deviceLabel)],
    ['Camera still capture', state.camera.stillCapture ? 'Yes' : 'No'],
    ['Torch', state.camera.torch.supported ? (state.camera.torch.on ? 'Supported, on' : 'Supported, off') : 'Not supported'],
    ['Detections', detectionsText(state, now)],
    ['Find', findText(state)],
    ['Audio output', state.player.contextState],
  ];
  return (
    <section className="diagnostics" aria-labelledby="diagnostics-heading" data-testid="diagnostics">
      <h3 id="diagnostics-heading">Diagnostics</h3>
      <dl className="diagnostics__list">
        {rows.map(([k, v]) => (
          <div key={k} className="diagnostics__row">
            <dt>{k}</dt>
            <dd>{v}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}
