import { describe, expect, it } from 'vitest';
import type { ArmContract, PowerAction } from '../../src/shared/config';
import type { UiState } from '../../src/shared/protocol';
import { countdownAlertText, countdownToast, realModalText } from '../../src/shared/text';
import {
  ACTIONS,
  COUNTDOWN_KINDS,
  GARBAGE,
  contract,
  countdown,
  expectPrintable,
  finishedSession,
  localMs,
  uiState,
  workingSession,
} from './fixtures';

const real = (overrides: Partial<ArmContract> = {}) => contract({ testMode: false, ...overrides });
const nothingExtra = { unsavedFiles: 0, remoteWindows: [] };

describe('realModalText', () => {
  it('names the computer and the consequence in the title', () => {
    const modal = realModalText(uiState({ contract: real() }), nothingExtra);
    expect(modal.title).toBe('Shut down this PC (DESKTOP-TEST) when Claude finishes?');
  });

  it.each<[PowerAction, string]>([
    ['shutdown', 'Shut down this PC (DESKTOP-TEST) when Claude finishes?'],
    ['hibernate', 'Hibernate this PC (DESKTOP-TEST) when Claude finishes?'],
    ['sleep', 'Put this PC (DESKTOP-TEST) to sleep when Claude finishes?'],
    ['lock', 'Lock this PC (DESKTOP-TEST) when Claude finishes?'],
  ])('%s', (action, title) => {
    expect(realModalText(uiState({ contract: real({ action }) }), nothingExtra).title).toBe(title);
  });

  it('leaves the brackets out when the computer has no name', () => {
    for (const hostname of ['', '   ', undefined, null]) {
      const state = { ...uiState({ contract: real() }), hostname } as unknown as UiState;
      expect(realModalText(state, nothingExtra).title).toBe('Shut down this PC when Claude finishes?');
    }
  });

  it('spells out the rules, the window rule of amendment A and what gets closed', () => {
    const modal = realModalText(uiState({ contract: real() }), { unsavedFiles: 3, remoteWindows: [] });
    expect(modal.detail.split('\n\n')).toEqual([
      "Once every Claude session and subagent has been quiet for 5 min and you've been away 10 min, you get 90 s to cancel, then this PC shuts down.",
      'Keep VS Code open: quitting it, or closing its last window, stops watching. Work outside Claude (a build, a git push) is not seen.',
      'Other apps are closed without asking. 3 unsaved files in VS Code.',
    ]);
  });

  it('never tells the user to keep one particular window open', () => {
    for (const action of ACTIONS) {
      const modal = realModalText(uiState({ contract: real({ action }) }), nothingExtra);
      expect(modal.detail).not.toMatch(/this VS Code window|Keep the "/);
      expect(modal.detail).toContain('Keep VS Code open: quitting it, or closing its last window, stops watching.');
    }
  });

  it('omits the away clause when the gate is off', () => {
    const modal = realModalText(uiState({ contract: real({ requireUserIdle: false }) }), nothingExtra);
    expect(modal.detail.split('\n\n')[0]).toBe(
      'Once every Claude session and subagent has been quiet for 5 min, you get 90 s to cancel, then this PC shuts down.',
    );
  });

  it('keeps odd settings exact', () => {
    const rules = real({ quietSeconds: 150, userIdleSeconds: 5400, countdownSeconds: 15, action: 'sleep' });
    expect(realModalText(uiState({ contract: rules }), nothingExtra).detail.split('\n\n')[0]).toBe(
      "Once every Claude session and subagent has been quiet for 2 min 30 s and you've been away 1 h 30 min, you get 15 s to cancel, then this PC goes to sleep.",
    );
  });

  it('warns about other apps only for a forced shutdown, and counts unsaved files', () => {
    const lines = (rules: ArmContract, unsavedFiles: number) =>
      realModalText(uiState({ contract: rules }), { unsavedFiles, remoteWindows: [] }).detail.split('\n\n');
    expect(lines(real(), 0)[2]).toBe('Other apps are closed without asking.');
    expect(lines(real(), 1)[2]).toBe('Other apps are closed without asking. 1 unsaved file in VS Code.');
    expect(lines(real({ forceCloseApps: false }), 2)[2]).toBe('2 unsaved files in VS Code.');
    expect(lines(real({ forceCloseApps: false }), 0)).toHaveLength(2);
    expect(lines(real({ action: 'sleep' }), 2)).toHaveLength(2);
    expect(lines(real({ action: 'lock' }), 0)).toHaveLength(2);
  });

  it('names remote sessions that cannot be seen', () => {
    const one = realModalText(uiState({ contract: real() }), { unsavedFiles: 0, remoteWindows: ['WSL: Ubuntu'] });
    expect(one.detail).toContain('Claude sessions in WSL: Ubuntu are not visible.');
    const two = realModalText(uiState({ contract: real() }), { unsavedFiles: 0, remoteWindows: ['WSL: Ubuntu', 'SSH: build-box'] });
    expect(two.detail).toContain('Claude sessions in WSL: Ubuntu and SSH: build-box are not visible.');
  });

  it('says so when no test run has ever completed here', () => {
    const never = realModalText(uiState({ contract: real(), testPassedOnce: false }), nothingExtra);
    expect(never.detail.split('\n\n').pop()).toBe("You haven't completed a test run on this PC yet.");
    const once = realModalText(uiState({ contract: real(), testPassedOnce: true }), nothingExtra);
    expect(once.detail).not.toContain('test run');
    const unknown = { ...uiState({ contract: real() }), testPassedOnce: undefined } as unknown as UiState;
    expect(realModalText(unknown, nothingExtra).detail).toContain("You haven't completed a test run on this PC yet.");
  });

  it('makes "Keep this PC on" the way out and offers saving only when something is unsaved', () => {
    const clean = realModalText(uiState({ contract: real() }), nothingExtra);
    expect(clean.cancel).toBe('Keep this PC on');
    expect(clean.confirm).toBe('Shut down when finished');
    expect(clean.confirmAfterSave).toBeNull();
    const dirty = realModalText(uiState({ contract: real() }), { unsavedFiles: 2, remoteWindows: [] });
    expect(dirty.confirmAfterSave).toBe('Save all and shut down when finished');
  });

  it.each<[PowerAction, string, string]>([
    ['shutdown', 'Shut down when finished', 'Save all and shut down when finished'],
    ['hibernate', 'Hibernate when finished', 'Save all and hibernate when finished'],
    ['sleep', 'Sleep when finished', 'Save all and sleep when finished'],
    ['lock', 'Lock when finished', 'Save all and lock when finished'],
  ])('buttons for %s', (action, confirm, confirmAfterSave) => {
    const modal = realModalText(uiState({ contract: real({ action }) }), { unsavedFiles: 1, remoteWindows: [] });
    expect(modal.confirm).toBe(confirm);
    expect(modal.confirmAfterSave).toBe(confirmAfterSave);
    expect(modal.cancel).toBe('Keep this PC on');
  });

  it('describes the plan this window is about to send when it is given one', () => {
    const state = uiState({ contract: real({ action: 'shutdown' }) });
    const plan = real({ action: 'hibernate', quietSeconds: 600 });
    const modal = realModalText(state, { ...nothingExtra, plan });
    expect(modal.title).toBe('Hibernate this PC (DESKTOP-TEST) when Claude finishes?');
    expect(modal.detail).toContain('has been quiet for 10 min');
    expect(modal.confirm).toBe('Hibernate when finished');
  });

  it('never leaks a raw value', () => {
    for (const action of ACTIONS) {
      for (const junk of GARBAGE) {
        const rules = real({
          action,
          quietSeconds: junk as number,
          userIdleSeconds: junk as number,
          countdownSeconds: junk as number,
          requireUserIdle: junk as boolean,
          forceCloseApps: junk as boolean,
        });
        const state = { ...uiState({ contract: rules }), hostname: junk, testPassedOnce: junk } as unknown as UiState;
        const modal = realModalText(state, { unsavedFiles: junk as number, remoteWindows: junk as string[] });
        expectPrintable(modal);
        expect(modal.title).toMatch(/when Claude finishes\?$/);
      }
    }
    const noContract = { ...uiState(), contract: undefined } as unknown as UiState;
    expectPrintable(realModalText(noContract, nothingExtra));
  });

  it('keeps the warning about other apps unless forceCloseApps is exactly false', () => {
    for (const junk of GARBAGE) {
      const modal = realModalText(uiState({ contract: real({ forceCloseApps: junk as boolean }) }), nothingExtra);
      expect(modal.detail).toContain('Other apps are closed without asking.');
    }
  });
});

describe('countdownToast', () => {
  const now = localMs(2, 14, 0);
  const state = (kind: 'real' | 'test' | 'preview', action: PowerAction = 'shutdown') =>
    uiState({
      phase: 'countdown',
      contract: contract({ action, testMode: kind === 'test' }),
      countdown: countdown(kind, { action, remainingMs: 90_000 }),
    });

  it('real: when this PC acts, to the second', () => {
    expect(countdownToast(state('real'), now)).toEqual({
      message: 'Claude finished. This PC shuts down at 02:15:30.',
      cancelLabel: 'Cancel',
    });
  });

  it('test: nothing will turn off', () => {
    expect(countdownToast(state('test'), now)).toEqual({
      message: 'Test run: this PC would shut down at 02:15:30. Nothing will turn off.',
      cancelLabel: 'Stop test run',
    });
  });

  it('preview: a demo', () => {
    expect(countdownToast(state('preview'), now)).toEqual({
      message: 'Preview: a demo of the countdown, over at 02:15:30. Nothing will turn off.',
      cancelLabel: 'Cancel preview',
    });
  });

  it.each<[PowerAction, string]>([
    ['shutdown', 'Claude finished. This PC shuts down at 02:15:30.'],
    ['hibernate', 'Claude finished. This PC hibernates at 02:15:30.'],
    ['sleep', 'Claude finished. This PC goes to sleep at 02:15:30.'],
    ['lock', 'Claude finished. This PC locks at 02:15:30.'],
    ['notify', 'Claude finished. This PC notifies you at 02:15:30.'],
  ])('real %s', (action, message) => {
    expect(countdownToast(state('real', action), now).message).toBe(message);
  });

  it('says "shortly" rather than inventing a time', () => {
    for (const junk of GARBAGE.filter((value) => !(typeof value === 'number' && Number.isFinite(value)))) {
      const base = state('real');
      const broken = { ...base, countdown: { ...base.countdown, remainingMs: junk } } as unknown as UiState;
      expect(countdownToast(broken, now).message).toBe('Claude finished. This PC shuts down shortly.');
    }
    // `undefined` is left out here: it means "use the wall clock".
    for (const junk of [NaN, Infinity, null, '1700000000000', {}]) {
      expect(countdownToast(state('real'), junk as number).message).toBe('Claude finished. This PC shuts down shortly.');
    }
  });

  it('uses the wall clock when no time is passed in', () => {
    expect(countdownToast(state('real')).message).toMatch(/^Claude finished\. This PC shuts down at \d\d:\d\d:\d\d\.$/);
  });

  it('describes a countdown of a kind it does not know as real', () => {
    const base = state('test');
    const broken = { ...base, countdown: { ...base.countdown, kind: 'dryRun' } } as unknown as UiState;
    expect(countdownToast(broken, now).message).toBe('Claude finished. This PC shuts down at 02:15:30.');
  });

  it('never leaks a raw value', () => {
    for (const kind of COUNTDOWN_KINDS) {
      for (const action of ACTIONS) {
        expectPrintable(countdownToast(state(kind, action), now));
      }
    }
    expectPrintable(countdownToast(uiState(), now));
    expectPrintable(countdownToast({ ...uiState(), contract: undefined, countdown: undefined } as unknown as UiState, now));
  });
});

describe('countdownAlertText', () => {
  const sessions = [finishedSession('infra'), finishedSession('docs'), finishedSession('web-ui')];
  const state = (kind: 'real' | 'test' | 'preview', action: PowerAction = 'shutdown', overrides: Partial<UiState> = {}) =>
    uiState({
      phase: 'countdown',
      contract: contract({ action, testMode: kind === 'test' }),
      countdown: countdown(kind, { action }),
      sessions,
      ...overrides,
    });

  it('real: the consequence, why, and the cost', () => {
    expect(countdownAlertText(state('real'))).toEqual({
      title: 'Shutting down this PC in',
      body: 'All 3 Claude sessions finished. Unsaved work in other apps will be lost.',
      cancelLabel: 'Cancel: keep this PC on',
    });
  });

  it.each<[PowerAction, string]>([
    ['shutdown', 'Shutting down this PC in'],
    ['hibernate', 'Hibernating this PC in'],
    ['sleep', 'Putting this PC to sleep in'],
    ['lock', 'Locking this PC in'],
    ['notify', 'Notifying you in'],
  ])('real %s', (action, title) => {
    expect(countdownAlertText(state('real', action)).title).toBe(title);
  });

  it('mentions lost work only for a forced shutdown', () => {
    expect(countdownAlertText(state('real', 'hibernate')).body).toBe('All 3 Claude sessions finished.');
    const gentle = state('real', 'shutdown', { contract: contract({ testMode: false, forceCloseApps: false }) });
    expect(countdownAlertText(gentle).body).toBe('All 3 Claude sessions finished.');
  });

  it('counts sessions honestly', () => {
    const body = (list: UiState['sessions']) => countdownAlertText(state('real', 'lock', { sessions: list })).body;
    expect(body([])).toBe('No Claude session is running.');
    expect(body([finishedSession('infra')])).toBe('The Claude session finished.');
    expect(body([finishedSession('infra'), finishedSession('docs')])).toBe('Both Claude sessions finished.');
    expect(body([finishedSession('infra'), workingSession('parked', { ignored: true })])).toBe(
      'Every Claude session being waited for finished (1 not waited for).',
    );
  });

  it('counts the sessions that were left out of the list as well', () => {
    const body = (list: UiState['sessions'], sessionsOmitted: number) =>
      countdownAlertText(state('real', 'lock', { sessions: list, sessionsOmitted })).body;
    expect(body([], 40)).toBe('All 40 Claude sessions finished.');
    expect(body([finishedSession('infra')], 1)).toBe('Both Claude sessions finished.');
    expect(body([], 1)).toBe('The Claude session finished.');
    expect(body([], Number.NaN)).toBe('No Claude session is running.');
  });

  it('test: clearly harmless', () => {
    expect(countdownAlertText(state('test'))).toEqual({
      title: 'Test run: "Shut down" would happen in',
      body: 'Nothing will turn off.',
      cancelLabel: 'Stop test run',
    });
  });

  it('preview: clearly a demo', () => {
    expect(countdownAlertText(state('preview'))).toEqual({
      title: 'Preview: "Shut down" would happen in',
      body: 'A demo of the countdown. Nothing will turn off.',
      cancelLabel: 'Cancel preview',
    });
  });

  it('every title leads into the remaining time', () => {
    for (const kind of COUNTDOWN_KINDS) {
      for (const action of ACTIONS) {
        const alert = countdownAlertText(state(kind, action));
        expect(alert.title).toMatch(/ in$/);
        expect(alert.body).not.toBe('');
        expect(alert.cancelLabel).not.toBe('');
        expectPrintable(alert);
      }
    }
  });

  it('only a test or a preview may say that nothing will turn off', () => {
    for (const action of ACTIONS) {
      expect(JSON.stringify(countdownAlertText(state('real', action)))).not.toMatch(/Nothing will turn off|Test run|Preview/);
    }
    const base = state('test');
    const unknownKind = { ...base, countdown: { ...base.countdown, kind: 'dryRun' } } as unknown as UiState;
    expect(countdownAlertText(unknownKind).title).toBe('Shutting down this PC in');
  });

  it('survives a state that is not what the types promise', () => {
    for (const junk of GARBAGE) {
      const broken = { ...state('real'), contract: junk, sessions: junk, countdown: junk } as unknown as UiState;
      expectPrintable(countdownAlertText(broken));
      expectPrintable(countdownToast(broken, localMs(2, 14)));
    }
  });
});
