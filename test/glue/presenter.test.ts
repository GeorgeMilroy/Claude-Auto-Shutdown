import { describe, expect, it } from 'vitest';

import type { UiState } from '../../src/shared/protocol';
import { COMMAND_IDS, CONTEXT_KEYS } from '../../src/ui/ids';
import { escapeMarkdown } from '../../src/ui/markdown';
import { contextKeyValues, statusBarModel } from '../../src/ui/presenter';
import { countdownOf, remainingSeconds, stateForNow } from '../../src/ui/snapshot';
import { check, contract, counting, countdown, snapshot, uiState, watching } from './fixtures';

/** Every link in a Markdown source that would run a command, with its target. */
function commandLinks(markdown: string): string[] {
  return [...markdown.matchAll(/\]\(command:([^)]*)\)/g)].map((match) => match[1] ?? '');
}

const HOSTILE = '[click me](command:workbench.action.terminal.new) **bold** <img src=x> `code` $(flame)';

describe('statusBarModel', () => {
  it('offers Start from the status bar while not watching', () => {
    const model = statusBarModel(snapshot(uiState()), 1_000, true);
    expect(model.text).toContain('Auto Shutdown');
    expect(model.command).toBe('claudeAutoShutdown.start');
    expect(model.background).toBe('none');
    expect(model.visible).toBe(true);
    expect(commandLinks(model.tooltip)).toEqual(['claudeAutoShutdown.start', 'claudeAutoShutdown.open']);
  });

  it('opens the dashboard on click while watching, and links to Stop watching', () => {
    const model = statusBarModel(snapshot(watching({ contract: contract({ testMode: false }) })), 1_000, true);
    expect(model.command).toBe('claudeAutoShutdown.open');
    expect(commandLinks(model.tooltip)).toEqual(['claudeAutoShutdown.stop', 'claudeAutoShutdown.open']);
    expect(model.tooltipCommands).toEqual(['claudeAutoShutdown.stop', 'claudeAutoShutdown.open']);
  });

  it('cancels on click during a real countdown, on an error background', () => {
    const model = statusBarModel(snapshot(counting('real')), 1_000, true);
    expect(model.command).toBe('claudeAutoShutdown.cancelCountdownFromStatusBar');
    expect(model.background).toBe('error');
    expect(model.text).toContain('1:27');
    expect(commandLinks(model.tooltip)).toEqual(['claudeAutoShutdown.cancelCountdown', 'claudeAutoShutdown.open']);
  });

  it('derives the digits from the time since the state arrived, never from a local decrement', () => {
    const shown = snapshot(counting('real'), { receivedAtMono: 1_000 });
    expect(statusBarModel(shown, 11_000, true).text).toContain('1:17');
    expect(statusBarModel(shown, 500_000, true).text).toContain('0:00');
  });

  it('shows a countdown even when the status bar item is switched off', () => {
    expect(statusBarModel(snapshot(counting('real')), 1_000, false).visible).toBe(true);
    expect(statusBarModel(snapshot(counting('preview')), 1_000, false).visible).toBe(true);
    expect(statusBarModel(snapshot(watching()), 1_000, false).visible).toBe(false);
    expect(statusBarModel(snapshot(uiState()), 1_000, false).visible).toBe(false);
  });

  it('says "lost contact" when there is no state, and offers only the dashboard', () => {
    const model = statusBarModel(snapshot(null, { role: 'follower' }), 1_000, true);
    expect(model.text.toLowerCase()).toContain('lost contact');
    expect(model.command).toBe('claudeAutoShutdown.open');
    expect(commandLinks(model.tooltip)).toEqual(['claudeAutoShutdown.open']);
  });

  it('says so when this window is isolated', () => {
    const model = statusBarModel(snapshot(null, { role: 'isolated' }), 1_000, true);
    expect(model.text).toContain("Can't coordinate");
    expect(commandLinks(model.tooltip)).toEqual(['claudeAutoShutdown.open']);
  });

  it('does not offer Start when the controlling window runs another version', () => {
    const model = statusBarModel(snapshot(uiState(), { role: 'follower', limited: true }), 1_000, true);
    expect(model.command).toBe('claudeAutoShutdown.open');
    expect(commandLinks(model.tooltip)).toEqual(['claudeAutoShutdown.open']);
    expect(model.tooltip).toContain('Only Cancel and Stop watching work from this window');
  });

  it('still offers Stop and Cancel when the controlling window runs another version', () => {
    const stop = statusBarModel(snapshot(watching(), { role: 'follower', limited: true }), 1_000, true);
    expect(commandLinks(stop.tooltip)).toContain('claudeAutoShutdown.stop');
    const cancel = statusBarModel(snapshot(counting('real'), { role: 'follower', limited: true }), 1_000, true);
    expect(cancel.command).toBe('claudeAutoShutdown.cancelCountdownFromStatusBar');
  });

  it('escapes a session name: it can neither add a link nor formatting to the tooltip', () => {
    const state = watching({
      checks: [check('quiet', 'waiting', { quietestSeconds: 18, name: HOSTILE, quietSeconds: 300 })],
    });
    const model = statusBarModel(snapshot(state), 1_000, true);
    expect(model.tooltip).toContain(escapeMarkdown(HOSTILE));
    expect(commandLinks(model.tooltip)).toEqual(['claudeAutoShutdown.stop', 'claudeAutoShutdown.open']);
    expect(model.tooltip).not.toMatch(/(^|[^\\])\*\*bold/);
    expect(model.tooltip).not.toMatch(/(^|[^\\])<img/);
    expect(model.tooltip).not.toMatch(/(^|[^\\])`code/);
  });

  it("escapes the other window's name and version", () => {
    const state = uiState({ leader: { ...uiState().leader, app: HOSTILE, ext: '](command:evil)' } });
    const model = statusBarModel(snapshot(state, { role: 'follower', limited: true }), 1_000, true);
    expect(commandLinks(model.tooltip)).toEqual(['claudeAutoShutdown.open']);
  });

  it('only ever links to contributed commands', () => {
    const states = [uiState(), watching(), counting('real'), counting('test'), counting('preview'), uiState({ phase: 'executing' })];
    for (const state of states) {
      const model = statusBarModel(snapshot(state), 1_000, true);
      expect(commandLinks(model.tooltip)).toEqual(model.tooltipCommands);
      for (const id of model.tooltipCommands) expect(COMMAND_IDS).toContain(id);
    }
  });

  it('survives a state from another version that has little more than a phase', () => {
    const bare = { phase: 'watching' } as unknown as UiState;
    const model = statusBarModel(snapshot(bare, { role: 'follower', limited: true }), 1_000, true);
    expect(model.text).not.toBe('');
    expect(commandLinks(model.tooltip)).toContain('claudeAutoShutdown.stop');
  });
});

describe('contextKeyValues', () => {
  it('reads "not watching" only from a state that says so', () => {
    expect(contextKeyValues(snapshot(uiState()))[CONTEXT_KEYS.watching]).toBe(false);
    expect(contextKeyValues(snapshot(watching()))[CONTEXT_KEYS.watching]).toBe(true);
    // No state, or a state without the field: Stop stays reachable, Start is not offered.
    expect(contextKeyValues(snapshot(null, { role: 'follower' }))[CONTEXT_KEYS.watching]).toBe(true);
    expect(contextKeyValues(snapshot(null, { role: 'isolated' }))[CONTEXT_KEYS.watching]).toBe(true);
    expect(contextKeyValues(snapshot({ phase: 'off' } as unknown as UiState))[CONTEXT_KEYS.watching]).toBe(true);
  });

  it('turns the Escape binding on for every kind of countdown and for the final check', () => {
    for (const kind of ['real', 'test', 'preview'] as const) {
      expect(contextKeyValues(snapshot(counting(kind)))[CONTEXT_KEYS.countdownActive]).toBe(true);
    }
    const finalCheck = watching({ phase: 'committing', countdown: null });
    expect(contextKeyValues(snapshot(finalCheck))[CONTEXT_KEYS.countdownActive]).toBe(true);
    expect(contextKeyValues(snapshot(watching()))[CONTEXT_KEYS.countdownActive]).toBe(false);
    expect(contextKeyValues(snapshot(null, { role: 'electing' }))[CONTEXT_KEYS.countdownActive]).toBe(false);
  });

  it('calls a countdown real unless it is known to be a test run or a preview', () => {
    expect(contextKeyValues(snapshot(counting('real')))[CONTEXT_KEYS.realCountdown]).toBe(true);
    expect(contextKeyValues(snapshot(counting('test')))[CONTEXT_KEYS.realCountdown]).toBe(false);
    expect(contextKeyValues(snapshot(counting('preview')))[CONTEXT_KEYS.realCountdown]).toBe(false);
    const unknownKind = counting('real', { countdown: { ...countdown(), kind: 'turbo' as unknown as 'real' } });
    expect(contextKeyValues(snapshot(unknownKind))[CONTEXT_KEYS.realCountdown]).toBe(true);
  });

  it('reports the phase, and says so when there is none', () => {
    expect(contextKeyValues(snapshot(watching({ phase: 'confirming' })))[CONTEXT_KEYS.phase]).toBe('confirming');
    expect(contextKeyValues(snapshot(null, { role: 'follower' }))[CONTEXT_KEYS.phase]).toBe('unknown');
    expect(contextKeyValues(snapshot(null, { role: 'isolated' }))[CONTEXT_KEYS.phase]).toBe('isolated');
  });

  it('marks the test run step done only on an explicit yes', () => {
    expect(contextKeyValues(snapshot(uiState({ testPassedOnce: true })))[CONTEXT_KEYS.testPassed]).toBe(true);
    expect(contextKeyValues(snapshot(uiState()))[CONTEXT_KEYS.testPassed]).toBe(false);
    expect(contextKeyValues(snapshot(null))[CONTEXT_KEYS.testPassed]).toBe(false);
  });
});

describe('countdown readers', () => {
  it('has no countdown without a state', () => {
    expect(countdownOf(null)).toBeNull();
    expect(remainingSeconds(snapshot(null), 5_000)).toBeNull();
  });

  it('never shows more time than was published', () => {
    const shown = snapshot(counting('real'), { receivedAtMono: 10_000 });
    // A clock that reads earlier than the receipt cannot add time.
    expect(remainingSeconds(shown, 5_000)).toBe(87);
    expect(remainingSeconds(shown, 10_000)).toBe(87);
    // Whole seconds, rounded up like every countdown surface: 84.5 s left reads 85.
    expect(remainingSeconds(shown, 12_500)).toBe(85);
  });

  it('has no remaining time when the state does not say, or the clock is not a number', () => {
    const silent = counting('real', { countdown: { ...countdown(), remainingMs: Number.NaN } });
    expect(remainingSeconds(snapshot(silent), 2_000)).toBeNull();
    expect(remainingSeconds(snapshot(counting('real')), Number.NaN)).toBeNull();
  });

  it('takes the time a state has waited in this window off its durations before passing it on', () => {
    const state = counting('real', {
      cooldownRemainingMs: 30_000,
      confirm: { k: 3, n: 3, nextCheckInMs: 1_500 },
      scan: { engineActive: true, lastCompletedAgoMs: 400, stale: false, errors: [], roots: [] },
    });
    const aged = stateForNow(snapshot(state, { receivedAtMono: 10_000 }), 12_000);
    expect(aged?.countdown?.remainingMs).toBe(85_000);
    expect(aged?.cooldownRemainingMs).toBe(28_000);
    expect(aged?.confirm.nextCheckInMs).toBe(0);
    expect(aged?.scan.lastCompletedAgoMs).toBe(2_400);
    // Everything else is the same state.
    expect({ ...aged, countdown: state.countdown, cooldownRemainingMs: 30_000, confirm: state.confirm, scan: state.scan }).toEqual(state);
  });

  it('passes a fresh state on untouched, and never adds time', () => {
    const state = counting('real');
    expect(stateForNow(snapshot(state, { receivedAtMono: 10_000 }), 10_000)).toBe(state);
    expect(stateForNow(snapshot(state, { receivedAtMono: 10_000 }), 9_000)).toBe(state);
    expect(stateForNow(snapshot(state, { receivedAtMono: 10_000 }), Number.NaN)).toBe(state);
    expect(stateForNow(snapshot(null), 10_000)).toBeNull();
  });

  it('leaves unknown durations unknown', () => {
    const state = uiState({ cooldownRemainingMs: null, confirm: { k: 0, n: 3, nextCheckInMs: null } });
    const aged = stateForNow(snapshot(state, { receivedAtMono: 0 }), 5_000);
    expect(aged?.cooldownRemainingMs).toBeNull();
    expect(aged?.confirm.nextCheckInMs).toBeNull();
    expect(aged?.scan.lastCompletedAgoMs).toBeNull();
    expect(aged?.countdown).toBeNull();
  });

  it('judges a countdown without a kind by the contract', () => {
    const noKind = { ...countdown(), kind: undefined } as unknown as ReturnType<typeof countdown>;
    expect(countdownOf(counting('real', { countdown: noKind, contract: contract({ testMode: true }) }))?.kind).toBe('test');
    expect(countdownOf(counting('real', { countdown: noKind, contract: contract({ testMode: false }) }))?.kind).toBe('real');
  });
});
