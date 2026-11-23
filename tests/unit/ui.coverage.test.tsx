// @vitest-environment jsdom
/**
 * Verification-gap UI tests (FIXTURE controller from src/client/ui/__fixtures__; no AI, no media).
 * Camera/mic denial and disconnected-camera messaging, fallback banner, missing-credentials honesty.
 */
import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { App } from '../../src/client/App.js';
import type { AssistantState } from '../../src/client/contracts.js';
import { FakeController, liveState, makeState } from '../../src/client/ui/__fixtures__/fakeController.js';
import { MISSING_CREDENTIALS_TEXT } from '../../src/client/ui/labels.js';

afterEach(cleanup);

const render$ = (state: AssistantState) => {
  const controller = new FakeController(state);
  render(<App controller={controller} />);
  return controller;
};

describe('camera and microphone states in the UI', () => {
  it('disconnected camera: status text, preview placeholder, voice controls stay usable', () => {
    const base = liveState();
    render$({ ...base, camera: { ...base.camera, status: 'disconnected', message: 'The camera stopped unexpectedly.' } });
    expect(screen.getByTestId('status-camera').textContent).toMatch(/Camera:\s*Disconnected/);
    expect(screen.getByText('Camera off')).toBeTruthy();
    expect((screen.getByRole('button', { name: /Mute microphone/ }) as HTMLButtonElement).disabled).toBe(false);
    expect((screen.getByRole('button', { name: /Switch camera/ }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText('Camera is not on')).toBeTruthy();
  });

  it('microphone denied: banner explains how to allow it and offers settings; status says Denied', () => {
    const base = liveState();
    render$({
      ...base,
      mic: { ...base.mic, status: 'denied', message: 'Microphone permission was denied.' },
      error: { code: 'microphone', message: 'Microphone permission was denied. You can still type questions.', recoverable: true, action: 'open_settings' },
    });
    const banner = screen.getByTestId('error-banner');
    expect(within(banner).getByText(/set Microphone to Allow/)).toBeTruthy();
    expect(within(banner).getByRole('button', { name: 'Open settings' })).toBeTruthy();
    expect(screen.getByTestId('status-mic').textContent).toMatch(/Denied/);
    expect((screen.getByRole('button', { name: /Mute microphone/ }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('camera in use by another app: concrete help', () => {
    const base = liveState();
    render$({
      ...base,
      camera: { ...base.camera, status: 'in_use', message: 'In use.' },
      error: { code: 'camera', message: 'Camera unavailable. In use.', recoverable: true, action: 'retry' },
    });
    expect(screen.getByText('Another app is using the camera. Close it, then try again.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy();
  });
});

describe('fallback and configuration honesty', () => {
  it('fallback to snapshot mode shows the banner and the provider message together', () => {
    render$(
      liveState({
        connection: 'snapshot',
        mode: 'snapshot',
        error: { code: 'model_unavailable', message: 'The configured Gemini Live model is not available. Switched to snapshot mode.', recoverable: true, action: 'none' },
      }),
    );
    expect(screen.getByTestId('snapshot-banner').textContent).toMatch(/Snapshot mode/);
    expect(screen.getByTestId('error-banner').textContent).toMatch(/Switched to snapshot mode/);
    expect(screen.getByTestId('status-connection').textContent).toMatch(/Snapshot mode/);
  });

  it('missing credentials after Start: back on the Start screen with the setup message and a disabled Start button', () => {
    render$(
      makeState({
        connection: 'error',
        server: { configured: false, liveModel: null, visionModel: null, detector: false, sessionId: 's', timeZone: 'Europe/London' },
        error: { code: 'missing_credentials', message: 'No key.', recoverable: false, action: 'none' },
      }),
    );
    expect(screen.getByTestId('config-message').textContent).toContain(MISSING_CREDENTIALS_TEXT);
    const start = screen.getByRole('button', { name: 'Start assistant' }) as HTMLButtonElement;
    expect(start.disabled).toBe(true);
    expect(start.getAttribute('aria-describedby')).toBe('config-detail');
    expect(screen.queryByRole('button', { name: /End session/ })).toBeNull();
    expect(screen.queryByTestId('transcript')).toBeNull();
  });
});
