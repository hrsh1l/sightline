// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { App } from './App.js';
import type { FindState } from '../shared/protocol.js';
import type { AppError, AssistantState, ConnectionStatus } from './contracts.js';
import { FakeController, liveState, makeDetections, makeEvidence, makeFind, makeState } from './ui/__fixtures__/fakeController.js';

afterEach(cleanup);

function setup(state: AssistantState = makeState()) {
  const controller = new FakeController(state);
  const utils = render(<App controller={controller} />);
  return { controller, ...utils };
}

const button = (name: string | RegExp) => screen.getByRole('button', { name });

describe('Start screen', () => {
  it('has one h1, a main landmark, purpose and privacy text', () => {
    setup();
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
    expect(screen.getByRole('main')).toBeTruthy();
    expect(screen.getByText(/selected camera frames and your microphone audio are sent to the configured AI provider \(Google Gemini\)/)).toBeTruthy();
    expect(screen.getByText(/Nothing is saved by Sightline after you end the session\./)).toBeTruthy();
  });

  it('calls controller.start synchronously inside the click, before any microtask runs', () => {
    const { controller } = setup();
    let microtaskRan = false;
    let ranBeforeMicrotask: boolean | null = null;
    controller.start.mockImplementation(async () => {
      ranBeforeMicrotask = !microtaskRan;
    });
    queueMicrotask(() => {
      microtaskRan = true;
    });
    fireEvent.click(button('Start assistant'));
    expect(controller.start).toHaveBeenCalledTimes(1);
    expect(ranBeforeMicrotask).toBe(true);
  });

  it('shows an honest configuration message when the server has no API key', () => {
    const base = makeState();
    setup(makeState({ server: { ...base.server!, configured: false } }));
    expect(screen.getByTestId('config-message').textContent).toContain('The server has no Gemini API key configured');
    const start = button('Start assistant') as HTMLButtonElement;
    expect(start.disabled).toBe(true);
    expect(start.getAttribute('aria-describedby')).toBe('config-detail');
  });

  it('shows the configuration message for a missing_credentials error', () => {
    setup(
      makeState({
        connection: 'error',
        error: { code: 'missing_credentials', message: 'Not configured', recoverable: false, action: 'none' },
      }),
    );
    expect(screen.getByTestId('config-message').textContent).toContain('The server has no Gemini API key configured');
    expect(screen.queryByRole('button', { name: 'End session' })).toBeNull();
  });

  it('returns to the start screen when the session ends and focuses Start', () => {
    const { controller } = setup(liveState());
    act(() => controller.setState({ connection: 'ended' }));
    expect(screen.getByTestId('session-ended')).toBeTruthy();
    expect(document.activeElement).toBe(button('Start assistant'));
  });
});

describe('Session controls', () => {
  it('moves focus to the session heading when the session starts', () => {
    const { controller } = setup();
    act(() => controller.setState({ connection: 'connecting' }));
    expect(document.activeElement?.id).toBe('session-heading');
  });

  it('every primary control has an accessible name and calls the right method', () => {
    const { controller } = setup(liveState({ speaking: true }));
    const cases: Array<[string, () => void]> = [
      ['Stop speaking', () => expect(controller.stopSpeaking).toHaveBeenCalledTimes(1)],
      ['Read label', () => expect(controller.readLabel).toHaveBeenCalledTimes(1)],
      ['Look again', () => expect(controller.lookAgain).toHaveBeenCalledTimes(1)],
      ['Repeat', () => expect(controller.repeat).toHaveBeenCalledTimes(1)],
      ['Switch camera', () => expect(controller.switchCamera).toHaveBeenCalledTimes(1)],
      ['Mute microphone', () => expect(controller.setMuted).toHaveBeenCalledWith(true)],
      ['End session', () => expect(controller.end).toHaveBeenCalledTimes(1)],
    ];
    for (const [name, check] of cases) {
      const b = button(name) as HTMLButtonElement;
      expect(b.tagName).toBe('BUTTON');
      expect(b.disabled).toBe(false);
      fireEvent.click(b);
      check();
    }
  });

  it('all buttons in the session screen have non-empty accessible names', () => {
    setup(liveState({ settings: { ...makeState().settings, pushToTalk: true } }));
    for (const b of screen.getAllByRole('button')) {
      const name = (b.getAttribute('aria-label') ?? b.textContent ?? '').trim();
      expect(name.length).toBeGreaterThan(0);
    }
  });

  it('mute toggle exposes aria-pressed and unmutes when pressed', () => {
    const { controller } = setup(liveState());
    const mute = button('Mute microphone');
    expect(mute.getAttribute('aria-pressed')).toBe('false');
    act(() => controller.setState({ mic: { ...controller.getState().mic, status: 'muted' } }));
    expect(button('Mute microphone').getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByTestId('status-mic').textContent).toContain('Muted');
    fireEvent.click(button('Mute microphone'));
    expect(controller.setMuted).toHaveBeenLastCalledWith(false);
  });

  it('Stop speaking is disabled with an explanation when not speaking', () => {
    setup(liveState({ speaking: false }));
    const stop = button('Stop speaking') as HTMLButtonElement;
    expect(stop.disabled).toBe(true);
    const hint = document.getElementById(stop.getAttribute('aria-describedby') ?? '');
    expect(hint?.textContent).toContain('Available while Sightline is speaking');
  });

  it('Switch camera is disabled with a reason when only one camera exists', () => {
    const s = liveState();
    setup({ ...s, camera: { ...s.camera, canSwitch: false } });
    const sw = button('Switch camera') as HTMLButtonElement;
    expect(sw.disabled).toBe(true);
    expect(document.getElementById(sw.getAttribute('aria-describedby') ?? '')?.textContent).toBe('Only one camera found');
  });

  it('typed question submits via the form and clears the field', () => {
    const { controller } = setup(liveState());
    const input = screen.getByLabelText('Question') as HTMLInputElement;
    fireEvent.change(input, { target: { value: '  What am I holding?  ' } });
    fireEvent.submit(input.closest('form')!);
    expect(controller.sendText).toHaveBeenCalledWith('What am I holding?');
    expect(input.value).toBe('');
    fireEvent.click(button('Ask'));
    expect(controller.sendText).toHaveBeenCalledTimes(1); // empty input is not sent
  });

  it('shows the busy indicator text', () => {
    const { controller } = setup(liveState({ busy: { kind: 'reading_label', since: 1 } }));
    expect(screen.getByTestId('busy').textContent).toBe('Reading label…');
    act(() => controller.setState({ busy: { kind: 'finding', since: 2 } }));
    expect(screen.getByTestId('busy').textContent).toBe('Finding…');
  });

  it('does not put aria-live anywhere except the announcer', () => {
    setup(liveState({ transcript: [{ id: '1', role: 'user', text: 'hi', final: true, source: 'typed', at: 1 }] }));
    const live = Array.from(document.querySelectorAll('[aria-live]')).map((el) => el.getAttribute('data-testid'));
    expect(live.sort()).toEqual(['announcer-assertive', 'announcer-polite']);
    expect(document.querySelectorAll('[role="alert"], [role="status"], [role="log"]')).toHaveLength(0);
  });
});

describe('Torch', () => {
  it('is a toggle with aria-pressed that calls setTorch with the opposite state', () => {
    const { controller } = setup(liveState());
    const torch = button('Torch') as HTMLButtonElement;
    expect(torch.disabled).toBe(false);
    expect(torch.getAttribute('aria-pressed')).toBe('false');
    fireEvent.click(torch);
    expect(controller.setTorch).toHaveBeenLastCalledWith(true);
    act(() => controller.setState({ camera: { ...controller.getState().camera, torch: { supported: true, on: true } } }));
    expect(button('Torch').getAttribute('aria-pressed')).toBe('true');
    expect(button('Torch').textContent).toContain('On — tap to turn off');
    fireEvent.click(button('Torch'));
    expect(controller.setTorch).toHaveBeenLastCalledWith(false);
  });

  it('is disabled with a reason when the camera has no torch', () => {
    const s = liveState();
    const { controller } = setup({ ...s, camera: { ...s.camera, torch: { supported: false, on: false } } });
    const torch = button('Torch') as HTMLButtonElement;
    expect(torch.disabled).toBe(true);
    expect(torch.getAttribute('aria-pressed')).toBe('false');
    expect(document.getElementById(torch.getAttribute('aria-describedby') ?? '')?.textContent).toBe(
      'Torch not available on this camera',
    );
    fireEvent.click(torch);
    expect(controller.setTorch).not.toHaveBeenCalled();
  });
});

describe('Find', () => {
  const findInput = () => screen.getByLabelText('What should I find?') as HTMLInputElement;

  it('submits the trimmed query, clears the field and ignores empty input', () => {
    const { controller } = setup(liveState());
    fireEvent.click(button('Find'));
    fireEvent.change(findInput(), { target: { value: '   ' } });
    fireEvent.submit(findInput().closest('form')!);
    expect(controller.find).not.toHaveBeenCalled();
    fireEvent.change(findInput(), { target: { value: '  the red tin  ' } });
    fireEvent.click(button('Find'));
    expect(controller.find).toHaveBeenCalledTimes(1);
    expect(controller.find).toHaveBeenCalledWith('the red tin');
    expect(findInput().value).toBe('');
  });

  it('explains the aiming beeps in image-relative terms and limits the query length', () => {
    setup(liveState());
    const input = findInput();
    const help = document.getElementById(input.getAttribute('aria-describedby') ?? '')?.textContent ?? '';
    expect(help).toContain('left/right in your ears = left/right in the picture');
    expect(help).toContain('higher pitch = higher in the picture');
    expect(help).toContain('faster = closer to the centre');
    expect(help).toContain('Headphones work best.');
    expect(input.maxLength).toBe(80);
  });

  it('is disabled until connected', () => {
    const { controller } = setup(liveState({ connection: 'connecting' }));
    expect((button('Find') as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(findInput(), { target: { value: 'salt' } });
    fireEvent.submit(findInput().closest('form')!);
    expect(controller.find).not.toHaveBeenCalled();
  });

  it('Stop finding calls stopFind', () => {
    const { controller } = setup(liveState({ find: makeFind({ state: 'searching' }) }));
    fireEvent.click(button('Stop finding'));
    expect(controller.stopFind).toHaveBeenCalledTimes(1);
  });

  const expected: Record<FindState, { text: string; stop: boolean }> = {
    searching: { text: 'Searching for “salt”…', stop: true },
    tracking: { text: '“salt” is left of the picture, near the top', stop: true },
    centered: { text: '“salt” centred in the picture', stop: true },
    lost: { text: 'Lost “salt” — move the camera slowly', stop: true },
    not_found: { text: 'Not found: “salt” — try moving the camera slowly or a different name', stop: true },
    stopped: { text: 'Stopped finding “salt”', stop: false },
    timeout: { text: 'Stopped finding “salt” after 90 seconds', stop: false },
  };

  it.each(Object.keys(expected) as FindState[])('state %s is shown in words with a shape, never distances', (state) => {
    setup(liveState({ find: makeFind({ state }) }));
    const status = screen.getByTestId('find-status');
    expect(status.textContent).toBe(expected[state].text + (expected[state].stop ? 'Stop finding' : ''));
    expect(status.querySelector(`svg[aria-hidden="true"][data-state="${state}"]`)).not.toBeNull();
    expect(status.getAttribute('aria-live')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Stop finding' }) !== null).toBe(expected[state].stop);
    expect(status.textContent).not.toMatch(/\b(metres?|meters?|feet|steps?|walk|ahead|behind)\b/i);
  });

  it('tracking falls back to a position computed from the box when there is no description', () => {
    setup(
      liveState({
        find: makeFind({ state: 'tracking', description: null, target: { label: 'salt', score: 0.9, box: { x: 0.7, y: 0.7, w: 0.2, h: 0.2 } } }),
      }),
    );
    expect(screen.getByTestId('find-status').textContent).toContain('“salt” is right of the picture, near the bottom');
  });

  it('has no find status when find is null', () => {
    setup(liveState());
    expect(screen.queryByTestId('find-status')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Stop finding' })).toBeNull();
  });
});

describe('Push-to-talk', () => {
  const pttState = () => liveState({ settings: { ...makeState().settings, pushToTalk: true } });

  it('is hidden when push-to-talk is off', () => {
    setup(liveState());
    expect(screen.queryByRole('button', { name: 'Hold to talk' })).toBeNull();
  });

  it('pointer down/up/cancel/leave drive setTalking', () => {
    const { controller } = setup(pttState());
    const talk = button('Hold to talk');
    fireEvent.pointerDown(talk, { pointerId: 1, button: 0 });
    expect(controller.setTalking).toHaveBeenLastCalledWith(true);
    fireEvent.pointerUp(talk, { pointerId: 1 });
    expect(controller.setTalking).toHaveBeenLastCalledWith(false);
    fireEvent.pointerDown(talk, { pointerId: 2, button: 0 });
    fireEvent.pointerCancel(talk, { pointerId: 2 });
    expect(controller.setTalking).toHaveBeenLastCalledWith(false);
    fireEvent.pointerDown(talk, { pointerId: 3, button: 0 });
    fireEvent.pointerLeave(talk, { pointerId: 3 });
    expect(controller.setTalking).toHaveBeenLastCalledWith(false);
    expect(controller.setTalking).toHaveBeenCalledTimes(6);
  });

  it('keyboard Space and Enter press and release, ignoring auto-repeat', () => {
    const { controller } = setup(pttState());
    const talk = button('Hold to talk');
    fireEvent.keyDown(talk, { key: ' ' });
    fireEvent.keyDown(talk, { key: ' ', repeat: true });
    expect(controller.setTalking).toHaveBeenCalledTimes(1);
    expect(controller.setTalking).toHaveBeenLastCalledWith(true);
    fireEvent.keyUp(talk, { key: ' ' });
    expect(controller.setTalking).toHaveBeenLastCalledWith(false);
    fireEvent.keyDown(talk, { key: 'Enter' });
    expect(controller.setTalking).toHaveBeenLastCalledWith(true);
    fireEvent.keyUp(talk, { key: 'Enter' });
    expect(controller.setTalking).toHaveBeenLastCalledWith(false);
    expect(controller.setTalking).toHaveBeenCalledTimes(4);
  });

  it('releases on blur and reflects talking with aria-pressed', () => {
    const { controller } = setup(pttState());
    fireEvent.pointerDown(button('Hold to talk'), { pointerId: 1, button: 0 });
    act(() => controller.setState({ talking: true }));
    expect(button('Hold to talk').getAttribute('aria-pressed')).toBe('true');
    fireEvent.blur(button('Hold to talk'));
    expect(controller.setTalking).toHaveBeenLastCalledWith(false);
  });
});

describe('Snapshot mode', () => {
  it('is clearly marked, explains the photo, and can switch back to Live', () => {
    const { controller } = setup(liveState({ connection: 'snapshot', mode: 'snapshot' }));
    expect(screen.getByTestId('snapshot-banner').textContent).toContain(
      'Snapshot mode — answers use a still photo and typed questions',
    );
    expect(screen.getByText('A fresh photo is taken with each question.')).toBeTruthy();
    expect(screen.getByTestId('status-connection').textContent).toContain('Snapshot mode');
    fireEvent.click(button('Switch to Live'));
    expect(controller.setMode).toHaveBeenCalledWith('live');
  });
});

describe('Error banner', () => {
  const withError = (error: AppError, extra: Partial<AssistantState> = {}) => liveState({ error, ...extra });

  it.each([
    ['retry', 'Try again', 'start'],
    ['tap_to_resume', 'Resume', 'resume'],
    ['use_snapshot', 'Use snapshot mode', 'setMode'],
  ] as const)('action %s -> "%s" calls controller.%s', (action, label, method) => {
    const { controller } = setup(withError({ code: 'provider_error', message: 'Provider failed.', recoverable: true, action }));
    const banner = screen.getByTestId('error-banner');
    expect(banner.textContent).toContain('Provider failed.');
    fireEvent.click(within(banner).getByRole('button', { name: label }));
    expect(controller[method]).toHaveBeenCalledTimes(1);
    if (method === 'setMode') expect(controller.setMode).toHaveBeenCalledWith('snapshot');
  });

  it('retry calls start synchronously within the click', () => {
    const { controller } = setup(withError({ code: 'network', message: 'Lost connection.', recoverable: true, action: 'retry' }));
    fireEvent.click(button('Try again'));
    expect(controller.start).toHaveBeenCalledTimes(1);
  });

  it('open_settings opens the settings panel and focuses it', () => {
    setup(withError({ code: 'internal', message: 'Check settings.', recoverable: true, action: 'open_settings' }));
    const details = document.querySelector('details') as HTMLDetailsElement;
    expect(details.open).toBe(false);
    fireEvent.click(button('Open settings'));
    expect(details.open).toBe(true);
    expect(document.activeElement?.tagName).toBe('SUMMARY');
  });

  it('dismiss calls dismissError', () => {
    const { controller } = setup(withError({ code: 'internal', message: 'Oops.', recoverable: true, action: 'none' }));
    fireEvent.click(button('Dismiss'));
    expect(controller.dismissError).toHaveBeenCalledTimes(1);
  });

  it('insecure context error includes concrete connection help', () => {
    setup(
      makeState({
        connection: 'error',
        error: { code: 'insecure_context', message: 'This page is not secure.', recoverable: false, action: 'none' },
      }),
    );
    expect(screen.getByTestId('error-banner').textContent).toContain(
      'Open via http://localhost:3000 with adb reverse, or an https link. See docs/s25-connection.md',
    );
  });

  it('camera permission error explains how to allow access', () => {
    const s = makeState();
    setup(
      makeState({
        connection: 'error',
        camera: { ...s.camera, status: 'denied' },
        error: { code: 'camera', message: 'Camera access was denied.', recoverable: true, action: 'retry' },
      }),
    );
    const banner = screen.getByTestId('error-banner');
    expect(banner.textContent).toContain('set Camera to Allow');
    expect(within(banner).getByRole('button', { name: 'Try again' })).toBeTruthy();
  });
});

describe('Paused overlay', () => {
  it('shows a full-screen Tap to resume button that calls resume and takes focus', () => {
    const { controller } = setup(liveState({ connection: 'paused' }));
    const resume = button('Tap to resume');
    expect(document.activeElement).toBe(resume);
    fireEvent.click(resume);
    expect(controller.resume).toHaveBeenCalledTimes(1);
    expect(document.querySelector('.app')?.hasAttribute('inert')).toBe(true);
  });

  it('disappears when no longer paused', () => {
    const { controller } = setup(liveState({ connection: 'paused' }));
    act(() => controller.setState({ connection: 'live' }));
    expect(screen.queryByRole('button', { name: 'Tap to resume' })).toBeNull();
    expect(document.querySelector('.app')?.hasAttribute('inert')).toBe(false);
  });
});

describe('Status bar', () => {
  const expected: Record<ConnectionStatus, string> = {
    idle: 'Not started',
    connecting: 'Connecting',
    live: 'Live',
    snapshot: 'Snapshot mode',
    reconnecting: 'Reconnecting',
    paused: 'Paused — tap to resume',
    ended: 'Ended',
    error: 'Error',
  };

  it.each(['connecting', 'live', 'snapshot', 'reconnecting', 'paused', 'error'] as const)(
    'connection %s is shown as text with a shape icon',
    (connection) => {
      setup(liveState({ connection }));
      const item = screen.getByTestId('status-connection');
      expect(item.textContent).toContain(expected[connection]);
      expect(item.querySelector('svg[aria-hidden="true"]')).not.toBeNull();
    },
  );

  it.each(['idle', 'ended'] as const)('connection %s shows the start screen with a text state', (connection) => {
    setup(makeState({ connection }));
    expect(button('Start assistant')).toBeTruthy();
    if (connection === 'ended') expect(screen.getByTestId('session-ended').textContent).toContain('Session ended');
  });

  it('shows microphone, camera and speaking status as text', () => {
    const s = liveState({ speaking: true });
    const { controller } = setup(s);
    expect(screen.getByTestId('status-mic').textContent).toContain('On');
    expect(screen.getByTestId('status-camera').textContent).toContain('Rear camera');
    expect(screen.getByTestId('status-speaking').textContent).toContain('Speaking');
    act(() =>
      controller.setState({
        camera: { ...s.camera, facing: 'user' },
        mic: { ...s.mic, status: 'denied' },
        speaking: false,
      }),
    );
    expect(screen.getByTestId('status-camera').textContent).toContain('Front camera');
    expect(screen.getByTestId('status-mic').textContent).toContain('Denied');
    expect(screen.getByTestId('status-speaking').textContent).toContain('Not speaking');
    act(() => controller.setState({ camera: { ...s.camera, status: 'in_use' } }));
    expect(screen.getByTestId('status-camera').textContent).toContain('In use by another app');
  });

  it('paused status is a resume button', () => {
    const { controller } = setup(liveState({ connection: 'paused' }));
    // The overlay makes the rest inert, but the status itself is still a real button.
    const statusBtn = within(screen.getByTestId('status-connection')).getByRole('button', { hidden: true });
    fireEvent.click(statusBtn);
    expect(controller.resume).toHaveBeenCalled();
  });
});

describe('Transcript', () => {
  it('labels roles and sources, marks in-progress entries, and clears on request', () => {
    const { controller } = setup(
      liveState({
        transcript: [
          { id: 'a', role: 'user', text: 'What am I holding?', final: true, source: 'live_transcription', at: 1 },
          { id: 'b', role: 'assistant', text: 'A tin of tomatoes', final: false, source: 'live_transcription', at: 2 },
          { id: 'c', role: 'user', text: 'Read the date', final: true, source: 'typed', at: 3 },
          { id: 'd', role: 'assistant', text: 'Best before March', final: true, source: 'snapshot_answer', at: 4 },
          { id: 'e', role: 'system', text: 'Reconnected', final: true, source: 'system', at: 5 },
        ],
      }),
    );
    const region = screen.getByRole('region', { name: 'Transcript' });
    const items = within(region).getAllByRole('listitem').map((li) => li.textContent);
    expect(items[0]).toBe('You: What am I holding?');
    expect(items[1]).toBe('Sightline: A tin of tomatoes (transcribing…)');
    expect(items[2]).toBe('You (typed): Read the date');
    expect(items[3]).toBe('Sightline (from a still photo): Best before March');
    expect(items[4]).toBe('App: Reconnected');
    expect(region.getAttribute('aria-live')).toBeNull();
    fireEvent.click(within(region).getByRole('button', { name: 'Clear transcript' }));
    expect(controller.clearTranscript).toHaveBeenCalledTimes(1);
  });
});

describe('Camera preview and detections', () => {
  it('registers the video element and unregisters on unmount', () => {
    const { controller, unmount } = setup(liveState());
    const video = document.querySelector('video') as HTMLVideoElement;
    expect(video).not.toBeNull();
    expect(controller.attachVideo).toHaveBeenCalledWith(video);
    expect(video.muted).toBe(true);
    expect(video.hasAttribute('playsinline')).toBe(true);
    expect(video.autoplay).toBe(true);
    unmount();
    expect(controller.attachVideo).toHaveBeenLastCalledWith(null);
  });

  it('keeps the same video mounted when the preview is hidden (collapsed, not display:none)', () => {
    const { controller } = setup(liveState());
    const video = document.querySelector('video');
    act(() => controller.setState({ settings: { ...controller.getState().settings, showPreview: false } }));
    expect(document.querySelector('video')).toBe(video);
    expect(screen.getByTestId('preview').className).toContain('preview--collapsed');
    expect(controller.attachVideo).toHaveBeenCalledTimes(1);
  });

  it('summarises detections as text (image positions only) and clears when null', () => {
    const { controller } = setup(liveState({ detections: makeDetections() }));
    expect(screen.getByTestId('detection-summary').textContent).toBe(
      'Detector sees: bottle (82%), cup (61%) — image positions only',
    );
    act(() => controller.setState({ detections: null }));
    expect(screen.queryByTestId('detection-summary')).toBeNull();
    expect(screen.queryByTestId('detection-overlay')).toBeNull();
  });

  it('summary puts the find target first and leaves it out of the detector list', () => {
    const base = makeDetections();
    setup(
      liveState({
        detections: makeDetections({
          source: 'gemini',
          detections: [...base.detections, { label: 'salt', score: 0.9, box: { x: 0.4, y: 0.4, w: 0.2, h: 0.2 }, target: true }],
        }),
        find: makeFind({ state: 'centered' }),
      }),
    );
    expect(screen.getByTestId('detection-summary').textContent).toBe(
      'Finding salt: centred in the picture. Detector sees: bottle (82%), cup (61%) — image positions only',
    );
  });

  it('summary describes find progress even with no detections', () => {
    const { controller } = setup(liveState({ find: makeFind({ state: 'searching' }) }));
    expect(screen.getByTestId('detection-summary').textContent).toBe('Finding salt: searching');
    act(() => controller.setState({ find: makeFind({ state: 'tracking' }) }));
    expect(screen.getByTestId('detection-summary').textContent).toBe('Finding salt: left of the picture, near the top');
    act(() => controller.setState({ find: makeFind({ state: 'stopped' }) }));
    expect(screen.queryByTestId('detection-summary')).toBeNull();
  });
});

describe('Evidence in the session', () => {
  it('renders the evidence panel when lastEvidence is set', () => {
    setup(liveState({ lastEvidence: makeEvidence() }));
    expect(screen.getByRole('region', { name: 'Exact text read from the label' })).toBeTruthy();
    expect(screen.getByRole('region', { name: 'Batch/lot codes (not dates)' })).toBeTruthy();
  });
});

describe('Settings and diagnostics', () => {
  it('updates settings through the controller', () => {
    const { controller } = setup(liveState());
    fireEvent.click(screen.getByLabelText('Push to talk'));
    expect(controller.updateSettings).toHaveBeenCalledWith({ pushToTalk: true });
    fireEvent.click(screen.getByLabelText('Pause while Sightline speaks'));
    expect(controller.updateSettings).toHaveBeenCalledWith({ micDuringReplies: 'pause' });
    fireEvent.click(screen.getByLabelText('Snapshot'));
    expect(controller.setMode).toHaveBeenCalledWith('snapshot');
    fireEvent.click(screen.getByLabelText('Show camera preview'));
    expect(controller.updateSettings).toHaveBeenCalledWith({ showPreview: false });
  });

  it('disables detections with an explanation when the server has no detector', () => {
    setup(liveState());
    const box = screen.getByLabelText('Show object boxes') as HTMLInputElement;
    expect(box.disabled).toBe(true);
    const hint = document.getElementById(box.getAttribute('aria-describedby') ?? '')?.textContent ?? '';
    expect(hint).toContain('no object detector');
    expect(hint).toContain('Find still shows a green box');
  });

  it('enables object boxes when the server has a detector', () => {
    const s = liveState();
    const { controller } = setup({ ...s, server: { ...s.server!, detector: true } });
    const box = screen.getByLabelText('Show object boxes') as HTMLInputElement;
    expect(box.disabled).toBe(false);
    fireEvent.click(box);
    expect(controller.updateSettings).toHaveBeenCalledWith({ detections: true });
  });

  it('sound and vibration settings are grouped and call updateSettings with the right keys', () => {
    const { controller } = setup(liveState());
    const group = screen.getByRole('group', { name: 'Sound and vibration' });
    const cases: Array<[string, Record<string, boolean>]> = [
      ['Event sounds', { earcons: false }],
      ['Aiming beeps in Find', { spatialAudio: false }],
      ['Vibration', { haptics: false }],
      ['I’m using headphones (3D sound)', { headphones: true }],
    ];
    for (const [label, patch] of cases) {
      fireEvent.click(within(group).getByLabelText(label));
      expect(controller.updateSettings).toHaveBeenLastCalledWith(patch);
    }
    expect(controller.updateSettings).toHaveBeenCalledTimes(4);
  });

  it('diagnostics show still capture, torch, detections and find state', () => {
    const s = liveState();
    setup({
      ...s,
      settings: { ...s.settings, showDiagnostics: true },
      detections: makeDetections({ source: 'gemini' }),
      find: makeFind({ state: 'centered' }),
    });
    const text = screen.getByTestId('diagnostics').textContent ?? '';
    expect(text).toContain('Camera still captureYes');
    expect(text).toContain('TorchSupported, off');
    expect(text).toMatch(/Detectionsgemini · 2 · \d+ ms old/);
    expect(text).toContain('Findcentered “salt” (gemini)');
  });

  it('shows diagnostics with units and dashes for missing values', () => {
    const s = liveState();
    setup({
      ...s,
      settings: { ...s.settings, showDiagnostics: true },
      metrics: { ...s.metrics, questionToFirstAudioMs: 812.4, framesSent: 12 },
    });
    const d = screen.getByTestId('diagnostics');
    const text = d.textContent ?? '';
    expect(text).toContain('Google Gemini');
    expect(text).toContain('fixture-live');
    expect(text).toContain('fixture-session');
    expect(text).toContain('812 ms');
    expect(text).toContain('—');
    expect(text).toContain('1280×720');
    expect(text).toContain('running');
  });
});
