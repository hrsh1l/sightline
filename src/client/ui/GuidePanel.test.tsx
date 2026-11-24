// @vitest-environment jsdom
/**
 * "Instructions" guide panel: idle entry, every phase, current step, Read vs Confirmed done, step controls,
 * section choice, source text and the lost-guide banner. FIXTURE controller only (no AI, no media, no audio).
 */
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { App } from '../App.js';
import { IDLE_GUIDE, type GuidePhase, type GuideSnapshot } from '../../shared/guide.js';
import type { AssistantState } from '../contracts.js';
import { FakeController, liveState, makeGuide, makeState } from './__fixtures__/fakeController.js';
import { GUIDE_INTRO, GUIDE_LOST_BANNER } from './guideText.js';

afterEach(cleanup);

function setup(state: AssistantState = liveState()) {
  const controller = new FakeController(state);
  const utils = render(<App controller={controller} />);
  return { controller, ...utils };
}
const withGuide = (guide: Partial<GuideSnapshot> = {}, more: Partial<AssistantState> = {}) => liveState({ guide: makeGuide(guide), ...more });
const region = () => screen.getByRole('region', { name: 'Instructions' });
const inGuide = () => within(region());
const statusText = () => screen.getByTestId('guide-status-text').textContent;
const button = (name: string | RegExp) => inGuide().getByRole('button', { name });
const isUnavailable = (el: HTMLElement) => el.getAttribute('aria-disabled') === 'true' || (el as HTMLButtonElement).disabled;
const description = (el: Element) =>
  (el.getAttribute('aria-describedby') ?? '')
    .split(/\s+/)
    .filter(Boolean)
    .map((id) => document.getElementById(id)?.textContent?.trim() ?? '')
    .join(' ')
    .trim();

describe('Instructions panel: idle entry', () => {
  it('sits before Find and offers the entry button with the camera explanation', () => {
    const { controller } = setup();
    const headings = screen.getAllByRole('heading', { level: 2 }).map((h) => h.textContent);
    expect(headings.indexOf('Instructions')).toBeLessThan(headings.indexOf('Find an object'));
    expect(inGuide().getByText(GUIDE_INTRO)).toBeTruthy();
    fireEvent.click(button('Guide me through instructions'));
    expect(controller.guideInspect).toHaveBeenLastCalledWith('instructions');
    expect(inGuide().queryByRole('button', { name: /Check this view/ })).toBeNull();
  });

  it('"What instructions?" field sends the typed goal', () => {
    const { controller } = setup();
    const input = inGuide().getByRole('textbox', { name: 'What instructions?' });
    fireEvent.change(input, { target: { value: 'storage instructions' } });
    fireEvent.click(button('Guide me'));
    expect(controller.guideInspect).toHaveBeenLastCalledWith('storage instructions');
    expect((input as HTMLInputElement).value).toBe('');
  });

  it('is disabled before connecting, with a reason', () => {
    setup(makeState({ connection: 'connecting' }));
    const start = button('Guide me through instructions') as HTMLButtonElement;
    expect(start.disabled).toBe(true);
    expect(description(start)).toContain('Available once connected.');
  });
});

describe('Instructions panel: phases', () => {
  const cases: Array<[GuidePhase, Partial<GuideSnapshot>, string]> = [
    ['acquiring_image', { steps: [], currentIndex: null, title: null, section: null }, 'Checking the view…'],
    ['needs_better_view', { steps: [], currentIndex: null, adjustment: 'Move the phone slightly back.' }, 'The view needs adjusting.'],
    ['choosing_section', { steps: [], currentIndex: null, sectionChoices: [{ id: 'm', title: 'Microwave', stepCount: 4, complete: true }] }, 'Several methods are visible. Choose one.'],
    ['preparing_guide', { steps: [], currentIndex: null }, 'Preparing the steps…'],
    ['guiding', {}, 'Guiding — step 2 of 4.'],
    ['paused', {}, 'Paused. Tap Resume to continue.'],
    ['completed', {}, "You've confirmed all 4 steps."],
    ['error', { message: 'Could not read the instructions.' }, 'Could not read the instructions.'],
  ];
  it.each(cases)('%s: status text', (phase, over, text) => {
    setup(withGuide({ phase, ...over }));
    expect(statusText()).toBe(text);
    // Not a live region: the Announcer stays the only one.
    expect(region().querySelector('[aria-live]')).toBeNull();
    // Check this view is always offered while a guide is active.
    expect(button(/^Check this view/)).toBeTruthy();
  });

  it('needs_better_view shows the adjustment prominently', () => {
    setup(
      withGuide({
        phase: 'needs_better_view',
        steps: [],
        currentIndex: null,
        message: 'The bottom of the instructions is outside the frame.',
        adjustment: 'Move the phone slightly back.',
      }),
    );
    expect(screen.getByTestId('guide-adjustment').textContent).toBe('The bottom of the instructions is outside the frame. Move the phone slightly back.');
  });

  it('Check this view calls guideInspect with no goal (keeps the remembered one)', () => {
    const { controller } = setup(withGuide({ phase: 'needs_better_view', steps: [], currentIndex: null }));
    fireEvent.click(button(/^Check this view/));
    expect(controller.guideInspect).toHaveBeenCalledWith();
  });

  it('choosing_section: one button per method, calling choose_section with its id', () => {
    const { controller } = setup(
      withGuide({
        phase: 'choosing_section',
        steps: [],
        currentIndex: null,
        sectionChoices: [
          { id: 'microwave', title: 'Microwave', stepCount: 4, complete: true },
          { id: 'oven', title: 'Oven', stepCount: 1, complete: false },
        ],
      }),
    );
    const group = screen.getByTestId('guide-choices');
    expect(within(group).getAllByRole('button').map((b) => b.querySelector('.btn__label')?.textContent)).toEqual(['Microwave (4 steps)', 'Oven (1 step)']);
    expect(description(within(group).getByRole('button', { name: /Oven/ }))).toBe('Partly readable');
    fireEvent.click(within(group).getByRole('button', { name: /Oven/ }));
    expect(controller.guideAction).toHaveBeenLastCalledWith('choose_section', { sectionId: 'oven' });
  });

  it('partial instructions say what is missing next to Check this view', () => {
    setup(withGuide({ partial: true, missing: ['Text below step 3 is cut off at the bottom of the photo.'] }));
    expect(screen.getByTestId('guide-partial').textContent).toContain(
      'Only part of the instructions was readable: Text below step 3 is cut off at the bottom of the photo.',
    );
  });
});

describe('Instructions panel: the current step', () => {
  it('shows title, method, Step X of Y, the spoken text, quantities and warnings', () => {
    setup(withGuide());
    expect(screen.getByTestId('guide-doc').textContent).toContain('Tomato Soup');
    expect(screen.getByTestId('guide-doc').textContent).toContain('MICROWAVE (800W)');
    expect(screen.getByTestId('guide-step-pos').textContent).toBe('Step 2 of 4');
    expect(screen.getByTestId('guide-step-text').textContent).toBe('Heat on full power, 800W, for 3 minutes.');
    expect(screen.getByTestId('guide-quantities').textContent).toBe('Quantities: 800W, 3 minutes');
    expect(screen.getByTestId('guide-step-warnings').textContent).toContain('Caution: contents will be hot.');
    expect(screen.getByTestId('guide-progress').textContent).toContain('1 of 4 steps confirmed done.');
  });

  it('distinguishes Read (presented) from Confirmed done, with text', () => {
    const { controller } = setup(withGuide());
    const chip = within(screen.getByTestId('guide-step')).getByTestId('guide-chip');
    expect(chip.textContent).toBe('Read');
    expect(chip.querySelector('svg')).toBeTruthy();
    act(() => {
      controller.setState({
        guide: makeGuide({
          version: 6,
          steps: makeGuide().steps.map((s) => (s.n === 2 ? { ...s, confirmed: true } : s)),
          confirmations: ['microwave-s1', 'microwave-s2'],
        }),
      });
    });
    expect(within(screen.getByTestId('guide-step')).getByTestId('guide-chip').textContent).toBe('Confirmed done');
  });
});

describe('Instructions panel: controls', () => {
  it('each control sends its action', () => {
    const { controller } = setup(withGuide());
    const pairs: Array<[string | RegExp, string]> = [
      ["Done — I've finished step 2", 'confirm'],
      ['Previous', 'previous'],
      ['Next', 'next'],
      ['Repeat', 'repeat'],
      ['Explain', 'explain'],
      ['Undo last done', 'undo'],
      ['Pause', 'pause'],
      ['Where were we?', 'status'],
      ['Stop guide', 'stop'],
    ];
    for (const [name, action] of pairs) {
      fireEvent.click(button(name));
      expect(controller.guideAction).toHaveBeenLastCalledWith(action);
    }
    expect(controller.guideAction).toHaveBeenCalledTimes(pairs.length);
  });

  it('paused: Resume replaces Pause; step navigation waits for Resume', () => {
    const { controller } = setup(withGuide({ phase: 'paused' }));
    expect(inGuide().queryByRole('button', { name: 'Pause' })).toBeNull();
    fireEvent.click(button('Resume'));
    expect(controller.guideAction).toHaveBeenLastCalledWith('resume');
    const next = button('Next');
    expect(isUnavailable(next)).toBe(true);
    expect(description(next)).toBe('Paused — tap Resume first');
    fireEvent.click(next);
    expect(controller.guideAction).toHaveBeenCalledTimes(1);
  });

  it('Done rules: enabled for an unconfirmed current step; unavailable once done, at completion, or offline', () => {
    const { controller } = setup(withGuide());
    const done = screen.getByTestId('guide-done');
    expect(isUnavailable(done)).toBe(false);
    expect(done.getAttribute('aria-label')).toBe("Done — I've finished step 2");
    act(() => {
      controller.setState({ guide: makeGuide({ currentIndex: 0, version: 6 }) }); // step 1 already confirmed
    });
    expect(isUnavailable(screen.getByTestId('guide-done'))).toBe(true);
    expect(description(screen.getByTestId('guide-done'))).toBe('Step 1 is already done');
    fireEvent.click(screen.getByTestId('guide-done'));
    expect(controller.guideAction).not.toHaveBeenCalled();
    act(() => {
      controller.setState({ guide: makeGuide({ phase: 'completed', currentIndex: 3, version: 7 }) });
    });
    expect(description(screen.getByTestId('guide-done'))).toBe('All steps are done');
    act(() => {
      controller.setState({ guide: makeGuide({ version: 8 }), connection: 'reconnecting' });
    });
    expect(description(screen.getByTestId('guide-done'))).toBe('Available once connected');
  });

  it('Previous is unavailable at step 1 and Next at the last step, with reasons', () => {
    const { controller } = setup(withGuide({ currentIndex: 0 }));
    expect(description(button('Previous'))).toBe('Already at step 1');
    expect(isUnavailable(button('Next'))).toBe(false);
    act(() => {
      controller.setState({ guide: makeGuide({ currentIndex: 3, version: 6 }) });
    });
    expect(description(button('Next'))).toBe('This is the last step');
    expect(isUnavailable(button('Previous'))).toBe(false);
  });

  it('Undo last done appears only when there is a confirmation', () => {
    setup(withGuide({ confirmations: [], steps: makeGuide().steps.map((s) => ({ ...s, confirmed: false })) }));
    expect(inGuide().queryByRole('button', { name: 'Undo last done' })).toBeNull();
  });
});

describe('Instructions panel: source text and lost guide', () => {
  it('shows each step’s verbatim source text in order with its status, warnings and capture time', () => {
    setup(withGuide({ warnings: ['Caution: contents will be hot.'] }));
    const details = screen.getByTestId('guide-source');
    expect(details.tagName).toBe('DETAILS');
    expect(within(details).getByText('Show source text').tagName).toBe('SUMMARY');
    const items = within(details).getAllByRole('listitem').filter((li) => li.classList.contains('guide-source__step'));
    expect(items.map((li) => li.querySelector('.verbatim')?.textContent)).toEqual([
      'Pierce film lid several times.',
      'Heat on full power (800W) for 3 minutes.',
      'Stir and re-cover.',
      'Stand for 1 minute before serving.',
    ]);
    expect(items.map((li) => within(li).getByTestId('guide-chip').textContent)).toEqual(['Confirmed done', 'Read', 'Not read yet', 'Not read yet']);
    expect(items[1]!.textContent).toContain('(current)');
    expect(within(details).getByText('Warnings printed with these instructions')).toBeTruthy();
    expect(screen.getByTestId('guide-source-frames').textContent).toMatch(/^From a photo taken at /);
  });

  it('guideLost: honest banner with Start again', () => {
    const { controller } = setup(liveState({ guideLost: true, guide: { ...IDLE_GUIDE, goal: 'cooking instructions' } }));
    expect(screen.getByTestId('guide-lost').textContent).toContain(GUIDE_LOST_BANNER);
    fireEvent.click(button('Start again'));
    expect(controller.guideInspect).toHaveBeenLastCalledWith('cooking instructions');
  });

  it('moves focus to the status text when the pressed control disappears', () => {
    const { controller } = setup(
      withGuide({ phase: 'choosing_section', steps: [], currentIndex: null, sectionChoices: [{ id: 'm', title: 'Microwave', stepCount: 4, complete: true }] }),
    );
    fireEvent.click(button(/Microwave/));
    act(() => {
      controller.setState({ guide: makeGuide({ version: 9, phase: 'preparing_guide', steps: [], currentIndex: null }) });
    });
    expect(document.activeElement).toBe(screen.getByTestId('guide-status-text'));
  });
});
