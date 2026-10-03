import { describe, expect, it } from 'vitest';

import type { LastResult, UiState } from '../../src/shared/protocol';
import { TransitionTracker } from '../../src/ui/transitions';
import type { Effect } from '../../src/ui/transitions';
import { contract, counting, countdown, snapshot, testPassed, uiState, watching } from './fixtures';

const NOW = 1_700_000_500_000;
const LONG_AGO = NOW - 6 * 60 * 60 * 1000;

function kinds(effects: Effect[]): string[] {
  return effects.map((effect) => effect.kind);
}

function toasts(effects: Effect[]): Extract<Effect, { kind: 'toast' }>[] {
  return effects.filter((effect): effect is Extract<Effect, { kind: 'toast' }> => effect.kind === 'toast');
}

/** A tracker that has already shown an ordinary "not watching" state. */
function seasoned(): TransitionTracker {
  const tracker = new TransitionTracker();
  expect(tracker.next(snapshot(uiState()), NOW)).toEqual([]);
  return tracker;
}

describe('countdown', () => {
  it('announces a countdown once, when it starts', () => {
    const tracker = seasoned();
    const started = tracker.next(snapshot(counting('real')), NOW);
    expect(kinds(started)).toEqual(['countdownStarted']);
    expect(started[0]).toMatchObject({ id: 'countdown-1', countdownKind: 'real' });
    expect((started[0] as { message: string }).message).toContain('This PC shuts down');
    // The leader publishes twice a second during a countdown.
    expect(tracker.next(snapshot(counting('real', { seq: 2 })), NOW + 500)).toEqual([]);
  });

  it('announces a countdown to a window that connects while it is already running', () => {
    const tracker = new TransitionTracker();
    expect(kinds(tracker.next(snapshot(counting('real'), { role: 'follower' }), NOW))).toEqual(['countdownStarted']);
  });

  it('withdraws the notification when the countdown is over', () => {
    const tracker = seasoned();
    tracker.next(snapshot(counting('test')), NOW);
    expect(kinds(tracker.next(snapshot(watching()), NOW + 1_000))).toEqual(['countdownEnded']);
  });

  it('withdraws the notification when contact is lost: its digits would be stale', () => {
    const tracker = seasoned();
    tracker.next(snapshot(counting('real'), { role: 'follower' }), NOW);
    expect(kinds(tracker.next(snapshot(null, { role: 'follower' }), NOW + 1_000))).toEqual(['countdownEnded']);
  });

  it('replaces the notification when another countdown follows directly', () => {
    const tracker = seasoned();
    tracker.next(snapshot(counting('real')), NOW);
    const second = counting('real', { countdown: countdown({ id: 'countdown-2' }) });
    expect(kinds(tracker.next(snapshot(second), NOW + 1_000))).toEqual(['countdownEnded', 'countdownStarted']);
  });

  it('marks the preview step done when a preview ends, but not when contact is lost during it', () => {
    const finished = seasoned();
    finished.next(snapshot(counting('preview')), NOW);
    expect(kinds(finished.next(snapshot(uiState()), NOW + 20_000))).toEqual(['countdownEnded', 'previewDone']);

    const interrupted = seasoned();
    interrupted.next(snapshot(counting('preview'), { role: 'follower' }), NOW);
    expect(kinds(interrupted.next(snapshot(null, { role: 'electing' }), NOW + 1_000))).toEqual(['countdownEnded']);
  });

  it('does not mark the preview step done after a real or test countdown', () => {
    const tracker = seasoned();
    tracker.next(snapshot(counting('test')), NOW);
    expect(kinds(tracker.next(snapshot(uiState()), NOW + 1_000))).toEqual(['countdownEnded']);
  });

  it('shows no countdown notification for the final check of "just notify me", which has no countdown', () => {
    const tracker = seasoned();
    const finalCheck = watching({ phase: 'committing', countdown: null, contract: contract({ action: 'notify' }) });
    expect(tracker.next(snapshot(finalCheck), NOW)).toEqual([]);
  });

  it('keeps the notification up through the final check of a countdown', () => {
    const tracker = seasoned();
    tracker.next(snapshot(counting('real')), NOW);
    expect(tracker.next(snapshot(counting('real', { phase: 'committing' })), NOW + 90_000)).toEqual([]);
  });
});

describe('results', () => {
  it('announces a passed test run when it happens', () => {
    const tracker = seasoned();
    const [toast] = toasts(tracker.next(snapshot(uiState({ lastResult: testPassed(NOW), testPassedOnce: true })), NOW));
    expect(toast).toMatchObject({ level: 'info', action: { command: 'claudeAutoShutdown.open' } });
    expect(toast?.message).toContain('Test run passed');
  });

  it("does not announce last night's result to a window that has just started", () => {
    const tracker = new TransitionTracker();
    expect(tracker.next(snapshot(uiState({ lastResult: testPassed(LONG_AGO) })), NOW)).toEqual([]);
  });

  it('announces a result that is only seconds old even to a window that has just started', () => {
    const stopped: LastResult = { kind: 'stopped', atMs: NOW - 2_000, cause: 'editorRestarted', armedAtMs: LONG_AGO, wasReal: true };
    const tracker = new TransitionTracker();
    const [toast] = toasts(tracker.next(snapshot(uiState({ lastResult: stopped })), NOW));
    expect(toast).toMatchObject({ level: 'warning' });
    expect(toast?.message).toContain('This PC stays on');
  });

  it('announces a result once, also across a loss of contact', () => {
    const tracker = seasoned();
    const state = uiState({ lastResult: testPassed(NOW) });
    expect(toasts(tracker.next(snapshot(state), NOW))).toHaveLength(1);
    expect(tracker.next(snapshot(state), NOW + 1_000)).toEqual([]);
    expect(tracker.next(snapshot(null, { role: 'electing' }), NOW + 2_000)).toEqual([]);
    expect(tracker.next(snapshot(state, { role: 'follower' }), NOW + 3_000)).toEqual([]);
  });

  it('shows a failed action as an error with the log one click away', () => {
    const failed: LastResult = { kind: 'failed', atMs: NOW, action: 'shutdown', message: 'Access is denied (exit 5)' };
    const [toast] = toasts(seasoned().next(snapshot(uiState({ lastResult: failed })), NOW));
    expect(toast).toMatchObject({ level: 'error', action: { command: 'claudeAutoShutdown.showLog' } });
    expect(toast?.message).toContain('This PC is still on');
  });

  it('announces a cancel, whoever caused it', () => {
    const byUser: LastResult = { kind: 'cancelled', atMs: NOW, reason: { id: 'user', via: 'esc' }, stillWatching: false, countdownKind: 'real' };
    const [userToast] = toasts(seasoned().next(snapshot(uiState({ lastResult: byUser })), NOW));
    expect(userToast).toMatchObject({ level: 'info', action: null });
    expect(userToast?.message).toContain('no longer watched');

    const bySession: LastResult = {
      kind: 'cancelled',
      atMs: NOW,
      reason: { id: 'sessionResumed', name: 'web-ui' },
      stillWatching: true,
      countdownKind: 'real',
    };
    const [autoToast] = toasts(seasoned().next(snapshot(watching({ lastResult: bySession })), NOW));
    expect(autoToast?.message).toContain('web-ui went back to work');
  });

  it('says loudly when watching stopped by itself, and stays quiet when the user stopped it', () => {
    const settings: LastResult = { kind: 'stopped', atMs: NOW, cause: 'settingsChanged', armedAtMs: LONG_AGO, wasReal: true };
    const [toast] = toasts(seasoned().next(snapshot(uiState({ lastResult: settings })), NOW));
    expect(toast).toMatchObject({ level: 'warning', message: 'A setting changed, so watching stopped. This PC stays on.' });

    const byUser: LastResult = { ...settings, cause: 'user' };
    expect(seasoned().next(snapshot(uiState({ lastResult: byUser })), NOW)).toEqual([]);
  });

  it('delivers the message of "just notify me"', () => {
    const done: LastResult = { kind: 'done', atMs: NOW, action: 'notify', resumedAtMs: null, confirmed: null };
    const [toast] = toasts(seasoned().next(snapshot(uiState({ lastResult: done })), NOW));
    expect(toast).toMatchObject({ level: 'info' });
    expect(toast?.message).toContain('Every Claude session finished');
  });

  it('warns once more when a shutdown turns out not to have happened, but not when a sleep ends', () => {
    const shutdown: LastResult = { kind: 'done', atMs: NOW, action: 'shutdown', resumedAtMs: null, confirmed: null };
    const tracker = seasoned();
    expect(toasts(tracker.next(snapshot(uiState({ lastResult: shutdown })), NOW))).toHaveLength(1);
    const [warning] = toasts(tracker.next(snapshot(uiState({ lastResult: { ...shutdown, confirmed: false } })), NOW + 120_000));
    expect(warning).toMatchObject({ level: 'warning' });

    const sleep: LastResult = { kind: 'done', atMs: NOW, action: 'sleep', resumedAtMs: null, confirmed: null };
    const sleeper = seasoned();
    expect(toasts(sleeper.next(snapshot(uiState({ lastResult: sleep })), NOW))).toHaveLength(1);
    expect(sleeper.next(snapshot(uiState({ lastResult: { ...sleep, resumedAtMs: NOW + 3_600_000 } })), NOW + 3_600_000)).toEqual([]);
  });

  it('warns, in every window, when a lock was requested but nothing showed it happened', () => {
    const lock: LastResult = { kind: 'done', atMs: NOW, action: 'lock', resumedAtMs: null, confirmed: false };
    const [warning] = toasts(seasoned().next(snapshot(uiState({ lastResult: lock })), NOW));
    expect(warning?.level).toBe('warning');
    expect(warning?.message).toMatch(/^A lock was requested at \d\d:\d\d, but Windows didn't confirm it happened\. Check this PC\.$/);
  });

  it('says why when the window in control lost control while still open', () => {
    const lost: LastResult = { kind: 'stopped', atMs: NOW, cause: 'lostControl', armedAtMs: LONG_AGO, wasReal: true };
    const [toast] = toasts(seasoned().next(snapshot(uiState({ lastResult: lost })), NOW));
    expect(toast?.level).toBe('warning');
    expect(toast?.message).toContain('lost control while it was still open');
    expect(toast?.message).not.toContain('closed');
  });

  it('announces nothing for a result it cannot read', () => {
    const odd = { kind: 'teleported', atMs: NOW } as unknown as LastResult;
    expect(seasoned().next(snapshot(uiState({ lastResult: odd })), NOW)).toEqual([]);
    const noTime = { kind: 'testPassed' } as unknown as LastResult;
    expect(seasoned().next(snapshot(uiState({ lastResult: noTime })), NOW)).toEqual([]);
  });
});

describe('watching since startup', () => {
  const startup = (overrides: Partial<UiState> = {}): UiState =>
    watching({ armedBy: 'startup', contract: contract({ testMode: false, action: 'sleep' }), ...overrides });

  it('warns in every window when a real run began by itself, with Stop watching one click away', () => {
    for (const role of ['leader', 'follower'] as const) {
      const [toast] = toasts(new TransitionTracker().next(snapshot(startup(), { role }), NOW));
      expect(toast).toMatchObject({ level: 'warning', action: { command: 'claudeAutoShutdown.stop' } });
      expect(toast?.message).toBe('Watching for real since startup: this PC will go to sleep when Claude finishes.');
    }
  });

  it('warns once per run', () => {
    const tracker = new TransitionTracker();
    expect(toasts(tracker.next(snapshot(startup()), NOW))).toHaveLength(1);
    expect(tracker.next(snapshot(startup({ seq: 2 })), NOW + 10_000)).toEqual([]);
    expect(tracker.next(snapshot(null, { role: 'electing' }), NOW + 11_000)).toEqual([]);
    expect(tracker.next(snapshot(startup({ seq: 3 }), { role: 'follower' }), NOW + 12_000)).toEqual([]);
  });

  it('does not warn for a test run, for "just notify me", or when a person started it', () => {
    expect(new TransitionTracker().next(snapshot(startup({ contract: contract({ testMode: true }) })), NOW)).toEqual([]);
    expect(new TransitionTracker().next(snapshot(startup({ contract: contract({ testMode: false, action: 'notify' }) })), NOW)).toEqual([]);
    expect(new TransitionTracker().next(snapshot(startup({ armedBy: 'user' })), NOW)).toEqual([]);
  });

  it('warns when the mode cannot be read: unknown is treated as real', () => {
    const unreadable = startup({ contract: {} as unknown as UiState['contract'] });
    expect(toasts(new TransitionTracker().next(snapshot(unreadable), NOW))).toHaveLength(1);
  });
});
