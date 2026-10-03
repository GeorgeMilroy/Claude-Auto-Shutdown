import { describe, expect, it } from 'vitest';
import type { LastResult, Role, UiState, ViewContext } from '../../src/shared/protocol';
import {
  buildHero,
  CONNECTING_GRACE_MS,
  countdownAnnouncement,
  countdownKindOf,
  heroKey,
  heroSpeech,
  isDegraded,
  isWatching,
  modeOf,
  pickHero,
  shownResult,
  stillWatchingCancel,
} from '../../src/webview/hero';
import type { HeroClock, HeroKind, HeroModel } from '../../src/webview/hero';
import { sanitizeState } from '../../src/webview/sanitize';
import { allScenes, expectPrintable, messageTypes, NOW, scene, stateOf } from './support';

const CLOCK: HeroClock = { scanAgeSeconds: 3, nextCheckSeconds: 6 };

function kindOf(id: string, nullForMs = 0): HeroKind {
  const { state, view } = scene(id);
  return pickHero(state, view, nullForMs).kind;
}

function heroOf(id: string, viewOverrides: Partial<ViewContext> = {}, nullForMs = 60_000): HeroModel {
  const { state, view } = scene(id);
  const seen = { ...view, ...viewOverrides };
  return buildHero(pickHero(state, seen, nullForMs), state, seen, CLOCK);
}

function withState(id: string, change: Partial<UiState>): UiState {
  return { ...stateOf(id), ...change };
}

describe('pickHero: one hero per (state, view)', () => {
  it.each([
    ['off-empty', 'off'],
    ['off-sessions', 'off'],
    ['watching-real', 'watching'],
    ['watching-test', 'watching'],
    ['watching-cancelled', 'watching'],
    ['confirming', 'confirming'],
    ['countdown-real', 'countdown'],
    ['countdown-test', 'countdown'],
    ['countdown-preview', 'countdown'],
    ['committing', 'committing'],
    ['executing', 'executing'],
    ['result-test-passed', 'result'],
    ['result-done-sleep', 'result'],
    ['result-failed', 'result'],
    ['result-cancelled', 'result'],
    ['result-stopped', 'result'],
    ['degraded', 'degraded'],
    ['degraded-off', 'degraded'],
    ['isolated', 'isolated'],
    ['limited', 'watching'],
    ['limited-foreign', 'countdown'],
    ['cant-run', 'cantRun'],
  ] as const)('%s -> %s', (id, expected) => {
    expect(kindOf(id)).toBe(expected);
  });

  it('shows "connecting" only for the first two seconds without a state, then lost contact', () => {
    expect(CONNECTING_GRACE_MS).toBe(2000);
    expect(kindOf('lost-contact', 0)).toBe('connecting');
    expect(kindOf('lost-contact', 1_999)).toBe('connecting');
    expect(kindOf('lost-contact', 2_000)).toBe('lostContact');
    expect(kindOf('lost-contact', 600_000)).toBe('lostContact');
  });

  it('calls it lost contact when the waiting time is unreadable', () => {
    expect(kindOf('lost-contact', NaN)).toBe('lostContact');
  });

  it('treats every role without a state the same way, except isolated', () => {
    const roles: Role[] = ['electing', 'leader', 'follower'];
    for (const role of roles) {
      const view = { ...scene('lost-contact').view, role };
      expect(pickHero(null, view, 5_000).kind).toBe('lostContact');
    }
    expect(pickHero(null, { ...scene('lost-contact').view, role: 'isolated' }, 0).kind).toBe('isolated');
  });

  it('shows isolated even when a state is at hand: this window cannot act on it', () => {
    const view: ViewContext = { ...scene('watching-real').view, role: 'isolated' };
    expect(pickHero(stateOf('watching-real'), view, 0).kind).toBe('isolated');
  });

  it('puts a running countdown above everything else known about the state', () => {
    const view = scene('countdown-real').view;
    const countdown = stateOf('countdown-real').countdown;
    const base = stateOf('result-failed');
    // Whatever the phase, the problem or the last result say: Cancel must be on screen.
    for (const phase of ['off', 'watching', 'confirming', 'countdown', 'executing', 'somethingNew'] as const) {
      const state = { ...base, phase, countdown, platform: { ...base.platform, problem: 'broken' } } as unknown as UiState;
      expect(pickHero(state, view, 0).kind).toBe('countdown');
    }
  });

  it('keeps the countdown hero when the phase says countdown but the countdown itself is missing', () => {
    const state = withState('countdown-real', { countdown: null });
    expect(pickHero(state, scene('countdown-real').view, 0)).toEqual({ kind: 'countdown', countdownKind: 'real' });
  });

  it('reads a phase it does not know as watching, so Stop watching is on screen', () => {
    const state = sanitizeState({ ...stateOf('watching-real'), phase: 'somethingNew' });
    expect(state).not.toBeNull();
    if (state === null) return;
    const hero = buildHero(pickHero(state, scene('watching-real').view, 0), state, scene('watching-real').view, CLOCK);
    expect(hero.kind).toBe('watching');
    expect(messageTypes(hero.primary?.action)).toEqual(['stop']);
  });

  it('shows a result before "can\'t run here", and "can\'t run here" before plain not-watching', () => {
    const view = scene('off-empty').view;
    const broken = { ...stateOf('off-empty').platform, problem: 'The helper did not start' };
    const failed = withState('result-failed', { platform: broken });
    expect(pickHero(failed, view, 0).kind).toBe('result');
    expect(pickHero({ ...failed, lastResult: null }, view, 0)).toEqual({ kind: 'cantRun', problem: 'The helper did not start' });
  });

  it('keeps Stop watching reachable when the platform breaks while watching', () => {
    const broken = { ...stateOf('watching-real').platform, problem: 'The helper did not start' };
    const state = withState('watching-real', { platform: broken });
    expect(pickHero(state, scene('watching-real').view, 0).kind).toBe('watching');
  });
});

describe('countdownKindOf', () => {
  it('passes test and preview through', () => {
    expect(countdownKindOf(stateOf('countdown-test'))).toBe('test');
    expect(countdownKindOf(stateOf('countdown-preview'))).toBe('preview');
  });

  it('reads any kind it does not know as real', () => {
    const base = stateOf('countdown-test');
    const odd = { ...base, countdown: { ...base.countdown, kind: 'rehearsal' } } as unknown as UiState;
    expect(countdownKindOf(odd)).toBe('real');
  });

  it('judges a countdown without a kind by the contract, and only an explicit test run is a test', () => {
    const real = withState('countdown-real', { countdown: null });
    const test = withState('countdown-test', { countdown: null });
    expect(countdownKindOf(real)).toBe('real');
    expect(countdownKindOf(test)).toBe('test');
    const unclear = { ...test, contract: { ...test.contract, testMode: 'yes' } } as unknown as UiState;
    expect(countdownKindOf(unclear)).toBe('real');
  });
});

describe('modeOf / isWatching / isDegraded', () => {
  it('only calls an explicit testMode a test run', () => {
    expect(modeOf(stateOf('watching-test').contract)).toBe('test');
    expect(modeOf(stateOf('watching-real').contract)).toBe('real');
    expect(modeOf(stateOf('off-notify').contract)).toBe('notify');
    const unclear = { ...stateOf('watching-test').contract, testMode: undefined } as unknown as UiState['contract'];
    expect(modeOf(unclear)).toBe('real');
  });

  it('does not count a preview countdown as watching', () => {
    expect(isWatching(stateOf('countdown-preview'))).toBe(false);
    expect(isWatching(stateOf('countdown-real'))).toBe(true);
    expect(isWatching(stateOf('watching-real'))).toBe(true);
    expect(isWatching(stateOf('off-sessions'))).toBe(false);
  });

  it('is degraded when the scan is stale or reported errors', () => {
    expect(isDegraded(stateOf('degraded'))).toBe(true);
    expect(isDegraded(stateOf('degraded-off'))).toBe(true);
    expect(isDegraded(stateOf('watching-real'))).toBe(false);
  });
});

describe('shownResult', () => {
  const cancelled: LastResult = { kind: 'cancelled', atMs: NOW, reason: { id: 'userCameBack' }, stillWatching: true, countdownKind: 'real' };

  it('does not show a cancel that left watching on as a result card', () => {
    expect(shownResult(cancelled)).toBeNull();
    expect(shownResult({ ...cancelled, stillWatching: false })).not.toBeNull();
  });

  it('shows that cancel as the notice of the watching state instead', () => {
    expect(stillWatchingCancel(stateOf('watching-cancelled'))?.kind).toBe('cancelled');
    expect(stillWatchingCancel(stateOf('watching-real'))).toBeNull();
    // Not while not watching: "still watching" would be false there.
    expect(stillWatchingCancel(withState('off-sessions', { lastResult: cancelled }))).toBeNull();
  });

  it('gives a card to a watch that ended because the watching window lost control', () => {
    const model = heroOf('result-stopped-lost-control');
    expect(model.kind).toBe('result');
    expect(model.lead).toBe(
      'The VS Code window that was watching lost control while it was still open ' +
        '(its connection to the other windows ended), so watching stopped. Nothing was turned off.',
    );
  });

  it('tells a lock nobody saw happen as a warning, not as done', () => {
    const model = heroOf('result-lock-unconfirmed');
    expect(model.title).toMatch(/^LOCK NOT CONFIRMED · \d\d:\d\d$/);
    expect(model.lead).toMatch(
      /^A lock was requested at \d\d:\d\d because every Claude session had finished, but Windows didn't confirm it happened\. Check this PC\.$/,
    );
    expect(model.glyph.icon).toBe('warning');
  });

  it('gives no card to a stop the user asked for or one that followed the action', () => {
    const stopped: LastResult = { kind: 'stopped', atMs: NOW, cause: 'user', armedAtMs: null, wasReal: true };
    expect(shownResult(stopped)).toBeNull();
    expect(shownResult({ ...stopped, cause: 'afterAction' })).toBeNull();
    for (const cause of ['settingsChanged', 'timeJump', 'windowClosed', 'editorRestarted'] as const) {
      expect(shownResult({ ...stopped, cause })).not.toBeNull();
    }
  });

  it('ignores a result of a kind this version does not know', () => {
    expect(shownResult({ kind: 'exploded', atMs: NOW } as unknown as LastResult)).toBeNull();
    expect(shownResult(null)).toBeNull();
  });
});

describe('heroKey: when the click guard restarts', () => {
  it('changes when the phase, the hero or the kind of result changes', () => {
    const keys = ['off-sessions', 'watching-real', 'confirming', 'countdown-real', 'countdown-test', 'result-failed', 'result-test-passed'].map(
      (id) => heroKey(scene(id).state, scene(id).view),
    );
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('does not change while the same state keeps arriving', () => {
    const { state, view } = scene('watching-real');
    expect(heroKey(state, view)).toBe(heroKey({ ...stateOf('watching-real'), seq: 99 }, view));
  });
});

describe('slot P: only safe or neutral buttons', () => {
  const NEVER_IN_THE_HERO = ['start', 'preview', 'setAction', 'setTestMode', 'ignore'];

  it('never offers anything that starts watching, in any fixture', () => {
    for (const { id, scene: each } of allScenes()) {
      for (const nullForMs of [0, 60_000]) {
        const hero = buildHero(pickHero(each.state, each.view, nullForMs), each.state, each.view, CLOCK);
        const offered = [hero.primary, ...hero.secondary].flatMap((item) => messageTypes(item?.action));
        for (const type of NEVER_IN_THE_HERO) expect(offered, id).not.toContain(type);
      }
    }
  });

  it('offers Stop watching while watching and double-checking', () => {
    for (const id of ['watching-real', 'watching-test', 'confirming', 'degraded']) {
      expect(messageTypes(heroOf(id).primary?.action), id).toEqual(['stop']);
    }
  });

  it('offers Cancel, and nothing else, during a countdown and the final check', () => {
    for (const id of ['countdown-real', 'countdown-test', 'countdown-preview', 'committing', 'limited-foreign']) {
      const hero = heroOf(id);
      expect(messageTypes(hero.primary?.action), id).toEqual(['cancel']);
      expect(hero.primary?.emphasis, id).toBe('primary');
      expect(hero.secondary, id).toEqual([]);
    }
  });

  it('has no controls at all while the action is being run', () => {
    const hero = heroOf('executing');
    expect(hero.primary).toBeNull();
    expect(hero.secondary).toEqual([]);
  });

  it('offers "Got it" on results, and the log on a failure', () => {
    for (const id of ['result-test-passed', 'result-done-sleep', 'result-cancelled', 'result-stopped']) {
      expect(messageTypes(heroOf(id).primary?.action), id).toEqual(['dismissResult']);
    }
    expect(messageTypes(heroOf('result-failed').primary?.action)).toEqual(['showLog']);
  });

  it('offers "Check again" when degraded and not watching, and keeps Stop in place when watching', () => {
    expect(messageTypes(heroOf('degraded-off').primary?.action)).toEqual(['refresh']);
    const watching = heroOf('degraded');
    expect(messageTypes(watching.primary?.action)).toEqual(['stop']);
    expect(watching.secondary.flatMap((item) => messageTypes(item.action))).toContain('refresh');
    expect(watching.warning).not.toBeNull();
  });

  it('with no contact, offers the one command that is retried and backed by Emergency stop', () => {
    const hero = heroOf('lost-contact');
    expect(hero.kind).toBe('lostContact');
    expect(messageTypes(hero.primary?.action)).toEqual(['stop']);
  });

  it('"Switch to For real" only selects; it is offered only when the plan is a test run of a real action', () => {
    const passed = heroOf('result-test-passed');
    expect(passed.secondary.map((item) => item.action.do)).toContain('switchToReal');
    const alreadyReal = heroOf('result-test-passed', { plan: stateOf('watching-real').contract });
    expect(alreadyReal.secondary.map((item) => item.action.do)).not.toContain('switchToReal');
  });
});

describe('hero wording', () => {
  it('says the mode in the title', () => {
    expect(heroOf('watching-real').title).toContain('FOR REAL');
    expect(heroOf('watching-test').title).toContain('TEST RUN');
    expect(heroOf('confirming').title).toContain('DOUBLE-CHECKING');
  });

  it('frames a real countdown solid and a test or preview dashed', () => {
    expect(heroOf('countdown-real').frame).toBe('real');
    expect(heroOf('countdown-test').frame).toBe('test');
    expect(heroOf('countdown-preview').frame).toBe('test');
    expect(heroOf('watching-real').frame).toBe('plain');
  });

  it('gives the warning strip to a real double-check only', () => {
    expect(heroOf('confirming').frame).toBe('warning');
    const { view } = scene('confirming');
    const test = withState('confirming', { contract: stateOf('watching-test').contract });
    expect(buildHero(pickHero(test, view, 0), test, view, CLOCK).frame).toBe('plain');
  });

  it('says in words whether moving the mouse cancels', () => {
    expect(heroOf('countdown-real').countdown?.mouseLine).toMatch(/So does moving the mouse/);
    expect(heroOf('countdown-real-no-idle').countdown?.mouseLine).toMatch(/will NOT cancel/);
    // A preview never samples the mouse, whatever the settings say.
    expect(heroOf('countdown-preview').countdown?.mouseLine).toMatch(/will NOT cancel/);
  });

  it('claims the mouse cancels only on an explicit setting', () => {
    const { view } = scene('countdown-real');
    const base = stateOf('countdown-real');
    const unclear = { ...base, contract: { ...base.contract, requireUserIdle: 'true' } } as unknown as UiState;
    const hero = buildHero(pickHero(unclear, view, 0), unclear, view, CLOCK);
    expect(hero.countdown?.mouseLine).toMatch(/will NOT cancel/);
  });

  it('shows "Cancelling…" / "Stopping…" while a command from this window is unacknowledged', () => {
    expect(heroOf('countdown-real', { pending: 'cancel' }).primary?.label).toBe('Cancelling…');
    expect(heroOf('watching-real', { pending: 'disarm' }).primary?.label).toBe('Stopping…');
    // The button itself still works: pressing it again sends the command again.
    expect(messageTypes(heroOf('countdown-real', { pending: 'cancel' }).primary?.action)).toEqual(['cancel']);
  });

  it('draws the double-check dots only for a sane count', () => {
    expect(heroOf('confirming').confirm).toMatchObject({ k: 2, n: 3, spoken: 'Check 2 of 3 passed' });
    const { view } = scene('confirming');
    for (const confirm of [{ k: NaN, n: 3 }, { k: 1, n: 5000 }, { k: 1, n: 0 }, { k: -1, n: 3 }, {}]) {
      const state = { ...stateOf('confirming'), confirm } as unknown as UiState;
      expect(buildHero(pickHero(state, view, 0), state, view, CLOCK).confirm).toBeNull();
    }
  });

  it('never prints a raw unknown, for any fixture', () => {
    for (const { scene: each } of allScenes()) {
      const unknownClock: HeroClock = { scanAgeSeconds: null, nextCheckSeconds: null };
      expectPrintable(buildHero(pickHero(each.state, each.view, 60_000), each.state, each.view, unknownClock));
    }
  });
});

describe('a window that can only Cancel and Stop', () => {
  it('keeps Stop and Cancel', () => {
    expect(messageTypes(heroOf('limited').primary?.action)).toEqual(['stop']);
    expect(messageTypes(heroOf('countdown-real', { limited: true }).primary?.action)).toEqual(['cancel']);
  });

  it('drops the controls that would silently do nothing', () => {
    expect(heroOf('result-test-passed', { limited: true }).primary).toBeNull();
    const offered = heroOf('result-test-passed', { limited: true }).secondary.map((item) => item.action.do);
    expect(offered).not.toContain('switchToReal');
    expect(messageTypes(heroOf('degraded-off', { limited: true }).primary?.action)).toEqual([]);
  });
});

describe('what the live regions say', () => {
  it('announces a watching state politely, with what is being waited for', () => {
    const speech = heroSpeech(heroOf('watching-real'), 'Still on: waiting for Claude.');
    expect(speech.assertive).toBe('');
    expect(speech.polite).toBe('WATCHING · FOR REAL. Still on: waiting for Claude.');
  });

  it('interrupts for results, "can\'t tell" and lost contact', () => {
    for (const id of ['result-failed', 'degraded', 'lost-contact', 'isolated', 'cant-run']) {
      const speech = heroSpeech(heroOf(id), '');
      expect(speech.polite, id).toBe('');
      expect(speech.assertive, id).not.toBe('');
    }
  });

  it('announces a countdown once, with its length and how to cancel', () => {
    const real = heroOf('countdown-real').countdown;
    const test = heroOf('countdown-test').countdown;
    expect(real).not.toBeNull();
    expect(test).not.toBeNull();
    if (real === null || test === null) return;
    expect(countdownAnnouncement(real, 90)).toBe('Shutting down this PC in 1 minute 30 seconds. Press Escape to cancel.');
    expect(countdownAnnouncement(test, 90)).toMatch(/^Test run: .* 1 minute 30 seconds\. Nothing will turn off\. Press Escape to cancel\.$/);
  });
});
