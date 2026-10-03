import { describe, expect, it } from 'vitest';
import type { PowerAction } from '../../src/shared/config';
import type { CancelReason, LastResult, StopCause } from '../../src/shared/protocol';
import { cancelReasonText, describeResult } from '../../src/shared/text';
import { ACTIONS, CANCEL_REASONS, CHECK_IDS, COUNTDOWN_KINDS, GARBAGE, expectPrintable, localMs } from './fixtures';

const AT = localMs(2, 14, 7);
const OS = 'Windows';

type ResultOf<K extends LastResult['kind']> = Extract<LastResult, { kind: K }>;

function testPassed(overrides: Partial<ResultOf<'testPassed'>> = {}): LastResult {
  return {
    kind: 'testPassed',
    atMs: AT,
    action: 'shutdown',
    armedAtMs: localMs(23, 2),
    lastSessionFinishedAtMs: localMs(1, 58),
    allClearAtMs: localMs(2, 12),
    heldUpBy: { name: 'web-ui', seconds: 7740 },
    ...overrides,
  };
}

function done(overrides: Partial<ResultOf<'done'>> = {}): LastResult {
  return { kind: 'done', atMs: AT, action: 'shutdown', resumedAtMs: null, confirmed: null, ...overrides };
}

function failed(overrides: Partial<ResultOf<'failed'>> = {}): LastResult {
  return { kind: 'failed', atMs: AT, action: 'shutdown', message: 'Access is denied (exit 5)', ...overrides };
}

function cancelled(overrides: Partial<ResultOf<'cancelled'>> = {}): LastResult {
  return {
    kind: 'cancelled',
    atMs: localMs(2, 13),
    reason: { id: 'user', via: 'esc' },
    stillWatching: false,
    countdownKind: 'real',
    ...overrides,
  };
}

function stopped(overrides: Partial<ResultOf<'stopped'>> = {}): LastResult {
  return {
    kind: 'stopped',
    atMs: localMs(2, 13),
    cause: 'settingsChanged',
    armedAtMs: localMs(23, 2),
    wasReal: true,
    ...overrides,
  };
}

const STOP_CAUSE_SET: Record<StopCause, true> = {
  user: true,
  settingsChanged: true,
  timeJump: true,
  windowClosed: true,
  lostControl: true,
  editorRestarted: true,
  afterAction: true,
};
const STOP_CAUSES = Object.keys(STOP_CAUSE_SET) as StopCause[];

describe('cancelReasonText', () => {
  it.each(CANCEL_REASONS.map((reason) => [JSON.stringify(reason), reason] as const))('%s', (_label, reason) => {
    const text = cancelReasonText(reason);
    expect(text).not.toBe('');
    expect(text).not.toMatch(/[.!?]$/);
    expectPrintable(text);
  });

  it('uses the words of the UI spec', () => {
    expect(cancelReasonText({ id: 'user', via: 'esc' })).toBe('You pressed Esc');
    for (const via of ['button', 'statusBar', 'notification', 'osAlert', 'command'] as const) {
      expect(cancelReasonText({ id: 'user', via })).toBe('You cancelled');
    }
    expect(cancelReasonText({ id: 'userCameBack' })).toBe('You came back');
    expect(cancelReasonText({ id: 'sessionResumed', name: 'web-ui' })).toBe('web-ui went back to work');
    expect(cancelReasonText({ id: 'checkFailed', check: 'guard' })).toBe(
      'A check stopped passing: Nothing on your keep-on list',
    );
    expect(cancelReasonText({ id: 'settingsChanged' })).toBe('A setting changed');
    expect(cancelReasonText({ id: 'timeJump' })).toBe('This PC slept and woke up');
    expect(cancelReasonText({ id: 'leaderChanged' })).toBe('Another window took over');
    expect(cancelReasonText({ id: 'emergencyStop' })).toBe('Emergency stop was set');
    expect(cancelReasonText({ id: 'stoppedWatching' })).toBe('You stopped watching');
    expect(cancelReasonText({ id: 'scanStale' })).toBe('The last check became too old to trust');
  });

  it('names every known check, and prints an unknown one verbatim', () => {
    for (const check of CHECK_IDS) {
      const text = cancelReasonText({ id: 'checkFailed', check });
      expect(text.startsWith('A check stopped passing: ')).toBe(true);
      expect(text).not.toBe(`A check stopped passing: ${check}`);
    }
    expect(cancelReasonText({ id: 'checkFailed', check: 'diskSpace' })).toBe('A check stopped passing: diskSpace');
    expect(cancelReasonText({ id: 'checkFailed', check: 'toString' })).toBe('A check stopped passing: toString');
  });

  it('survives junk', () => {
    for (const junk of GARBAGE) {
      expectPrintable(cancelReasonText({ id: 'sessionResumed', name: junk as string }));
      expectPrintable(cancelReasonText({ id: 'checkFailed', check: junk as string }));
      expectPrintable(cancelReasonText({ id: 'user', via: junk as 'esc' }));
      expect(cancelReasonText({ id: junk } as unknown as CancelReason)).toBe('The countdown was cancelled');
    }
    expect(cancelReasonText({ id: 'sessionResumed', name: '' })).toBe('A session went back to work');
  });
});

describe('describeResult: test passed', () => {
  it('reads like the wireframe', () => {
    expect(describeResult(testPassed(), OS)).toEqual({
      title: 'TEST RUN PASSED · 02:14',
      body: [
        'At 02:14 this PC would have shut down. Nothing was turned off.',
        '23:02 started · 01:58 last session finished · 02:12 all clear',
        'Held up longest by: web-ui, 2 h 9 min',
        'Not watching. This PC stays on.',
      ],
      oneLine: 'Test run passed. This PC would have shut down at 02:14.',
      tone: 'ok',
    });
  });

  it('leaves out the milestones it does not know', () => {
    const bare = testPassed({ armedAtMs: null, lastSessionFinishedAtMs: null, allClearAtMs: null, heldUpBy: null });
    expect(describeResult(bare, OS).body).toEqual([
      'At 02:14 this PC would have shut down. Nothing was turned off.',
      'Not watching. This PC stays on.',
    ]);
    const partial = testPassed({ lastSessionFinishedAtMs: null, heldUpBy: null });
    expect(describeResult(partial, OS).body[1]).toBe('23:02 started · 02:12 all clear');
  });

  it.each<[PowerAction, string]>([
    ['shutdown', 'At 02:14 this PC would have shut down. Nothing was turned off.'],
    ['hibernate', 'At 02:14 this PC would have hibernated. Nothing was turned off.'],
    ['sleep', 'At 02:14 this PC would have gone to sleep. Nothing was turned off.'],
    ['lock', 'At 02:14 this PC would have locked. Nothing was turned off.'],
    ['notify', 'At 02:14 this PC would have notified you. Nothing was turned off.'],
  ])('%s', (action, firstLine) => {
    expect(describeResult(testPassed({ action }), OS).body[0]).toBe(firstLine);
  });
});

describe('describeResult: done', () => {
  it.each<[PowerAction, string, string]>([
    ['shutdown', 'SHUT DOWN · 02:14', 'This PC shut down at 02:14 because every Claude session had finished.'],
    ['hibernate', 'HIBERNATED · 02:14', 'This PC hibernated at 02:14 because every Claude session had finished.'],
    ['sleep', 'WENT TO SLEEP · 02:14', 'This PC went to sleep at 02:14 because every Claude session had finished.'],
    ['lock', 'LOCKED · 02:14', 'This PC was locked at 02:14 because every Claude session had finished.'],
    ['notify', 'CLAUDE FINISHED · 02:14', 'Every session finished. Nothing was turned off.'],
  ])('%s', (action, title, firstLine) => {
    const text = describeResult(done({ action }), OS);
    expect(text.title).toBe(title);
    expect(text.body[0]).toBe(firstLine);
    expect(text.tone).toBe('ok');
  });

  it('says when this PC woke again, and that it will not act twice', () => {
    const text = describeResult(done({ action: 'sleep', resumedAtMs: localMs(8, 31) }), OS);
    expect(text.body).toEqual([
      'This PC went to sleep at 02:14 because every Claude session had finished. Woke at 08:31.',
      "Not watching any more, so it won't go to sleep again by itself.",
    ]);
    expect(text.oneLine).toBe('This PC went to sleep at 02:14.');
  });

  it('admits a shutdown that never happened', () => {
    const text = describeResult(done({ confirmed: false }), OS);
    expect(text.title).toBe('SHUTDOWN NOT CONFIRMED · 02:14');
    expect(text.body[0]).toBe("A shutdown was started at 02:14; I can't confirm it completed.");
    expect(text.tone).toBe('error');
    expect(describeResult(done({ confirmed: true }), OS).title).toBe('SHUT DOWN · 02:14');
  });

  it.each<[PowerAction, string, string]>([
    ['lock', 'LOCK NOT CONFIRMED · 02:14', 'A lock'],
    ['sleep', 'SLEEP NOT CONFIRMED · 02:14', 'Sleep'],
    ['hibernate', 'HIBERNATE NOT CONFIRMED · 02:14', 'Hibernation'],
  ])('admits a %s nobody saw happen, on every surface that tells the result', (action, title, what) => {
    const text = describeResult(done({ action, confirmed: false }), OS);
    expect(text).toEqual({
      title,
      body: [
        `${what} was requested at 02:14 because every Claude session had finished, but Windows didn't confirm it happened. Check this PC.`,
        'Not watching any more.',
      ],
      oneLine: `${what} was requested at 02:14, but Windows didn't confirm it happened. Check this PC.`,
      tone: 'error',
    });
    expect(JSON.stringify(text)).not.toMatch(/was locked|went to sleep|hibernated|2 minutes later/);
  });

  it('names the system that did not confirm, and says "the operating system" when it is unknown', () => {
    expect(describeResult(done({ action: 'lock', confirmed: false }), 'Linux').oneLine).toBe(
      "A lock was requested at 02:14, but Linux didn't confirm it happened. Check this PC.",
    );
    expect(describeResult(done({ action: 'lock', confirmed: false }), '').oneLine).toBe(
      "A lock was requested at 02:14, but the operating system didn't confirm it happened. Check this PC.",
    );
  });

  it('still reports a lock it could confirm, or had no way to confirm, as done', () => {
    for (const confirmed of [true, null]) {
      const text = describeResult(done({ action: 'lock', confirmed }), OS);
      expect(text.title).toBe('LOCKED · 02:14');
      expect(text.tone).toBe('ok');
    }
  });
});

describe('describeResult: failed', () => {
  it('reads like the wireframe', () => {
    expect(describeResult(failed(), OS)).toEqual({
      title: "COULDN'T SHUT DOWN · 02:14",
      body: ['Access is denied (exit 5). This PC is still on.', 'Not watching.'],
      oneLine: "Couldn't shut down: Access is denied (exit 5). This PC is still on.",
      tone: 'error',
    });
  });

  it('does not double the full stop of a message that already has one', () => {
    const text = describeResult(failed({ message: "Windows didn't answer within 25 s. Treated as failed." }), OS);
    expect(text.body[0]).toBe("Windows didn't answer within 25 s. Treated as failed. This PC is still on.");
  });

  it('says so when the system gave no reason', () => {
    for (const message of ['', '   ', undefined, null]) {
      const text = describeResult(failed({ message: message as string }), 'Linux');
      expect(text.body[0]).toBe('Linux gave no reason. This PC is still on.');
    }
  });

  it.each<[PowerAction, string]>([
    ['shutdown', "COULDN'T SHUT DOWN · 02:14"],
    ['hibernate', "COULDN'T HIBERNATE · 02:14"],
    ['sleep', "COULDN'T GO TO SLEEP · 02:14"],
    ['lock', "COULDN'T LOCK · 02:14"],
    ['notify', "COULDN'T NOTIFY YOU · 02:14"],
  ])('%s', (action, title) => {
    expect(describeResult(failed({ action }), OS).title).toBe(title);
  });
});

describe('describeResult: cancelled', () => {
  it('by you: no longer watching', () => {
    expect(describeResult(cancelled(), OS)).toEqual({
      title: 'CANCELLED · PC STAYS ON',
      body: ['You pressed Esc at 02:13.', 'Not watching any more.'],
      oneLine: 'Cancelled. This PC stays on and is no longer watched.',
      tone: 'neutral',
    });
  });

  it('automatically: still watching, with the one-line notice of amendment E', () => {
    const text = describeResult(cancelled({ reason: { id: 'sessionResumed', name: 'web-ui' }, stillWatching: true }), OS);
    expect(text.body).toEqual(['web-ui went back to work at 02:13.', 'Still watching. No new countdown for 60 s.']);
    expect(text.oneLine).toBe('Countdown cancelled at 02:13: web-ui went back to work. No new countdown for 60 s.');
  });

  it('automatically, and watching ended with it', () => {
    const text = describeResult(cancelled({ reason: { id: 'emergencyStop' } }), OS);
    expect(text.oneLine).toBe('Cancelled: Emergency stop was set. This PC stays on and is no longer watched.');
  });

  it('names what was cancelled', () => {
    expect(describeResult(cancelled({ countdownKind: 'test' }), OS).title).toBe('TEST RUN STOPPED · PC STAYS ON');
    expect(describeResult(cancelled({ countdownKind: 'preview' }), OS).title).toBe('PREVIEW CANCELLED · PC STAYS ON');
  });

  it('only claims "still watching" on an explicit true', () => {
    for (const junk of GARBAGE.filter((value) => value !== true)) {
      const text = describeResult(cancelled({ stillWatching: junk as boolean }), OS);
      expect(text.body[1]).toBe('Not watching any more.');
    }
  });

  it.each(CANCEL_REASONS.map((reason) => [JSON.stringify(reason), reason] as const))('%s in both outcomes', (_label, reason) => {
    for (const stillWatching of [true, false]) {
      for (const countdownKind of COUNTDOWN_KINDS) {
        const text = describeResult(cancelled({ reason, stillWatching, countdownKind }), OS);
        expect(text.body[0]).toBe(`${cancelReasonText(reason)} at 02:13.`);
        expect(text.tone).toBe('neutral');
        expectPrintable(text);
      }
    }
  });
});

describe('describeResult: stopped (amendment E)', () => {
  it('reads like the wireframe', () => {
    expect(describeResult(stopped(), OS)).toEqual({
      title: 'WATCHING STOPPED · 02:13',
      body: [
        'A setting changed, so watching stopped. Nothing was turned off.',
        'Watching had been on since 23:02 (for real).',
      ],
      oneLine: 'A setting changed, so watching stopped. This PC stays on.',
      tone: 'neutral',
    });
  });

  it.each<[StopCause, string]>([
    ['settingsChanged', 'A setting changed, so watching stopped. Nothing was turned off.'],
    ['timeJump', 'This PC slept and woke up (or its clock changed), so watching stopped. Nothing was turned off.'],
    ['windowClosed', 'The VS Code window that was watching closed and no other window could take over. Nothing was turned off.'],
    [
      'lostControl',
      'The VS Code window that was watching lost control while it was still open ' +
        '(its connection to the other windows ended), so watching stopped. Nothing was turned off.',
    ],
    ['editorRestarted', 'VS Code closed or restarted while watching. Nothing was turned off.'],
    ['user', 'You stopped watching. Nothing was turned off.'],
    ['afterAction', 'Watching ended once the action had run.'],
  ])('%s', (cause, firstLine) => {
    expect(describeResult(stopped({ cause }), OS).body[0]).toBe(firstLine);
  });

  it('covers every cause', () => {
    for (const cause of STOP_CAUSES) {
      for (const wasReal of [true, false]) {
        const text = describeResult(stopped({ cause, wasReal }), OS);
        expect(text.title).toBe('WATCHING STOPPED · 02:13');
        expect(text.body).toHaveLength(2);
        expectPrintable(text);
      }
    }
  });

  it('does not claim nothing was turned off once the action has run', () => {
    const text = describeResult(stopped({ cause: 'afterAction' }), OS);
    expect(JSON.stringify(text)).not.toMatch(/Nothing was turned off|stays on/);
  });

  it('says which mode had been watching, and since when if known', () => {
    expect(describeResult(stopped({ wasReal: false }), OS).body[1]).toBe('Watching had been on since 23:02 (test run).');
    expect(describeResult(stopped({ armedAtMs: null }), OS).body[1]).toBe('Watching had been on (for real).');
  });

  it('calls it a test run only on an explicit false', () => {
    for (const junk of GARBAGE) {
      const text = describeResult(stopped({ wasReal: junk as boolean }), OS);
      expect(text.body[1]).toContain('(for real)');
    }
  });
});

describe('describeResult: every kind, every action, hostile values', () => {
  type Builder = (overrides: Record<string, unknown>) => LastResult;
  const builders = [testPassed, done, failed, cancelled, stopped] as unknown as Builder[];

  it('has a title, a body, a one-liner and a tone for everything', () => {
    for (const build of builders) {
      for (const action of ACTIONS) {
        const text = describeResult(build({ action }), OS);
        expect(text.title).not.toBe('');
        expect(text.title).toBe(text.title.toUpperCase());
        expect(text.body.length).toBeGreaterThan(0);
        expect(text.body.every((line) => line !== '')).toBe(true);
        expect(text.oneLine).not.toBe('');
        expect(['ok', 'neutral', 'error']).toContain(text.tone);
        expectPrintable(text);
      }
    }
  });

  it('drops a time it cannot read instead of printing it', () => {
    for (const junk of GARBAGE) {
      for (const build of builders) {
        const text = describeResult(
          build({
            atMs: junk,
            armedAtMs: junk,
            resumedAtMs: junk,
            lastSessionFinishedAtMs: junk,
            allClearAtMs: junk,
            heldUpBy: junk,
            action: junk,
            message: junk,
            reason: junk,
            cause: junk,
            countdownKind: junk,
            confirmed: junk,
          }),
          junk as string,
        );
        expectPrintable(text);
        expect(text.title).not.toBe('');
        expect(text.body.every((line) => line !== '')).toBe(true);
      }
    }
    expect(describeResult(done({ atMs: NaN }), OS).title).toBe('SHUT DOWN');
    expect(describeResult(done({ atMs: NaN }), OS).body[0]).toBe('This PC shut down because every Claude session had finished.');
    expect(describeResult(testPassed({ atMs: NaN }), OS).body[0]).toBe('This PC would have shut down. Nothing was turned off.');
  });

  it('describes an action it does not know as one that acted', () => {
    const text = describeResult(done({ action: 'restart' as PowerAction }), OS);
    expect(text.title).toBe('RAN AN UNKNOWN ACTION · 02:14');
    expect(text.body[0]).toBe('This PC ran an unknown action at 02:14 because every Claude session had finished.');
  });

  it('survives a result kind it does not know', () => {
    const text = describeResult({ kind: 'paused', atMs: AT } as unknown as LastResult, OS);
    expect(text).toEqual({
      title: 'NOT WATCHING',
      body: ['Not watching. This PC stays on.'],
      oneLine: 'Not watching. This PC stays on.',
      tone: 'neutral',
    });
  });
});
