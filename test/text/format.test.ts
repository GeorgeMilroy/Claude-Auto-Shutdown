import { describe, expect, it } from 'vitest';
import {
  actionWords,
  countdownSeconds,
  fmtClock,
  fmtDuration,
  fmtSetting,
  fmtSpoken,
  fmtTime,
  noSessionNeededText,
  startLabel,
  timingLine,
} from '../../src/shared/text';
import type { ActionWords } from '../../src/shared/text';
import type { PowerAction } from '../../src/shared/config';
import { ACTIONS, GARBAGE, contract, expectPrintable, localMs } from './fixtures';

describe('fmtDuration', () => {
  it.each<[number | null, string]>([
    [0, '0 s'],
    [18, '18 s'],
    [18.9, '18 s'],
    [59, '59 s'],
    [60, '60 s'],
    [90, '90 s'],
    [119, '119 s'],
    [120, '2 min'],
    [240, '4 min'],
    [299, '4 min'],
    [3599, '59 min'],
    [3600, '1 h'],
    [4320, '1 h 12 min'],
    [86_399, '23 h 59 min'],
    [86_400, '1 d'],
    [183_600, '2 d 3 h'],
    [-5, '0 s'],
    [NaN, 'unknown'],
    [Infinity, 'unknown'],
    [-Infinity, 'unknown'],
    [null, 'unknown'],
  ])('%s -> %s', (seconds, expected) => {
    expect(fmtDuration(seconds)).toBe(expected);
  });

  it('treats anything that is not a number as unknown', () => {
    for (const value of [undefined, '300', {}, [], true]) {
      expect(fmtDuration(value as unknown as number)).toBe('unknown');
    }
  });

  it('never tells a 90 s countdown as a minute', () => {
    expect(fmtDuration(contract().countdownSeconds)).toBe('90 s');
  });
});

describe('fmtSetting', () => {
  it.each<[number | null, string]>([
    [15, '15 s'],
    [60, '60 s'],
    [90, '90 s'],
    [120, '2 min'],
    [150, '2 min 30 s'],
    [300, '5 min'],
    [600, '10 min'],
    [3600, '1 h'],
    [3661, '1 h 1 min 1 s'],
    [5400, '1 h 30 min'],
    [7200, '2 h'],
    [-1, '0 s'],
    [NaN, 'unknown'],
    [Infinity, 'unknown'],
    [null, 'unknown'],
  ])('%s -> %s', (seconds, expected) => {
    expect(fmtSetting(seconds)).toBe(expected);
  });
});

describe('countdownSeconds', () => {
  it.each<[number, number]>([
    [87_000, 87],
    [86_400, 87],
    [86_001, 87],
    [1_000, 1],
    [999, 1],
    [1, 1],
    [0, 0],
    [-500, 0],
    [NaN, 0],
    [Infinity, 0],
  ])('%s ms -> %s s: rounded up, so 0:00 shows exactly when no time is left', (ms, seconds) => {
    expect(countdownSeconds(ms)).toBe(seconds);
  });
});

describe('fmtClock', () => {
  it.each<[number, string]>([
    [0, '0:00'],
    [4, '0:04'],
    [59, '0:59'],
    [60, '1:00'],
    [87, '1:27'],
    [87.9, '1:27'],
    [600, '10:00'],
    [3599, '59:59'],
    [3600, '1:00:00'],
    [3725, '1:02:05'],
    [86_400, '24:00:00'],
    [-1, '0:00'],
    [NaN, '0:00'],
    [Infinity, '0:00'],
  ])('%s -> %s', (seconds, expected) => {
    expect(fmtClock(seconds)).toBe(expected);
  });

  it('reads anything that is not a number as 0:00', () => {
    for (const value of [undefined, null, '87', {}]) {
      expect(fmtClock(value as unknown as number)).toBe('0:00');
    }
  });
});

describe('fmtSpoken', () => {
  it.each<[number, string]>([
    [0, '0 seconds'],
    [1, '1 second'],
    [18, '18 seconds'],
    [59, '59 seconds'],
    [60, '1 minute'],
    [61, '1 minute 1 second'],
    [87, '1 minute 27 seconds'],
    [300, '5 minutes'],
    [3599, '59 minutes 59 seconds'],
    [3600, '1 hour'],
    [3725, '1 hour 2 minutes 5 seconds'],
    [86_400, '24 hours'],
    [-3, '0 seconds'],
    [NaN, '0 seconds'],
    [Infinity, '0 seconds'],
  ])('%s -> %s', (seconds, expected) => {
    expect(fmtSpoken(seconds)).toBe(expected);
  });
});

describe('fmtTime', () => {
  it('prints local 24 h time, zero padded', () => {
    expect(fmtTime(localMs(2, 14, 7))).toBe('02:14');
    expect(fmtTime(localMs(23, 2, 59))).toBe('23:02');
    expect(fmtTime(localMs(0, 0, 0))).toBe('00:00');
  });

  it('adds seconds on request', () => {
    expect(fmtTime(localMs(2, 14, 7), true)).toBe('02:14:07');
    expect(fmtTime(localMs(2, 14, 7), false)).toBe('02:14');
  });

  it.each([NaN, Infinity, -Infinity, 8.64e15 + 1])('%s is not a time', (value) => {
    expect(fmtTime(value)).toBe('unknown');
    expect(fmtTime(value, true)).toBe('unknown');
  });

  it('does not coerce other types into a time', () => {
    for (const value of [undefined, null, '1700000000000', {}]) {
      expect(fmtTime(value as unknown as number)).toBe('unknown');
    }
  });
});

describe('actionWords', () => {
  const expected: Record<PowerAction, ActionWords> = {
    shutdown: {
      menu: 'Shut down',
      present: 'shuts down',
      future: 'will shut down',
      wouldHave: 'would have shut down',
      gerund: 'Shutting down',
      past: 'shut down',
      verb: 'shut down',
    },
    hibernate: {
      menu: 'Hibernate',
      present: 'hibernates',
      future: 'will hibernate',
      wouldHave: 'would have hibernated',
      gerund: 'Hibernating',
      past: 'hibernated',
      verb: 'hibernate',
    },
    sleep: {
      menu: 'Sleep',
      present: 'goes to sleep',
      future: 'will go to sleep',
      wouldHave: 'would have gone to sleep',
      gerund: 'Going to sleep',
      past: 'went to sleep',
      verb: 'sleep',
    },
    lock: {
      menu: 'Lock',
      present: 'locks',
      future: 'will lock',
      wouldHave: 'would have locked',
      gerund: 'Locking',
      past: 'was locked',
      verb: 'lock',
    },
    notify: {
      menu: 'Just notify me',
      present: 'notifies you',
      future: 'will notify you',
      wouldHave: 'would have notified you',
      gerund: '',
      past: 'notified you',
      verb: 'notify',
    },
  };

  it.each(ACTIONS)('%s', (action) => {
    expect(actionWords(action)).toEqual(expected[action]);
  });

  it('only "Just notify me" has no gerund', () => {
    for (const action of ACTIONS) {
      expect(actionWords(action).gerund === '').toBe(action === 'notify');
    }
  });

  it('describes an action it does not know as one that acts, never as a message', () => {
    for (const value of ['restart', '', undefined, null, 7]) {
      const words = actionWords(value as unknown as PowerAction);
      expectPrintable(words);
      expect(words.menu).toBe('Unknown action');
      expect(words.future).toBe('will run an unknown action');
      expect(words.gerund).not.toBe('');
    }
  });
});

describe('timingLine', () => {
  it('adds quiet time, the re-checks and the countdown', () => {
    expect(timingLine(contract())).toBe("About 7 min after the last session finishes, once you've been away 10 min.");
  });

  it('says so when you need not be away', () => {
    expect(timingLine(contract({ requireUserIdle: false }))).toBe(
      "About 7 min after the last session finishes. You don't need to be away.",
    );
  });

  it('leaves the countdown out for "Just notify me"', () => {
    expect(timingLine(contract({ action: 'notify', requireUserIdle: false }))).toBe(
      "About 6 min after the last session finishes. You don't need to be away.",
    );
  });

  it('keeps short totals in seconds and odd away times exact', () => {
    const quick = contract({ quietSeconds: 30, pollSeconds: 5, requiredPolls: 2, countdownSeconds: 15, userIdleSeconds: 150 });
    expect(timingLine(quick)).toBe("About 55 s after the last session finishes, once you've been away 2 min 30 s.");
  });

  it('never prints a broken number', () => {
    for (const value of GARBAGE) {
      const broken = contract({
        quietSeconds: value as number,
        pollSeconds: value as number,
        countdownSeconds: value as number,
        userIdleSeconds: value as number,
      });
      expectPrintable(timingLine(broken));
    }
    expect(timingLine(contract({ quietSeconds: NaN, userIdleSeconds: NaN }))).toBe(
      "Some time after the last session finishes, once you've been away long enough.",
    );
  });
});

describe('noSessionNeededText', () => {
  it('is null only for rules that wait for a session to appear and finish', () => {
    expect(noSessionNeededText(contract({ allowWhenNoSessions: false }))).toBeNull();
  });

  it('says this PC can act without any session, and when', () => {
    expect(noSessionNeededText(contract({ allowWhenNoSessions: true, testMode: false }))).toBe(
      'No Claude session needed: with your settings this PC can shut down even if none ever appears. ' +
        "About 2 min after you start, once you've been away 10 min.",
    );
    expect(noSessionNeededText(contract({ allowWhenNoSessions: true, testMode: false, action: 'sleep', requireUserIdle: false }))).toBe(
      'No Claude session needed: with your settings this PC can go to sleep even if none ever appears. ' +
        "About 2 min after you start. You don't need to be away.",
    );
  });

  it('a test run passes, and a message comes, without one', () => {
    expect(noSessionNeededText(contract({ allowWhenNoSessions: true, testMode: true }))).toMatch(
      /^No Claude session needed: with your settings this test run can pass even if none ever appears. /,
    );
    expect(noSessionNeededText(contract({ allowWhenNoSessions: true, action: 'notify', requireUserIdle: false }))).toBe(
      'No Claude session needed: with your settings this PC can notify you even if none ever appears. ' +
        "About 30 s after you start. You don't need to be away.",
    );
  });

  it('reads a setting it cannot read as the one in which this PC may act', () => {
    for (const value of GARBAGE.filter((candidate) => candidate !== false)) {
      const text = noSessionNeededText(contract({ allowWhenNoSessions: value as boolean, pollSeconds: value as number }));
      expect(text).toMatch(/^No Claude session needed/);
      expectPrintable(text ?? '');
    }
  });
});

describe('startLabel', () => {
  it('starts a test run in test mode, whatever the action', () => {
    for (const action of ACTIONS.filter((candidate) => candidate !== 'notify')) {
      expect(startLabel(contract({ action, testMode: true }))).toBe('Start test run');
    }
  });

  it.each<[PowerAction, string]>([
    ['shutdown', 'Shut down when Claude finishes…'],
    ['hibernate', 'Hibernate when Claude finishes…'],
    ['sleep', 'Sleep when Claude finishes…'],
    ['lock', 'Lock when Claude finishes…'],
  ])('for real, %s names the consequence', (action, expected) => {
    expect(startLabel(contract({ action, testMode: false }))).toBe(expected);
  });

  it('is a plain notification for "Just notify me" in either mode', () => {
    expect(startLabel(contract({ action: 'notify', testMode: true }))).toBe('Notify me when Claude finishes');
    expect(startLabel(contract({ action: 'notify', testMode: false }))).toBe('Notify me when Claude finishes');
  });

  it('does not call a run a test unless testMode is exactly true', () => {
    for (const value of GARBAGE.filter((candidate) => candidate !== true)) {
      expect(startLabel(contract({ testMode: value as boolean }))).toBe('Shut down when Claude finishes…');
    }
  });
});
