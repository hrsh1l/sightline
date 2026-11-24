import type { AssistantState } from '../contracts.js';

const DASH = '—';
const ms = (v: number | null | undefined) => (v === null || v === undefined || !Number.isFinite(v) ? DASH : `${Math.round(v)} ms`);
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

const rate = (v: number | null | undefined) => (v === null || v === undefined || !Number.isFinite(v) ? DASH : `${v.toFixed(1)} /s`);

function observationAge(state: AssistantState, now: number): string {
  const at = state.find?.observedAt;
  if (at === null || at === undefined) return DASH;
  return ms(Math.max(0, now - at));
}

function calibrationText(state: AssistantState): string {
  const c = state.calibration;
  if (!c) return DASH;
  const heard = c.heardSeparation === null ? 'not answered' : c.heardSeparation ? 'heard stereo' : 'no stereo';
  return `${c.step} · ${heard} · mic ${c.micActive ? 'on' : 'off'}`;
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
    ['Detection age', ms(m.detectionAgeMs)],
    ['Detection rate', rate(m.detectionRate)],
    ['Find state', findText(state)],
    ['Find track id', state.find?.trackId === null || state.find?.trackId === undefined ? DASH : String(state.find.trackId)],
    ['Find observation age', observationAge(state, now)],
    ['Guidance', `${state.settings.guidanceMode} · mic ${state.settings.findMicPolicy} · volume ${Math.round(state.settings.cueVolume * 100)}%`],
    ['Stereo check', calibrationText(state)],
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
