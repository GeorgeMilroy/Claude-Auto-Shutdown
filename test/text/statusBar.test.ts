import { describe, expect, it } from 'vitest';
import type { PowerAction } from '../../src/shared/config';
import type { CountdownKind, LastResult, Phase, Role, UiState } from '../../src/shared/protocol';
import { statusBarText } from '../../src/shared/text';
import {
  ACTIONS,
  CHECK_IDS,
  CHECK_STATES,
  COUNTDOWN_KINDS,
  GARBAGE,
  PHASES,
  check,
  checksWith,
  contract,
  countdown,
  expectPrintable,
  localMs,
  typicalCheck,
  uiState,
  watchingState,
} from './fixtures';

const ROLES: readonly Role[] = ['electing', 'leader', 'follower', 'isolated'];

const working = check('sessionsIdle', 'waiting', { total: 3, working: 2, cantTell: 0, ignored: 0, names: ['a', 'b'] });
const here = check('userIdle', 'waiting', { idleSeconds: 4, userIdleSeconds: 600 });

const real = (action: PowerAction = 'shutdown') => contract({ action, testMode: false });
const test = (action: PowerAction = 'shutdown') => contract({ action, testMode: true });

/** A state in the given phase, running `kind` (a preview only ever exists as a countdown). */
function stateIn(phase: Phase, kind: CountdownKind, action: PowerAction = 'shutdown'): UiState {
  const rules = kind === 'test' ? test(action) : real(action);
  const counting = phase === 'countdown' || phase === 'committing';
  return uiState({
    phase,
    armed: phase !== 'off' && kind !== 'preview',
    armedAtMs: phase === 'off' ? null : localMs(23, 2),
    contract: rules,
    confirm: { k: 2, n: 3, nextCheckInMs: 6000 },
    countdown: counting ? countdown(kind, { action }) : null,
    checks: phase === 'watching' ? checksWith(working, here) : checksWith(),
  });
}

describe('statusBarText: no trustworthy state', () => {
  it('lost contact for a follower, with a warning', () => {
    expect(statusBarText(null, 'follower', null)).toEqual({
      text: "$(question) Lost contact · can't tell",
      tooltip: ['The window in control stopped answering. Treat this PC as not watched.'],
      background: 'warning',
      click: 'open',
    });
  });

  it('the same words while a leader is being elected, without the alarm colour', () => {
    const bar = statusBarText(null, 'electing', null);
    expect(bar.text).toBe("$(question) Lost contact · can't tell");
    expect(bar.background).toBe('none');
    expect(bar.click).toBe('open');
  });

  it('never invents a state for a leader that has none', () => {
    expect(statusBarText(null, 'leader', 42).text).toBe("$(question) Lost contact · can't tell");
  });

  it('never promises that this PC stays on', () => {
    for (const role of ROLES) {
      expect(JSON.stringify(statusBarText(null, role, null))).not.toMatch(/stays on/);
    }
  });

  it('treats a state that is not an object as no state', () => {
    for (const junk of [NaN, undefined, '', 'state', 7, true, []]) {
      expect(statusBarText(junk as unknown as UiState, 'follower', null).text).toBe("$(question) Lost contact · can't tell");
    }
  });

  it('describes an empty state as the real thing rather than failing', () => {
    const bar = statusBarText({} as UiState, 'follower', null);
    expect(bar.text).toBe('$(eye) Will run an unknown action');
    expectPrintable(bar);
  });
});

describe('statusBarText: isolated', () => {
  it("can't coordinate, whatever state is passed along", () => {
    for (const state of [null, uiState(), stateIn('countdown', 'real')]) {
      expect(statusBarText(state, 'isolated', 87)).toEqual({
        text: "$(question) Can't coordinate",
        tooltip: ["Can't reach the other VS Code windows, so watching is off in this window."],
        background: 'warning',
        click: 'open',
      });
    }
  });
});

describe('statusBarText: not watching', () => {
  it('is calm and starts on click', () => {
    expect(statusBarText(uiState(), 'leader', null)).toEqual({
      text: '$(eye-closed) Auto Shutdown',
      tooltip: ['Not watching. This PC stays on.'],
      background: 'none',
      click: 'start',
    });
  });

  it('stays calm when checks are unmet: nothing is at stake while not watching', () => {
    const bar = statusBarText(uiState({ checks: CHECK_IDS.map((id) => typicalCheck(id, 'cantTell')) }), 'follower', null);
    expect(bar.text).toBe('$(eye-closed) Auto Shutdown');
    expect(bar.background).toBe('none');
  });
});

describe('statusBarText: watching', () => {
  it('for real: the consequence and how many things it waits on', () => {
    const bar = statusBarText(stateIn('watching', 'real'), 'leader', null);
    expect(bar.text).toBe('$(eye) Will shut down · waiting on 2');
    expect(bar.background).toBe('none');
    expect(bar.click).toBe('open');
    expect(bar.tooltip).toEqual([
      'Watching · for real since 23:02. This PC will shut down when Claude finishes.',
      'Claude: 2 of 3 still working',
      'You: away 0:04 of 10:00',
      'Keep VS Code open.',
    ]);
  });

  it('test run: says so instead of the consequence', () => {
    const bar = statusBarText(stateIn('watching', 'test'), 'follower', null);
    expect(bar.text).toBe('$(beaker) Test run · waiting on 2');
    expect(bar.background).toBe('none');
    expect(bar.tooltip[0]).toBe(
      'Watching · test run since 23:02. Nothing will turn off. You get a message when this PC would have shut down.',
    );
  });

  it.each<[PowerAction, string]>([
    ['shutdown', '$(eye) Will shut down · waiting on 2'],
    ['hibernate', '$(eye) Will hibernate · waiting on 2'],
    ['sleep', '$(eye) Will go to sleep · waiting on 2'],
    ['lock', '$(eye) Will lock · waiting on 2'],
    ['notify', '$(eye) Will notify you · waiting on 2'],
  ])('%s for real', (action, text) => {
    expect(statusBarText(stateIn('watching', 'real', action), 'leader', null).text).toBe(text);
  });

  it('"Just notify me" promises a message and nothing else', () => {
    const bar = statusBarText(stateIn('watching', 'real', 'notify'), 'leader', null);
    expect(bar.tooltip[0]).toBe('Watching since 23:02. You get a message when Claude finishes. Nothing will turn off.');
  });

  it('drops the count when nothing is unmet', () => {
    const bar = statusBarText(watchingState({ contract: real() }), 'leader', null);
    expect(bar.text).toBe('$(eye) Will shut down');
  });

  it('is the same for a follower as for the leader', () => {
    const state = stateIn('watching', 'real');
    expect(statusBarText(state, 'follower', null)).toEqual(statusBarText(state, 'leader', null));
    expect(JSON.stringify(statusBarText(state, 'follower', null))).not.toMatch(/Controlled by/);
  });

  it("can't tell: blocked, in words, with a warning", () => {
    const blind = check('scanner', 'cantTell', { reason: 'errors', errors: ['Could not read sessions/12.json (EACCES).'], roots: 1 });
    const bar = statusBarText(watchingState({ contract: real(), checks: checksWith(blind, working) }), 'leader', null);
    expect(bar.text).toBe("$(question) Can't tell · PC stays on");
    expect(bar.background).toBe('warning');
    expect(bar.click).toBe('open');
    expect(bar.tooltip).toContain("This PC: couldn't read the session list");
  });

  it('a Problem and Emergency stop have their own words', () => {
    const noHibernate = check('actionAllowed', 'fail', { action: 'hibernate', detail: 'Hibernation is turned off on this PC' });
    const problem = statusBarText(watchingState({ contract: real('hibernate'), checks: checksWith(noHibernate) }), 'leader', null);
    expect(problem.text).toBe('$(warning) Problem · PC stays on');
    expect(problem.background).toBe('warning');
    const stopped = statusBarText(watchingState({ contract: real(), checks: checksWith(check('stopFile', 'fail')) }), 'leader', null);
    expect(stopped.text).toBe('$(stop-circle) Emergency stop · PC stays on');
    expect(stopped.background).toBe('warning');
  });

  it('never shows a plain "waiting on" when any check cannot tell', () => {
    for (const id of CHECK_IDS.filter((candidate) => candidate !== 'armed' && candidate !== 'confirmed')) {
      const bar = statusBarText(watchingState({ contract: real(), checks: checksWith(typicalCheck(id, 'cantTell')) }), 'leader', null);
      expect(bar.text).not.toMatch(/waiting on/);
      expect(bar.background).toBe('warning');
    }
  });
});

describe('statusBarText: double-checking', () => {
  it('for real: warning background', () => {
    const bar = statusBarText(stateIn('confirming', 'real'), 'leader', null);
    expect(bar.text).toBe('$(check-all) Will shut down · check 2/3');
    expect(bar.background).toBe('warning');
    expect(bar.click).toBe('open');
    expect(bar.tooltip[1]).toBe('Everything looks finished. Making sure it stays that way (check 2 of 3).');
  });

  it('test run: no colour', () => {
    const bar = statusBarText(stateIn('confirming', 'test'), 'leader', null);
    expect(bar.text).toBe('$(beaker) Test run · check 2/3');
    expect(bar.background).toBe('none');
  });

  it('a message needs no warning colour', () => {
    expect(statusBarText(stateIn('confirming', 'real', 'notify'), 'leader', null).background).toBe('none');
  });

  it('does not print a count it cannot read', () => {
    for (const junk of GARBAGE) {
      const state = { ...stateIn('confirming', 'real'), confirm: junk } as unknown as UiState;
      expectPrintable(statusBarText(state, 'leader', null));
      const broken = { ...stateIn('confirming', 'real'), confirm: { k: junk, n: junk, nextCheckInMs: junk } } as unknown as UiState;
      expectPrintable(statusBarText(broken, 'leader', null));
    }
    const state = { ...stateIn('confirming', 'real'), confirm: undefined } as unknown as UiState;
    expect(statusBarText(state, 'leader', null).text).toBe('$(check-all) Will shut down · double-checking');
  });
});

describe('statusBarText: countdown', () => {
  it('for real: capitals, error background, a click cancels', () => {
    expect(statusBarText(stateIn('countdown', 'real'), 'leader', 87)).toEqual({
      text: '$(warning) SHUTTING DOWN in 1:27 · click to cancel',
      tooltip: ['Shutting down this PC in 1:27.', 'Click to cancel and keep this PC on.'],
      background: 'error',
      click: 'cancel',
    });
  });

  it.each<[PowerAction, string]>([
    ['shutdown', '$(warning) SHUTTING DOWN in 1:27 · click to cancel'],
    ['hibernate', '$(warning) HIBERNATING in 1:27 · click to cancel'],
    ['sleep', '$(warning) GOING TO SLEEP in 1:27 · click to cancel'],
    ['lock', '$(warning) LOCKING in 1:27 · click to cancel'],
    ['notify', '$(warning) NOTIFYING YOU in 1:27 · click to cancel'],
  ])('%s for real', (action, text) => {
    expect(statusBarText(stateIn('countdown', 'real', action), 'follower', 87).text).toBe(text);
  });

  it('test run: says nothing will turn off', () => {
    expect(statusBarText(stateIn('countdown', 'test'), 'leader', 87)).toEqual({
      text: '$(beaker) Test run 1:27 · click to stop',
      tooltip: ['Test run: nothing will turn off.', '"Shut down" would happen in 1:27.', 'Click to stop the test run.'],
      background: 'warning',
      click: 'cancel',
    });
  });

  it('rounds a fractional remainder up, like every other countdown surface', () => {
    expect(statusBarText(stateIn('countdown', 'real'), 'leader', 86.4).text).toBe('$(warning) SHUTTING DOWN in 1:27 · click to cancel');
    expect(statusBarText(stateIn('countdown', 'real'), 'leader', 0.2).text).toBe('$(warning) SHUTTING DOWN in 0:01 · click to cancel');
    expect(statusBarText(stateIn('countdown', 'real'), 'leader', 0).text).toBe('$(warning) SHUTTING DOWN in 0:00 · click to cancel');
  });

  it('preview: its own word', () => {
    const bar = statusBarText(stateIn('countdown', 'preview'), 'leader', 14);
    expect(bar.text).toBe('$(beaker) Preview 0:14 · click to stop');
    expect(bar.background).toBe('warning');
    expect(bar.click).toBe('cancel');
    expect(bar.tooltip).toEqual(['Preview: nothing will turn off.', '"Shut down" would happen in 0:14.', 'Click to stop the preview.']);
  });

  it('a preview is a countdown even though nothing is being watched', () => {
    const state = uiState({ phase: 'off', countdown: countdown('preview') });
    expect(statusBarText(state, 'leader', 14).text).toBe('$(beaker) Preview 0:14 · click to stop');
  });

  it('final check: still cancellable', () => {
    const realBar = statusBarText(stateIn('committing', 'real'), 'leader', 0);
    expect(realBar.text).toBe('$(warning) SHUTTING DOWN · final check · click to cancel');
    expect(realBar.background).toBe('error');
    expect(realBar.click).toBe('cancel');
    const testBar = statusBarText(stateIn('committing', 'test'), 'leader', 0);
    expect(testBar.text).toBe('$(beaker) Test run · final check · click to stop');
    expect(testBar.click).toBe('cancel');
  });

  it('falls back to the published time, and to 0:00 when there is none', () => {
    expect(statusBarText(stateIn('countdown', 'real'), 'leader', null).text).toBe('$(warning) SHUTTING DOWN in 1:27 · click to cancel');
    for (const junk of GARBAGE.filter((value) => !(typeof value === 'number' && Number.isFinite(value)))) {
      const state = stateIn('countdown', 'real');
      const broken = { ...state, countdown: { ...state.countdown, remainingMs: junk } } as unknown as UiState;
      const bar = statusBarText(broken, 'leader', junk as number);
      expect(bar.text).toBe('$(warning) SHUTTING DOWN in 0:00 · click to cancel');
      expectPrintable(bar);
    }
  });

  it('reads a countdown of a kind it does not know as the real thing', () => {
    for (const junk of [...GARBAGE.filter((value) => value !== undefined), 'dryRun']) {
      const state = stateIn('countdown', 'test');
      const broken = { ...state, countdown: { ...state.countdown, kind: junk } } as unknown as UiState;
      const bar = statusBarText(broken, 'leader', 87);
      expect(bar.text).toBe('$(warning) SHUTTING DOWN in 1:27 · click to cancel');
      expect(bar.background).toBe('error');
    }
  });

  it('judges a countdown phase with no countdown object by the contract', () => {
    expect(statusBarText(uiState({ phase: 'countdown', contract: real() }), 'leader', 87).background).toBe('error');
    expect(statusBarText(uiState({ phase: 'countdown', contract: test() }), 'leader', 87).text).toBe(
      '$(beaker) Test run 1:27 · click to stop',
    );
  });
});

describe('statusBarText: executing', () => {
  it.each<[PowerAction, string, 'error' | 'none']>([
    ['shutdown', '$(loading~spin) Shutting down…', 'error'],
    ['hibernate', '$(loading~spin) Hibernating…', 'error'],
    ['sleep', '$(loading~spin) Going to sleep…', 'error'],
    ['lock', '$(loading~spin) Locking…', 'error'],
    ['notify', '$(loading~spin) Notifying you…', 'none'],
  ])('%s', (action, text, background) => {
    const bar = statusBarText(stateIn('executing', 'real', action), 'leader', null);
    expect(bar.text).toBe(text);
    expect(bar.background).toBe(background);
    expect(bar.click).toBe('none');
  });

  it('a test run that is finishing turns nothing off and says so', () => {
    const bar = statusBarText(stateIn('executing', 'test'), 'leader', null);
    expect(bar.text).toBe('$(beaker) Test run finishing…');
    expect(bar.background).toBe('none');
    expect(bar.click).toBe('none');
  });
});

describe('statusBarText: results, until "Got it"', () => {
  const at = localMs(2, 14);
  const withResult = (lastResult: LastResult) => statusBarText(uiState({ lastResult }), 'leader', null);

  it('test passed', () => {
    const bar = withResult({
      kind: 'testPassed',
      atMs: at,
      action: 'shutdown',
      armedAtMs: null,
      lastSessionFinishedAtMs: null,
      allClearAtMs: null,
      heldUpBy: null,
    });
    expect(bar.text).toBe('$(pass) Test run passed');
    expect(bar.background).toBe('none');
    expect(bar.click).toBe('open');
    expect(bar.tooltip[0]).toBe('At 02:14 this PC would have shut down. Nothing was turned off.');
  });

  it.each<[PowerAction, string]>([
    ['shutdown', '$(pass) Shut down 02:14'],
    ['hibernate', '$(pass) Hibernated 02:14'],
    ['sleep', '$(pass) Went to sleep 02:14'],
    ['lock', '$(pass) Locked 02:14'],
    ['notify', '$(pass) Claude finished 02:14'],
  ])('done: %s', (action, text) => {
    const bar = withResult({ kind: 'done', atMs: at, action, resumedAtMs: null, confirmed: null });
    expect(bar.text).toBe(text);
    expect(bar.background).toBe('none');
    expect(bar.click).toBe('open');
  });

  it('done, but this PC is still on', () => {
    const bar = withResult({ kind: 'done', atMs: at, action: 'shutdown', resumedAtMs: null, confirmed: false });
    expect(bar.text).toBe('$(warning) Shutdown not confirmed');
    expect(bar.background).toBe('warning');
  });

  it.each<[PowerAction, string]>([
    ['lock', '$(warning) Lock not confirmed'],
    ['sleep', '$(warning) Sleep not confirmed'],
    ['hibernate', '$(warning) Hibernate not confirmed'],
  ])('done, but nothing showed the %s happened', (action, text) => {
    const bar = withResult({ kind: 'done', atMs: at, action, resumedAtMs: null, confirmed: false });
    expect(bar.text).toBe(text);
    expect(bar.background).toBe('warning');
    expect(bar.tooltip[0]).toMatch(/was requested at 02:14 because every Claude session had finished, but Windows didn't confirm/);
  });

  it.each<[PowerAction, string]>([
    ['shutdown', '$(error) Shutdown failed'],
    ['hibernate', '$(error) Hibernate failed'],
    ['sleep', '$(error) Sleep failed'],
    ['lock', '$(error) Lock failed'],
    ['notify', '$(error) Notification failed'],
  ])('failed: %s', (action, text) => {
    const bar = withResult({ kind: 'failed', atMs: at, action, message: 'Access is denied (exit 5)' });
    expect(bar.text).toBe(text);
    expect(bar.background).toBe('error');
    expect(bar.click).toBe('open');
  });

  it('cancelled', () => {
    const bar = withResult({
      kind: 'cancelled',
      atMs: at,
      reason: { id: 'user', via: 'esc' },
      stillWatching: false,
      countdownKind: 'real',
    });
    expect(bar.text).toBe('$(circle-slash) Cancelled');
    expect(bar.background).toBe('none');
    expect(bar.tooltip).toEqual(['You pressed Esc at 02:14.', 'Not watching any more.']);
  });

  it('watching stopped without acting', () => {
    const bar = withResult({ kind: 'stopped', atMs: at, cause: 'editorRestarted', armedAtMs: localMs(23, 2), wasReal: true });
    expect(bar.text).toBe('$(warning) Watching stopped');
    expect(bar.background).toBe('warning');
    expect(bar.click).toBe('open');
  });

  it('a cancel that left watching on shows the watching state, not the result', () => {
    const state = watchingState({
      contract: real(),
      checks: checksWith(working),
      lastResult: { kind: 'cancelled', atMs: at, reason: { id: 'userCameBack' }, stillWatching: true, countdownKind: 'real' },
    });
    expect(statusBarText(state, 'leader', null).text).toBe('$(eye) Will shut down · waiting on 1');
  });

  it('a result of a kind it does not know leaves the calm default', () => {
    const bar = withResult({ kind: 'paused', atMs: at } as unknown as LastResult);
    expect(bar.text).toBe('$(eye-closed) Auto Shutdown');
    expect(bar.click).toBe('start');
  });
});

describe('statusBarText: every phase x real / test / preview x role', () => {
  const cases = PHASES.flatMap((phase) => COUNTDOWN_KINDS.map((kind) => [phase, kind] as const));

  it.each(cases)('%s / %s', (phase, kind) => {
    for (const action of ACTIONS) {
      for (const role of ROLES) {
        for (const remaining of [null, 0, 87, 3725, NaN, -5, Infinity]) {
          const bar = statusBarText(stateIn(phase, kind, action), role, remaining);
          expect(bar.text).toMatch(/^\$\([a-z~-]+\) \S/);
          expect(bar.tooltip.length).toBeGreaterThan(0);
          expect(bar.tooltip.every((line) => line !== '' && !line.includes('\n'))).toBe(true);
          expect(['none', 'warning', 'error']).toContain(bar.background);
          expect(['open', 'cancel', 'start', 'none']).toContain(bar.click);
          expectPrintable(bar);
        }
      }
    }
  });

  it('only a countdown can be cancelled by a click, and only "not watching" starts', () => {
    for (const [phase, kind] of cases) {
      const bar = statusBarText(stateIn(phase, kind), 'leader', 87);
      const counting = phase === 'countdown' || phase === 'committing';
      expect(bar.click === 'cancel').toBe(counting);
      expect(bar.click === 'start').toBe(phase === 'off');
    }
  });

  it('the error colour is reserved for a real action in progress or a failure', () => {
    for (const [phase, kind] of cases) {
      for (const action of ACTIONS) {
        const bar = statusBarText(stateIn(phase, kind, action), 'leader', 87);
        const realCountdown = (phase === 'countdown' || phase === 'committing') && kind !== 'test' && kind !== 'preview';
        const realExecution = phase === 'executing' && kind !== 'test' && action !== 'notify';
        expect(bar.background === 'error').toBe(realCountdown || realExecution);
      }
    }
  });

  it('a test run never borrows the words of the real thing', () => {
    for (const phase of PHASES.filter((candidate) => candidate !== 'off')) {
      const bar = statusBarText(stateIn(phase, 'test'), 'leader', 87);
      expect(bar.text).toMatch(/Test run/);
      expect(bar.text).not.toMatch(/SHUTTING DOWN|Will shut down/);
    }
  });

  it('a phase it does not know reads as watching, not as "stays on"', () => {
    const state = { ...stateIn('watching', 'real'), phase: 'paused' } as unknown as UiState;
    expect(statusBarText(state, 'leader', null).text).toBe('$(eye) Will shut down · waiting on 2');
  });
});

describe('statusBarText: every check in every state while watching', () => {
  it.each(CHECK_IDS)('%s', (id) => {
    for (const state of CHECK_STATES) {
      const bar = statusBarText(watchingState({ contract: real(), checks: checksWith(typicalCheck(id, state)) }), 'follower', null);
      expectPrintable(bar);
      expect(bar.click).toBe('open');
    }
  });
});
