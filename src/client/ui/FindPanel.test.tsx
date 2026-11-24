// @vitest-environment jsdom
/**
 * "Find an object" panel: supported-object selector, status per FindState, candidate choice, guidance options,
 * microphone policy and the stereo check. FIXTURE controller only (no AI, no media, no audio).
 */
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { App } from '../App.js';
import type { FindState } from '../../shared/protocol.js';
import { FIND_TARGETS } from '../../shared/findTargets.js';
import type { AssistantState, CalibrationState } from '../contracts.js';
import { FakeController, liveState, makeCandidates, makeFind, makeState } from './__fixtures__/fakeController.js';
import { CALIBRATION_MIC_ADVICE, SAMSUNG_360_NOTE } from './findText.js';

afterEach(cleanup);

/** Accessible description from aria-describedby (the only description mechanism these controls use). */
function computeAccessibleDescription(el: Element): string {
  return (el.getAttribute('aria-describedby') ?? '')
    .split(/\s+/)
    .filter(Boolean)
    .map((id) => document.getElementById(id)?.textContent?.trim() ?? '')
    .join(' ')
    .trim();
}

function setup(state: AssistantState = liveState()) {
  const controller = new FakeController(state);
  const utils = render(<App controller={controller} />);
  return { controller, ...utils };
}

const region = () => screen.getByRole('region', { name: 'Find an object' });
const inFind = () => within(region());
const statusText = () => screen.getByTestId('find-status-text').textContent;
const withSettings = (patch: Partial<AssistantState['settings']>, more: Partial<AssistantState> = {}) =>
  liveState({ settings: { ...makeState().settings, ...patch }, ...more });
const withCalibration = (c: Partial<CalibrationState>, more: Partial<AssistantState> = {}) =>
  liveState({ calibration: { step: 'idle', heardSeparation: null, micActive: false, ...c }, ...more });

describe('Find an object: explanation and supported objects', () => {
  it('explains the camera-view sounds, the rear camera and headphones', () => {
    setup();
    expect(inFind().getByText('Sounds indicate where the object is in your phone’s camera view. Move the phone toward the sound.')).toBeTruthy();
    expect(inFind().getByText('Works with the rear camera. Headphones or earbuds recommended.')).toBeTruthy();
  });

  it('offers one button per supported object, each calling find with its noun', () => {
    const { controller } = setup();
    const group = inFind().getByRole('group', { name: 'What should I find?' });
    const buttons = within(group).getAllByRole('button');
    expect(buttons.map((b) => b.textContent)).toEqual(['Cup or mug', 'Bottle', 'Bowl', 'Apple', 'Banana']);
    for (const t of FIND_TARGETS) {
      fireEvent.click(within(group).getByRole('button', { name: t.label }));
      expect(controller.find).toHaveBeenLastCalledWith(t.noun);
    }
    expect(controller.find.mock.calls.map((c) => c[0])).toEqual(['cup', 'bottle', 'bowl', 'apple', 'banana']);
  });

  it('has no free-text field and states the honest limit', () => {
    setup();
    expect(inFind().queryByRole('textbox')).toBeNull();
    expect(inFind().queryByRole('searchbox')).toBeNull();
    expect(region().querySelector('input[type="text"], input[type="search"], textarea')).toBeNull();
    const group = inFind().getByRole('group', { name: 'What should I find?' });
    expect(computeAccessibleDescription(group)).toBe('Only these for now. You can still ask me about anything else.');
  });

  it('calls find synchronously inside the click (audio unlock needs the gesture)', () => {
    const { controller } = setup();
    let microtaskRan = false;
    let ranBeforeMicrotask: boolean | null = null;
    controller.find.mockImplementation(async () => {
      ranBeforeMicrotask = !microtaskRan;
    });
    queueMicrotask(() => {
      microtaskRan = true;
    });
    fireEvent.click(inFind().getByRole('button', { name: 'Cup or mug' }));
    expect(ranBeforeMicrotask).toBe(true);
  });

  it('every button in the Find panel has a non-empty accessible name', () => {
    setup(withSettings({ findMicPolicy: 'release' }, { find: makeFind({ state: 'needs_selection', query: 'cup', candidates: makeCandidates() }) }));
    for (const b of inFind().getAllByRole('button')) expect((b.textContent ?? '').trim()).not.toBe('');
  });
});

describe('Find status line', () => {
  const expected: Record<FindState, { text: string; stop: boolean; find?: Parameters<typeof makeFind>[0] }> = {
    searching: { text: 'Looking for a bottle…', stop: true },
    needs_selection: { text: 'I see 3 cups. Choose one:', stop: true, find: { query: 'cup', candidates: makeCandidates() } },
    tracking: { text: 'Bottle: left of the picture', stop: true },
    centered: { text: 'Bottle centred in the camera', stop: true },
    lost: { text: 'Lost the bottle — move the camera back slowly', stop: true },
    not_found: { text: 'No bottle in view yet — move the camera slowly across the area', stop: true },
    stopped: { text: 'Stopped finding the bottle', stop: false },
    timeout: { text: 'Stopped finding the bottle after 90 seconds', stop: false },
    unsupported: { text: 'I can only find cups or mugs, bottles, bowls, apples and bananas.', stop: false, find: { query: 'keys' } },
    error: {
      text: 'The object detector is not available. You can still ask me questions.',
      stop: false,
      find: { lastPrompt: { kind: 'error', text: 'The object detector is not available. You can still ask me questions.' } },
    },
  };

  it.each(Object.keys(expected) as FindState[])('state %s: text, a distinct shape, no live region, Stop only while running', (state) => {
    const e = expected[state];
    setup(liveState({ find: makeFind({ state, ...e.find }) }));
    expect(statusText()).toBe(e.text);
    const status = screen.getByTestId('find-status');
    expect(status.querySelector(`svg[aria-hidden="true"][data-state="${state}"]`)?.childElementCount).toBeGreaterThan(0);
    expect(status.closest('[aria-live]')).toBeNull();
    expect(status.querySelector('[aria-live], [role="status"], [role="alert"]')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Stop guidance' }) !== null).toBe(e.stop);
    expect(status.textContent).not.toMatch(/\b(metres?|meters?|feet|steps?|walk|ahead|behind)\b/i);
  });

  it('uses the supported noun for spoken-style queries ("Find a mug" -> cup, "an apple")', () => {
    const { controller } = setup(liveState({ find: makeFind({ state: 'searching', query: 'Find a mug' }) }));
    expect(statusText()).toBe('Looking for a cup…');
    act(() => controller.setState({ find: makeFind({ state: 'searching', query: 'apple' }) }));
    expect(statusText()).toBe('Looking for an apple…');
  });

  it('tracking falls back to a position computed from the box when there is no description', () => {
    setup(
      liveState({
        find: makeFind({ state: 'tracking', description: null, target: { label: 'bottle', score: 0.9, box: { x: 0.7, y: 0.7, w: 0.2, h: 0.2 } } }),
      }),
    );
    expect(statusText()).toBe('Bottle: right of the picture, near the bottom');
  });

  it('error without a prompt has an honest fallback', () => {
    setup(liveState({ find: makeFind({ state: 'error', lastPrompt: null }) }));
    expect(statusText()).toBe('Find is not available right now. You can still ask me questions.');
  });

  it('shows the last spoken prompt as text (not repeated in the error state)', () => {
    const { controller } = setup(liveState({ find: makeFind({ state: 'tracking', lastPrompt: { kind: 'tilt_up', text: 'Tilt the phone up slightly.' } }) }));
    expect(screen.getByTestId('find-last-prompt').textContent).toBe('Last prompt: Tilt the phone up slightly.');
    act(() => controller.setState({ find: makeFind({ state: 'error', lastPrompt: { kind: 'error', text: 'Detector failed.' } }) }));
    expect(statusText()).toBe('Detector failed.');
    expect(screen.queryByTestId('find-last-prompt')).toBeNull();
  });

  it('has no status when find is null', () => {
    setup();
    expect(screen.queryByTestId('find-status')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Stop guidance' })).toBeNull();
  });

  it('Stop guidance calls stopFind and focus moves to the status text when the state changes', () => {
    const { controller } = setup(liveState({ find: makeFind({ state: 'tracking' }) }));
    fireEvent.click(screen.getByRole('button', { name: 'Stop guidance' }));
    expect(controller.stopFind).toHaveBeenCalledTimes(1);
    act(() => controller.setState({ find: makeFind({ state: 'stopped' }) }));
    expect(document.activeElement).toBe(screen.getByTestId('find-status-text'));
    expect(screen.queryByRole('button', { name: 'Stop guidance' })).toBeNull();
  });
});

describe('Choosing between several objects (needs_selection)', () => {
  it('lists candidate buttons by position; the score is in the description, not the name', () => {
    const { controller } = setup(liveState({ find: makeFind({ state: 'needs_selection', query: 'cup', target: null, candidates: makeCandidates() }) }));
    const group = screen.getByRole('group', { name: 'I see 3 cups. Choose one:' });
    const buttons = within(group).getAllByRole('button');
    expect(buttons.map((b) => computeAccessibleDescription(b))).toEqual([
      'Detector confidence 90%',
      'Detector confidence 80%',
      'Detector confidence 70%',
    ]);
    expect(within(group).getByRole('button', { name: 'Left cup' })).toBe(buttons[0]);
    expect(within(group).getByRole('button', { name: 'Middle cup' })).toBe(buttons[1]);
    expect(within(group).getByRole('button', { name: 'Right cup' })).toBe(buttons[2]);
    fireEvent.click(within(group).getByRole('button', { name: 'Right cup' }));
    expect(controller.selectTarget).toHaveBeenCalledWith(12);
    fireEvent.click(within(group).getByRole('button', { name: 'Left cup' }));
    expect(controller.selectTarget).toHaveBeenLastCalledWith(10);
  });

  it('two candidates: "I see 2 cups" with Left cup / Right cup; focus moves to the status after choosing', () => {
    const { controller } = setup(
      liveState({ find: makeFind({ state: 'needs_selection', query: 'mug', target: null, candidates: makeCandidates(['left', 'right']) }) }),
    );
    expect(statusText()).toBe('I see 2 cups. Choose one:');
    expect(screen.queryByRole('button', { name: 'Middle cup' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Left cup' }));
    act(() => controller.setState({ find: makeFind({ state: 'tracking', query: 'mug', description: 'left of the picture' }) }));
    expect(statusText()).toBe('Cup: left of the picture');
    expect(document.activeElement).toBe(screen.getByTestId('find-status-text'));
    expect(screen.queryByTestId('find-candidates')).toBeNull();
  });

  it('numbers candidates that share a position so names stay unique', () => {
    setup(liveState({ find: makeFind({ state: 'needs_selection', query: 'bottle', candidates: makeCandidates(['left', 'left', 'right']) }) }));
    const names = within(screen.getByTestId('find-candidates'))
      .getAllByRole('button')
      .map((b) => b.querySelector('.btn__label')?.textContent);
    expect(names).toEqual(['Left bottle 1', 'Left bottle 2', 'Right bottle']);
  });
});

describe('Guidance options', () => {
  it('cue volume is a labelled 0–100 % range that sends a 0..1 fraction, with the value as text', () => {
    const { controller } = setup(withSettings({ cueVolume: 0.7 }));
    const slider = inFind().getByRole('slider', { name: 'Cue volume' }) as HTMLInputElement;
    expect(slider.type).toBe('range');
    expect(slider.min).toBe('0');
    expect(slider.max).toBe('100');
    expect(slider.value).toBe('70');
    expect(slider.getAttribute('aria-valuetext')).toBe('70%');
    expect(screen.getByTestId('cue-volume-value').textContent).toBe('70%');
    fireEvent.change(slider, { target: { value: '40' } });
    expect(controller.updateSettings).toHaveBeenLastCalledWith({ cueVolume: 0.4 });
    fireEvent.change(slider, { target: { value: '0' } });
    expect(controller.updateSettings).toHaveBeenLastCalledWith({ cueVolume: 0 });
    act(() => controller.setState({ settings: { ...controller.getState().settings, cueVolume: 0.25 } }));
    expect(screen.getByTestId('cue-volume-value').textContent).toBe('25%');
  });

  it('guidance mode radio group: Stereo beeps / Spoken directions', () => {
    const { controller } = setup();
    const group = inFind().getByRole('group', { name: 'Guidance mode' });
    const stereo = within(group).getByRole('radio', { name: 'Stereo beeps' }) as HTMLInputElement;
    const spoken = within(group).getByRole('radio', { name: 'Spoken directions' }) as HTMLInputElement;
    expect(stereo.checked).toBe(true);
    expect(spoken.checked).toBe(false);
    fireEvent.click(spoken);
    expect(controller.updateSettings).toHaveBeenLastCalledWith({ guidanceMode: 'spoken' });
  });

  it('says when the stereo beacon is switched off in Settings', () => {
    setup(withSettings({ spatialAudio: false }));
    const stereo = inFind().getByRole('radio', { name: 'Stereo beeps' });
    expect(computeAccessibleDescription(stereo)).toContain('off in Settings');
  });

  it('microphone policy radio group: keep / release', () => {
    const { controller } = setup();
    const group = inFind().getByRole('group', { name: 'Microphone during Find' });
    const keep = within(group).getByRole('radio', {
      name: 'Keep microphone on (voice commands work; Bluetooth earbuds may switch to mono)',
    }) as HTMLInputElement;
    expect(keep.checked).toBe(true);
    fireEvent.click(within(group).getByRole('radio', { name: 'Release microphone for stereo (hold Talk to speak)' }));
    expect(controller.updateSettings).toHaveBeenLastCalledWith({ findMicPolicy: 'release' });
  });
});

describe('Hold to talk while the microphone is released', () => {
  const talk = () => inFind().queryByRole('button', { name: 'Hold to talk' });

  it('appears only when the policy is release and guidance is running', () => {
    const { controller } = setup(withSettings({ findMicPolicy: 'keep' }, { find: makeFind({ state: 'tracking' }) }));
    expect(talk()).toBeNull();
    act(() => controller.setState({ settings: { ...controller.getState().settings, findMicPolicy: 'release' } }));
    expect(talk()).not.toBeNull();
    act(() => controller.setState({ find: makeFind({ state: 'stopped' }) }));
    expect(talk()).toBeNull();
    act(() => controller.setState({ find: null }));
    expect(talk()).toBeNull();
  });

  it('pointer and keyboard drive setTalking, with an explanation', () => {
    const { controller } = setup(withSettings({ findMicPolicy: 'release' }, { find: makeFind({ state: 'searching' }) }));
    const btn = talk()!;
    expect(computeAccessibleDescription(btn)).toContain('microphone is released');
    fireEvent.pointerDown(btn, { pointerId: 1, button: 0 });
    expect(controller.setTalking).toHaveBeenLastCalledWith(true);
    fireEvent.pointerUp(btn, { pointerId: 1 });
    expect(controller.setTalking).toHaveBeenLastCalledWith(false);
    fireEvent.keyDown(btn, { key: ' ' });
    expect(controller.setTalking).toHaveBeenLastCalledWith(true);
    fireEvent.keyUp(btn, { key: ' ' });
    expect(controller.setTalking).toHaveBeenLastCalledWith(false);
    expect(controller.setTalking).toHaveBeenCalledTimes(4);
  });

  it('is not duplicated when push-to-talk already shows Hold to talk in Controls', () => {
    setup(withSettings({ findMicPolicy: 'release', pushToTalk: true }, { find: makeFind({ state: 'tracking' }) }));
    expect(screen.getAllByRole('button', { name: 'Hold to talk' })).toHaveLength(1);
    expect(talk()).toBeNull();
  });
});

describe('Stereo check (calibration)', () => {
  const startBtn = () => screen.queryByRole('button', { name: 'Check stereo (calibrate)' });
  const check = () => within(screen.getByRole('group', { name: 'Stereo check' }));

  it('idle: shows the Samsung 360 Audio note and a start button that calls startCalibration synchronously', () => {
    const { controller } = setup();
    expect(check().getByText(SAMSUNG_360_NOTE)).toBeTruthy();
    let microtaskRan = false;
    let ranBeforeMicrotask: boolean | null = null;
    controller.startCalibration.mockImplementation(async () => {
      ranBeforeMicrotask = !microtaskRan;
    });
    queueMicrotask(() => {
      microtaskRan = true;
    });
    fireEvent.click(startBtn()!);
    expect(controller.startCalibration).toHaveBeenCalledTimes(1);
    expect(ranBeforeMicrotask).toBe(true);
    expect(screen.queryByTestId('calibration-step')).toBeNull();
    expect(screen.queryByTestId('calibration-mic')).toBeNull();
  });

  it.each([
    ['left', 'Playing a tone in your LEFT ear…'],
    ['right', 'Playing a tone in your RIGHT ear…'],
    ['centre', 'Playing a tone in both ears (centre)…'],
  ] as const)('step %s shows its text, hides Start and offers Cancel', (step, text) => {
    const { controller } = setup(withCalibration({ step }));
    expect(screen.getByTestId('calibration-step').textContent).toBe(text);
    expect(screen.getByTestId('calibration-step').querySelector(`svg[aria-hidden="true"][data-step="${step}"]`)).not.toBeNull();
    expect(startBtn()).toBeNull();
    fireEvent.click(check().getByRole('button', { name: 'Cancel' }));
    expect(controller.cancelCalibration).toHaveBeenCalledTimes(1);
  });

  it('confirm: asks the question with Yes / No answers', () => {
    const { controller } = setup(withCalibration({ step: 'confirm' }));
    expect(screen.getByTestId('calibration-question').textContent).toBe(
      'Did you hear the first tone on the left, the second on the right, and the third in the middle?',
    );
    const answers = screen.getByRole('group', {
      name: 'Did you hear the first tone on the left, the second on the right, and the third in the middle?',
    });
    fireEvent.click(within(answers).getByRole('button', { name: 'Yes, I heard left, right, centre' }));
    expect(controller.answerCalibration).toHaveBeenLastCalledWith(true);
    const no = within(answers).getByRole('button', { name: 'No / only one side / no difference' });
    expect(computeAccessibleDescription(no)).toBe('Answering No turns on Spoken directions.');
    fireEvent.click(no);
    expect(controller.answerCalibration).toHaveBeenLastCalledWith(false);
    fireEvent.click(check().getByRole('button', { name: 'Cancel' }));
    expect(controller.cancelCalibration).toHaveBeenCalledTimes(1);
  });

  it('done, not heard: says Spoken directions is now on; Check stereo is offered again', () => {
    setup(withCalibration({ step: 'done', heardSeparation: false }, { settings: { ...makeState().settings, guidanceMode: 'spoken' } }));
    expect(screen.getByTestId('calibration-result').textContent).toContain('Spoken directions is now on');
    expect(startBtn()).not.toBeNull();
    expect(check().queryByRole('button', { name: 'Cancel' })).toBeNull();
  });

  it('done, heard: confirms stereo works', () => {
    setup(withCalibration({ step: 'done', heardSeparation: true }));
    expect(screen.getByTestId('calibration-result').textContent).toContain('Stereo works');
  });

  it('shows whether the microphone was on, with release advice when it was', () => {
    const { controller } = setup(withCalibration({ step: 'left', micActive: true }));
    expect(screen.getByTestId('calibration-mic').textContent).toBe(`The microphone was on during this check. ${CALIBRATION_MIC_ADVICE}`);
    expect(CALIBRATION_MIC_ADVICE).toContain('Release microphone for stereo');
    act(() => controller.setState({ calibration: { step: 'done', heardSeparation: true, micActive: false } }));
    expect(screen.getByTestId('calibration-mic').textContent).toBe('The microphone was off during this check.');
  });

  it('moves focus through the flow: step text, question, result; back to Start after Cancel', () => {
    const { controller } = setup();
    const set = (c: Partial<CalibrationState>) =>
      act(() => controller.setState({ calibration: { step: 'idle', heardSeparation: null, micActive: false, ...c } }));
    startBtn()!.focus();
    set({ step: 'left' });
    expect(document.activeElement).toBe(screen.getByTestId('calibration-step'));
    set({ step: 'right' });
    set({ step: 'centre' });
    expect(document.activeElement).toBe(screen.getByTestId('calibration-step'));
    set({ step: 'confirm' });
    expect(document.activeElement).toBe(screen.getByTestId('calibration-question'));
    set({ step: 'done', heardSeparation: true });
    expect(document.activeElement).toBe(screen.getByTestId('calibration-result'));
    set({ step: 'left' });
    set({ step: 'idle' });
    expect(document.activeElement).toBe(startBtn());
  });

  it('does not pull focus away from elsewhere in the app', () => {
    const { controller } = setup();
    const ask = screen.getByRole('button', { name: 'Read label' });
    ask.focus();
    act(() => controller.setState({ calibration: { step: 'confirm', heardSeparation: null, micActive: false } }));
    expect(document.activeElement).toBe(ask);
  });
});
