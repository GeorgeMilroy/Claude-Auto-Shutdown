import { describe, expect, it } from 'vitest';

import { evaluate } from '../../src/core/evaluate';
import type { ChildProcessInfo } from '../../src/core/types';
import {
  CHECK_ORDER,
  cantTellSession,
  child,
  contract,
  dataOf,
  ids,
  illTyped,
  input,
  justFinishedSession,
  remoteWindow,
  scan,
  session,
  stateOf,
  stray,
  unmet,
  workingSession,
} from './fixtures';

describe('baseline', () => {
  it('passes every check for a finished session, a clear PC and a user who is away', () => {
    const verdict = evaluate(input());
    expect(unmet(verdict)).toEqual([]);
    expect(verdict.ok).toBe(true);
  });

  it('emits the default checks in the documented order', () => {
    expect(ids(evaluate(input()))).toEqual([
      'armed',
      'stopFile',
      'scanner',
      'helper',
      'actionAllowed',
      'registry',
      'unclaimedTranscripts',
      'sessionsIdle',
      'turnsClosed',
      'quiet',
      'childProcesses',
      'userIdle',
      'confirmed',
    ]);
  });

  it('emits all sixteen checks in the documented order when every optional one applies', () => {
    const noSessions = evaluate(
      input({
        contract: contract({ guardProcesses: ['ffmpeg'] }),
        remoteWindows: [remoteWindow()],
        scan: scan({ sessions: [] }),
      }),
    );
    const withSessions = evaluate(
      input({ contract: contract({ guardProcesses: ['ffmpeg'] }), remoteWindows: [remoteWindow()] }),
    );
    // `hasSessions` and `quiet` exclude each other: one needs zero sessions, the other at least one.
    expect(ids(noSessions)).toEqual(CHECK_ORDER.filter((id) => id !== 'quiet'));
    expect(ids(withSessions)).toEqual(CHECK_ORDER.filter((id) => id !== 'hasSessions'));
  });
});

describe('armed', () => {
  it('passes while watching', () => {
    expect(stateOf(evaluate(input({ armed: true })), 'armed')).toBe('pass');
  });

  it('waits while not watching', () => {
    const verdict = evaluate(input({ armed: false }));
    expect(stateOf(verdict, 'armed')).toBe('waiting');
    expect(dataOf(verdict, 'armed')).toEqual({});
  });

  it("can't tell from a value that is not a boolean", () => {
    expect(stateOf(evaluate(input({ armed: illTyped('true') })), 'armed')).toBe('cantTell');
  });
});

describe('stopFile', () => {
  it('passes when no Emergency stop is set', () => {
    const verdict = evaluate(input({ stopPresent: false }));
    expect(stateOf(verdict, 'stopFile')).toBe('pass');
    expect(dataOf(verdict, 'stopFile')).toEqual({});
  });

  it('fails when the Emergency stop is set', () => {
    expect(stateOf(evaluate(input({ stopPresent: true })), 'stopFile')).toBe('fail');
  });

  it("can't tell from a falsy value that is not `false`", () => {
    expect(stateOf(evaluate(input({ stopPresent: illTyped(0) })), 'stopFile')).toBe('cantTell');
    expect(stateOf(evaluate(input({ stopPresent: illTyped(undefined) })), 'stopFile')).toBe('cantTell');
  });
});

describe('scanner', () => {
  it('passes for a fresh scan without errors', () => {
    const verdict = evaluate(input());
    expect(stateOf(verdict, 'scanner')).toBe('pass');
    expect(dataOf(verdict, 'scanner')).toEqual({ reason: null, errors: [], roots: 1 });
  });

  it("can't tell before the first scan", () => {
    const verdict = evaluate(input({ scan: null }));
    expect(stateOf(verdict, 'scanner')).toBe('cantTell');
    expect(dataOf(verdict, 'scanner')).toEqual({ reason: 'noScan', errors: [], roots: null });
  });

  it("can't tell from a stale scan", () => {
    const verdict = evaluate(input({ scanStale: true }));
    expect(stateOf(verdict, 'scanner')).toBe('cantTell');
    expect(dataOf(verdict, 'scanner')).toEqual({ reason: 'stale', errors: [], roots: 1 });
  });

  it("can't tell when the scan reported errors", () => {
    const errors = ['Cannot read C:\\fixture\\.claude\\sessions\\12.json: not JSON.', 'WSL: Ubuntu did not answer.'];
    const verdict = evaluate(input({ scan: scan({ errors }) }));
    expect(stateOf(verdict, 'scanner')).toBe('cantTell');
    expect(dataOf(verdict, 'scanner')).toEqual({ reason: 'errors', errors, roots: 1 });
  });

  it('reports the first reason that applies: no scan, then stale, then errors', () => {
    expect(dataOf(evaluate(input({ scan: null, scanStale: true })), 'scanner')?.reason).toBe('noScan');
    expect(dataOf(evaluate(input({ scan: scan({ errors: ['x'] }), scanStale: true })), 'scanner')?.reason).toBe('stale');
  });

  it('counts the roots that were scanned', () => {
    const root = scan().roots[0]!;
    const verdict = evaluate(input({ scan: scan({ roots: [root, { ...root, label: 'WSL: Ubuntu', kind: 'foreign' }] }) }));
    expect(dataOf(verdict, 'scanner')?.roots).toBe(2);
  });

  it('treats a result that is not shaped like a scan as an error, and as no scan everywhere else', () => {
    const verdict = evaluate(input({ scan: illTyped({ sessions: 'none' }) }));
    expect(stateOf(verdict, 'scanner')).toBe('cantTell');
    expect(dataOf(verdict, 'scanner')).toEqual({
      reason: 'errors',
      errors: ['The last check returned a result that cannot be read.'],
      roots: null,
    });
    expect(stateOf(verdict, 'sessionsIdle')).toBe('cantTell');
    expect(stateOf(verdict, 'registry')).toBe('cantTell');
  });

  it('keeps an error that is not text as a blocking error', () => {
    const verdict = evaluate(input({ scan: scan({ errors: illTyped([42]) }) }));
    expect(stateOf(verdict, 'scanner')).toBe('cantTell');
    expect(dataOf(verdict, 'scanner')?.errors).toEqual(['A problem was reported without a readable description.']);
  });
});

describe('helper', () => {
  it('passes with a full helper and a readable process list', () => {
    const verdict = evaluate(input());
    expect(stateOf(verdict, 'helper')).toBe('pass');
    expect(dataOf(verdict, 'helper')).toEqual({ problem: null, tier: 'full' });
  });

  it('passes in the limited tier and shows why it is limited', () => {
    const helperProblem = 'Idle time is not available on this desktop.';
    const verdict = evaluate(input({ helperTier: 'limited', scan: scan({ helperProblem }) }));
    expect(stateOf(verdict, 'helper')).toBe('pass');
    expect(dataOf(verdict, 'helper')).toEqual({ problem: helperProblem, tier: 'limited' });
  });

  it('fails on an environment problem', () => {
    const environmentProblem = "VS Code runs inside Flatpak, so other programs on this PC can't be seen.";
    const verdict = evaluate(input({ environmentProblem, scan: scan({ helperProblem: 'something lesser' }) }));
    expect(stateOf(verdict, 'helper')).toBe('fail');
    expect(dataOf(verdict, 'helper')).toEqual({ problem: environmentProblem, tier: 'full' });
  });

  it('fails when the helper is unavailable', () => {
    const helperProblem = 'The helper did not start.';
    const verdict = evaluate(input({ helperTier: 'unavailable', scan: scan({ helperProblem }) }));
    expect(stateOf(verdict, 'helper')).toBe('fail');
    expect(dataOf(verdict, 'helper')).toEqual({ problem: helperProblem, tier: 'unavailable' });
  });

  it("can't tell when the scan could not list processes", () => {
    expect(stateOf(evaluate(input({ scan: scan({ processListOk: false }) })), 'helper')).toBe('cantTell');
  });

  it('judges only the platform before the first scan', () => {
    expect(stateOf(evaluate(input({ scan: null })), 'helper')).toBe('pass');
    expect(stateOf(evaluate(input({ scan: null, helperTier: 'unavailable' })), 'helper')).toBe('fail');
  });

  it("can't tell from an unknown tier or an empty problem", () => {
    const unknownTier = evaluate(input({ helperTier: illTyped('turbo') }));
    expect(stateOf(unknownTier, 'helper')).toBe('cantTell');
    expect(dataOf(unknownTier, 'helper')?.tier).toBeNull();
    expect(stateOf(evaluate(input({ environmentProblem: '' })), 'helper')).toBe('cantTell');
  });
});

describe('actionAllowed', () => {
  it('passes when the preflight says the action can run', () => {
    const verdict = evaluate(input());
    expect(stateOf(verdict, 'actionAllowed')).toBe('pass');
    expect(dataOf(verdict, 'actionAllowed')).toEqual({ action: 'shutdown', detail: 'Allowed by Windows' });
  });

  it('fails when the preflight says it cannot', () => {
    const detail = 'Hibernation is turned off on this PC';
    const verdict = evaluate(input({ contract: contract({ action: 'hibernate' }), capability: { ok: false, detail } }));
    expect(stateOf(verdict, 'actionAllowed')).toBe('fail');
    expect(dataOf(verdict, 'actionAllowed')).toEqual({ action: 'hibernate', detail });
  });

  it("can't tell before the preflight ran", () => {
    const verdict = evaluate(input({ capability: null }));
    expect(stateOf(verdict, 'actionAllowed')).toBe('cantTell');
    expect(dataOf(verdict, 'actionAllowed')).toEqual({ action: 'shutdown', detail: null });
  });

  it("can't tell when the preflight could not find out", () => {
    const verdict = evaluate(input({ capability: { ok: null, detail: 'busctl is not installed' } }));
    expect(stateOf(verdict, 'actionAllowed')).toBe('cantTell');
    expect(dataOf(verdict, 'actionAllowed')?.detail).toBe('busctl is not installed');
  });

  it('always passes for notify, which does nothing to this PC', () => {
    const notify = contract({ action: 'notify' });
    expect(stateOf(evaluate(input({ contract: notify, capability: null })), 'actionAllowed')).toBe('pass');
    expect(stateOf(evaluate(input({ contract: notify, capability: { ok: false, detail: 'n/a' } })), 'actionAllowed')).toBe(
      'pass',
    );
  });

  it("can't tell for an action it does not know", () => {
    const verdict = evaluate(input({ contract: { ...contract(), action: illTyped('reboot') } }));
    expect(stateOf(verdict, 'actionAllowed')).toBe('cantTell');
    expect(dataOf(verdict, 'actionAllowed')?.action).toBeNull();
  });
});

describe('remoteWindows', () => {
  it('is omitted when no remote window is open', () => {
    expect(stateOf(evaluate(input({ remoteWindows: [] })), 'remoteWindows')).toBe('omitted');
  });

  it("can't tell while a remote window is neither covered nor waived", () => {
    const verdict = evaluate(
      input({
        remoteWindows: [
          remoteWindow({ name: 'SSH: build-box' }),
          remoteWindow({ name: 'WSL: Ubuntu', covered: true }),
          remoteWindow({ name: 'Dev Container', ignored: true }),
        ],
      }),
    );
    expect(stateOf(verdict, 'remoteWindows')).toBe('cantTell');
    expect(dataOf(verdict, 'remoteWindows')).toEqual({
      blocking: ['SSH: build-box'],
      ignored: ['Dev Container'],
      covered: ['WSL: Ubuntu'],
    });
    expect(verdict.allClear).toBe(false);
  });

  it('passes when every remote window is covered or waived', () => {
    const verdict = evaluate(
      input({
        remoteWindows: [
          remoteWindow({ name: 'WSL: Ubuntu', covered: true }),
          remoteWindow({ name: 'Dev Container', ignored: true }),
          remoteWindow({ name: 'WSL: Debian', covered: true, ignored: true }),
        ],
      }),
    );
    expect(stateOf(verdict, 'remoteWindows')).toBe('pass');
    expect(dataOf(verdict, 'remoteWindows')).toEqual({
      blocking: [],
      ignored: ['Dev Container'],
      covered: ['WSL: Ubuntu', 'WSL: Debian'],
    });
    expect(verdict.ok).toBe(true);
  });

  it("can't tell from a list that is not a list", () => {
    const verdict = evaluate(input({ remoteWindows: illTyped(undefined) }));
    expect(stateOf(verdict, 'remoteWindows')).toBe('cantTell');
    expect(dataOf(verdict, 'remoteWindows')).toEqual({ blocking: [], ignored: [], covered: [] });
  });
});

describe('registry', () => {
  it('passes when no unregistered Claude process is running', () => {
    const verdict = evaluate(input());
    expect(stateOf(verdict, 'registry')).toBe('pass');
    expect(dataOf(verdict, 'registry')).toEqual({ reason: null, pids: [], names: [], strays: 0 });
  });

  it('passes when every unregistered process is accounted for or waived', () => {
    const strays = [stray({ pid: 9001, accounted: true }), stray({ pid: 9002, ignored: true })];
    const verdict = evaluate(input({ scan: scan({ strays }) }));
    expect(stateOf(verdict, 'registry')).toBe('pass');
    expect(dataOf(verdict, 'registry')).toEqual({ reason: null, pids: [], names: [], strays: 2 });
  });

  it("can't tell while a process is neither accounted for nor waived", () => {
    const strays = [stray({ pid: 9001, accounted: true }), stray({ pid: 9003, name: 'claude' }), stray({ pid: 9004, name: 'node' })];
    const verdict = evaluate(input({ scan: scan({ strays }) }));
    expect(stateOf(verdict, 'registry')).toBe('cantTell');
    expect(dataOf(verdict, 'registry')).toEqual({
      reason: 'unaccounted',
      pids: [9003, 9004],
      names: ['claude', 'node'],
      strays: 3,
    });
  });

  it("can't tell without a process list", () => {
    const verdict = evaluate(input({ scan: scan({ strays: null }) }));
    expect(stateOf(verdict, 'registry')).toBe('cantTell');
    expect(dataOf(verdict, 'registry')).toEqual({ reason: 'noProcessList', pids: [], names: [], strays: null });
  });

  it("can't tell before the first scan", () => {
    const verdict = evaluate(input({ scan: null }));
    expect(stateOf(verdict, 'registry')).toBe('cantTell');
    expect(dataOf(verdict, 'registry')?.reason).toBe('noProcessList');
  });
});

describe('unclaimedTranscripts', () => {
  it('passes when no unclaimed transcript was written recently', () => {
    const verdict = evaluate(input());
    expect(stateOf(verdict, 'unclaimedTranscripts')).toBe('pass');
    expect(dataOf(verdict, 'unclaimedTranscripts')).toEqual({ count: 0, project: null, secondsAgo: null, quietSeconds: 300 });
  });

  it('waits while one was, and describes the newest', () => {
    const unclaimedRecent = [
      { path: 'C:\\fixture\\.claude\\projects\\old\\a.jsonl', project: 'old', mtimeMs: 1_790_000_900_000, secondsAgo: 100 },
      { path: 'C:\\fixture\\.claude\\projects\\new\\b.jsonl', project: 'new', mtimeMs: 1_790_000_982_000, secondsAgo: 18 },
      { path: 'C:\\fixture\\.claude\\projects\\mid\\c.jsonl', project: 'mid', mtimeMs: 1_790_000_940_000, secondsAgo: 60 },
    ];
    const verdict = evaluate(input({ scan: scan({ unclaimedRecent }) }));
    expect(stateOf(verdict, 'unclaimedTranscripts')).toBe('waiting');
    expect(dataOf(verdict, 'unclaimedTranscripts')).toEqual({ count: 3, project: 'new', secondsAgo: 18, quietSeconds: 300 });
    expect(verdict.allClear).toBe(false);
  });

  it("can't tell before the first scan", () => {
    const verdict = evaluate(input({ scan: null }));
    expect(stateOf(verdict, 'unclaimedTranscripts')).toBe('cantTell');
    expect(dataOf(verdict, 'unclaimedTranscripts')).toEqual({
      count: null,
      project: null,
      secondsAgo: null,
      quietSeconds: 300,
    });
  });
});

describe('hasSessions (the zero-session rule)', () => {
  const noSessions = scan({ sessions: [] });

  it('is omitted while there are sessions', () => {
    expect(stateOf(evaluate(input()), 'hasSessions')).toBe('omitted');
  });

  it('is omitted before the first scan', () => {
    expect(stateOf(evaluate(input({ scan: null })), 'hasSessions')).toBe('omitted');
  });

  it('waits when no session was ever seen', () => {
    const verdict = evaluate(input({ scan: noSessions, sawAnySession: false, secondsSinceLastSession: null }));
    expect(stateOf(verdict, 'hasSessions')).toBe('waiting');
    expect(dataOf(verdict, 'hasSessions')).toEqual({ sawAny: false, secondsSinceLast: null, quietSeconds: 300 });
    expect(verdict.ok).toBe(false);
  });

  it('waits while the last session ended less than the quiet time ago', () => {
    const verdict = evaluate(input({ scan: noSessions, sawAnySession: true, secondsSinceLastSession: 299.9 }));
    expect(stateOf(verdict, 'hasSessions')).toBe('waiting');
    expect(dataOf(verdict, 'hasSessions')).toEqual({ sawAny: true, secondsSinceLast: 299.9, quietSeconds: 300 });
  });

  it('passes once the last session ended at least the quiet time ago', () => {
    const verdict = evaluate(input({ scan: noSessions, sawAnySession: true, secondsSinceLastSession: 300 }));
    expect(stateOf(verdict, 'hasSessions')).toBe('pass');
    expect(verdict.ok).toBe(true);
  });

  it('passes without ever seeing a session when the contract allows it', () => {
    const verdict = evaluate(
      input({
        contract: contract({ allowWhenNoSessions: true }),
        scan: noSessions,
        sawAnySession: false,
        secondsSinceLastSession: null,
      }),
    );
    expect(stateOf(verdict, 'hasSessions')).toBe('pass');
    expect(dataOf(verdict, 'hasSessions')).toEqual({ sawAny: false, secondsSinceLast: null, quietSeconds: 300 });
    expect(verdict.ok).toBe(true);
  });

  it("can't tell when a session was seen but not when it ended", () => {
    const verdict = evaluate(input({ scan: noSessions, sawAnySession: true, secondsSinceLastSession: null }));
    expect(stateOf(verdict, 'hasSessions')).toBe('cantTell');
  });

  it('does not let "false" (a truthy string) allow the action', () => {
    const verdict = evaluate(
      input({
        contract: { ...contract(), allowWhenNoSessions: illTyped('false') },
        scan: noSessions,
        sawAnySession: false,
        secondsSinceLastSession: null,
      }),
    );
    expect(stateOf(verdict, 'hasSessions')).toBe('cantTell');
    expect(verdict.ok).toBe(false);
  });

  it('leaves the session checks passing and omits the quiet check', () => {
    const verdict = evaluate(input({ scan: noSessions, sawAnySession: true, secondsSinceLastSession: 900 }));
    expect(stateOf(verdict, 'sessionsIdle')).toBe('pass');
    expect(stateOf(verdict, 'turnsClosed')).toBe('pass');
    expect(stateOf(verdict, 'quiet')).toBe('omitted');
  });
});

describe('sessionsIdle', () => {
  it('passes when no session is working', () => {
    const verdict = evaluate(input({ scan: scan({ sessions: [session(), session({ name: 'second' })] }) }));
    expect(stateOf(verdict, 'sessionsIdle')).toBe('pass');
    expect(dataOf(verdict, 'sessionsIdle')).toEqual({ total: 2, working: 0, cantTell: 0, ignored: 0, names: [] });
  });

  it('waits while a session is working or has only just finished', () => {
    const sessions = [workingSession(), justFinishedSession(), session()];
    const verdict = evaluate(input({ scan: scan({ sessions }) }));
    expect(stateOf(verdict, 'sessionsIdle')).toBe('waiting');
    expect(dataOf(verdict, 'sessionsIdle')).toEqual({
      total: 3,
      working: 2,
      cantTell: 0,
      ignored: 0,
      names: ['api', 'docs'],
    });
  });

  it("can't tell while a blocking session's status is can't tell", () => {
    const sessions = [cantTellSession(), workingSession(), session()];
    const verdict = evaluate(input({ scan: scan({ sessions }) }));
    expect(stateOf(verdict, 'sessionsIdle')).toBe('cantTell');
    expect(dataOf(verdict, 'sessionsIdle')).toEqual({
      total: 3,
      working: 1,
      cantTell: 1,
      ignored: 0,
      names: ['scratch', 'api'],
    });
  });

  it("can't tell before the first scan", () => {
    const verdict = evaluate(input({ scan: null }));
    expect(stateOf(verdict, 'sessionsIdle')).toBe('cantTell');
    expect(dataOf(verdict, 'sessionsIdle')).toEqual({ total: null, working: null, cantTell: null, ignored: null, names: [] });
  });

  it('does not wait for ignored sessions, but counts them', () => {
    const sessions = [workingSession({ ignored: true }), cantTellSession({ ignored: true }), session()];
    const verdict = evaluate(input({ scan: scan({ sessions }) }));
    expect(stateOf(verdict, 'sessionsIdle')).toBe('pass');
    expect(dataOf(verdict, 'sessionsIdle')).toEqual({ total: 3, working: 0, cantTell: 0, ignored: 2, names: [] });
    expect(verdict.ok).toBe(true);
  });

  it('still waits for the sessions that are not ignored', () => {
    const sessions = [workingSession({ ignored: true }), workingSession({ name: 'worker' })];
    const verdict = evaluate(input({ scan: scan({ sessions }) }));
    expect(stateOf(verdict, 'sessionsIdle')).toBe('waiting');
    expect(dataOf(verdict, 'sessionsIdle')).toEqual({ total: 2, working: 1, cantTell: 0, ignored: 1, names: ['worker'] });
  });

  it("treats a session whose `working` flag is unreadable as can't tell", () => {
    const sessions = [session({ working: illTyped(0) })];
    const verdict = evaluate(input({ scan: scan({ sessions }) }));
    expect(stateOf(verdict, 'sessionsIdle')).toBe('cantTell');
    expect(dataOf(verdict, 'sessionsIdle')).toMatchObject({ working: 0, cantTell: 1, names: ['web-ui'] });
  });
});

describe('turnsClosed', () => {
  it('passes when every turn ended', () => {
    const verdict = evaluate(input());
    expect(stateOf(verdict, 'turnsClosed')).toBe('pass');
    expect(dataOf(verdict, 'turnsClosed')).toEqual({ names: [], reasons: [] });
  });

  it('waits while a turn is open', () => {
    const sessions = [session(), workingSession(), workingSession({ name: 'reader', turnReason: 'readingToolResult' })];
    const verdict = evaluate(input({ scan: scan({ sessions }) }));
    expect(stateOf(verdict, 'turnsClosed')).toBe('waiting');
    expect(dataOf(verdict, 'turnsClosed')).toEqual({
      names: ['api', 'reader'],
      reasons: ['toolInFlight', 'readingToolResult'],
    });
  });

  it("can't tell while a turn is unknown, even next to an open one", () => {
    const sessions = [workingSession(), cantTellSession()];
    const verdict = evaluate(input({ scan: scan({ sessions }) }));
    expect(stateOf(verdict, 'turnsClosed')).toBe('cantTell');
    expect(dataOf(verdict, 'turnsClosed')).toEqual({
      names: ['api', 'scratch'],
      reasons: ['toolInFlight', 'noTranscript'],
    });
  });

  it("can't tell before the first scan", () => {
    const verdict = evaluate(input({ scan: null }));
    expect(stateOf(verdict, 'turnsClosed')).toBe('cantTell');
    expect(dataOf(verdict, 'turnsClosed')).toEqual({ names: [], reasons: [] });
  });

  it('does not wait for the open or unknown turn of an ignored session', () => {
    const sessions = [workingSession({ ignored: true }), cantTellSession({ ignored: true }), session()];
    const verdict = evaluate(input({ scan: scan({ sessions }) }));
    expect(stateOf(verdict, 'turnsClosed')).toBe('pass');
    expect(dataOf(verdict, 'turnsClosed')).toEqual({ names: [], reasons: [] });
  });

  it('blocks on an unknown turn even when the scanner called the session finished', () => {
    const sessions = [session({ turn: 'UNKNOWN', turnReason: 'cannotRead' })];
    const verdict = evaluate(input({ scan: scan({ sessions }) }));
    expect(stateOf(verdict, 'sessionsIdle')).toBe('pass');
    expect(stateOf(verdict, 'turnsClosed')).toBe('cantTell');
    expect(verdict.allClear).toBe(false);
  });
});

describe('quiet', () => {
  it('is omitted without sessions, when every session is ignored, and before the first scan', () => {
    expect(stateOf(evaluate(input({ scan: scan({ sessions: [] }) })), 'quiet')).toBe('omitted');
    expect(stateOf(evaluate(input({ scan: scan({ sessions: [workingSession({ ignored: true })] }) })), 'quiet')).toBe(
      'omitted',
    );
    expect(stateOf(evaluate(input({ scan: null })), 'quiet')).toBe('omitted');
  });

  it('passes when the quietest session has been quiet for exactly the target', () => {
    const sessions = [session({ name: 'long', silenceSeconds: 4000 }), session({ name: 'edge', silenceSeconds: 300 })];
    const verdict = evaluate(input({ scan: scan({ sessions }) }));
    expect(stateOf(verdict, 'quiet')).toBe('pass');
    expect(dataOf(verdict, 'quiet')).toEqual({ quietestSeconds: 300, name: 'edge', quietSeconds: 300 });
  });

  it('waits while the quietest session is short of the target', () => {
    const sessions = [session({ name: 'long', silenceSeconds: 4000 }), session({ name: 'fresh', silenceSeconds: 299.5 })];
    const verdict = evaluate(input({ scan: scan({ sessions }) }));
    expect(stateOf(verdict, 'quiet')).toBe('waiting');
    expect(dataOf(verdict, 'quiet')).toEqual({ quietestSeconds: 299.5, name: 'fresh', quietSeconds: 300 });
    expect(verdict.allClear).toBe(false);
  });

  it('waits on a write time slightly in the future (clock skew), which is finite and below the target', () => {
    const verdict = evaluate(input({ scan: scan({ sessions: [session({ silenceSeconds: -2 })] }) }));
    expect(stateOf(verdict, 'quiet')).toBe('waiting');
  });

  it("can't tell when any session's silence is unknown", () => {
    const sessions = [session({ name: 'long', silenceSeconds: 4000 }), session({ name: 'mystery', silenceSeconds: null })];
    const verdict = evaluate(input({ scan: scan({ sessions }) }));
    expect(stateOf(verdict, 'quiet')).toBe('cantTell');
    expect(dataOf(verdict, 'quiet')).toEqual({ quietestSeconds: null, name: 'mystery', quietSeconds: 300 });
  });

  it('judges only the sessions that are not ignored', () => {
    const sessions = [
      workingSession({ ignored: true, silenceSeconds: 3 }),
      cantTellSession({ ignored: true }),
      session({ name: 'done', silenceSeconds: 700 }),
    ];
    const verdict = evaluate(input({ scan: scan({ sessions }) }));
    expect(stateOf(verdict, 'quiet')).toBe('pass');
    expect(dataOf(verdict, 'quiet')).toEqual({ quietestSeconds: 700, name: 'done', quietSeconds: 300 });
  });

  it("can't tell against a quiet target below the settings' floor", () => {
    const verdict = evaluate(input({ contract: { ...contract(), quietSeconds: 5 } }));
    expect(stateOf(verdict, 'quiet')).toBe('cantTell');
    expect(dataOf(verdict, 'quiet')).toEqual({ quietestSeconds: 900, name: 'web-ui', quietSeconds: null });
  });
});

describe('childProcesses', () => {
  it('is omitted when the contract does not wait for child processes', () => {
    const sessions = [session({ children: [child()] })];
    const verdict = evaluate(input({ contract: contract({ waitForChildProcesses: false }), scan: scan({ sessions }) }));
    expect(stateOf(verdict, 'childProcesses')).toBe('omitted');
    expect(verdict.ok).toBe(true);
  });

  it('is omitted before the first scan', () => {
    expect(stateOf(evaluate(input({ scan: null })), 'childProcesses')).toBe('omitted');
  });

  it('passes when no session has a busy child', () => {
    const sessions = [session({ children: [] }), session({ name: 'second', children: [child({ busy: false })] })];
    const verdict = evaluate(input({ scan: scan({ sessions }) }));
    expect(stateOf(verdict, 'childProcesses')).toBe('pass');
    expect(dataOf(verdict, 'childProcesses')).toEqual({ items: [] });
  });

  it('waits while a session has a busy child, and names it', () => {
    const sessions = [
      session({ children: [child({ pid: 7001, name: 'npm' }), child({ pid: 7002, name: 'cargo' })] }),
      session({ name: 'api', children: [child({ pid: 7003, name: 'pytest' })] }),
    ];
    const verdict = evaluate(input({ scan: scan({ sessions }) }));
    expect(stateOf(verdict, 'childProcesses')).toBe('waiting');
    expect(dataOf(verdict, 'childProcesses')).toEqual({
      items: ['npm (PID 7001) started by web-ui', 'cargo (PID 7002) started by web-ui', 'pytest (PID 7003) started by api'],
    });
    expect(verdict.allClear).toBe(false);
  });

  it('does not wait for an ignored child, or for the children of an ignored session', () => {
    const sessions = [
      session({ children: [child({ ignored: true })] }),
      workingSession({ ignored: true, children: [child({ pid: 7005 })] }),
    ];
    const verdict = evaluate(input({ scan: scan({ sessions }) }));
    expect(stateOf(verdict, 'childProcesses')).toBe('pass');
    expect(verdict.ok).toBe(true);
  });

  it("can't tell when the setting is neither on nor off, instead of dropping the check", () => {
    const verdict = evaluate(input({ contract: { ...contract(), waitForChildProcesses: illTyped(undefined) } }));
    expect(stateOf(verdict, 'childProcesses')).toBe('cantTell');
  });

  it("can't tell when a session's child list is unreadable", () => {
    const sessions = [session({ children: illTyped(null) })];
    expect(stateOf(evaluate(input({ scan: scan({ sessions }) })), 'childProcesses')).toBe('cantTell');
  });

  describe('of an unregistered Claude process', () => {
    it('waits while it has a busy child, and names both', () => {
      const strays = [stray({ pid: 9001, accounted: true, children: [child({ pid: 7200, name: 'node' })] })];
      const verdict = evaluate(input({ scan: scan({ strays }) }));
      expect(stateOf(verdict, 'childProcesses')).toBe('waiting');
      expect(dataOf(verdict, 'childProcesses')).toEqual({ items: ['node (PID 7200) started by an unmatched Claude process (PID 9001)'] });
      expect(verdict.ok).toBe(false);
    });

    it('waits for them even when the process itself is waived', () => {
      const strays = [stray({ pid: 9002, ignored: true, children: [child({ pid: 7300, name: 'cargo' })] })];
      const verdict = evaluate(input({ scan: scan({ strays, sessions: [] }), secondsSinceLastSession: 900 }));
      expect(stateOf(verdict, 'registry')).toBe('pass');
      expect(stateOf(verdict, 'childProcesses')).toBe('waiting');
      expect(verdict.ok).toBe(false);
    });

    it('does not wait for a child that is idle or waived', () => {
      const strays = [stray({ ignored: true, children: [child({ busy: false }), child({ pid: 7002, ignored: true })] })];
      const verdict = evaluate(input({ scan: scan({ strays }) }));
      expect(stateOf(verdict, 'childProcesses')).toBe('pass');
      expect(verdict.ok).toBe(true);
    });

    it("can't tell when its child list or a child's state is unreadable", () => {
      for (const children of [illTyped<ChildProcessInfo[]>(null), illTyped<ChildProcessInfo[]>('node'), [child({ busy: illTyped('false') })]]) {
        const strays = [stray({ ignored: true, children })];
        expect(stateOf(evaluate(input({ scan: scan({ strays }) })), 'childProcesses')).toBe('cantTell');
      }
    });
  });
});

describe('userIdle', () => {
  it('is omitted when the contract does not require the user to be away', () => {
    const verdict = evaluate(input({ contract: contract({ requireUserIdle: false }), scan: scan({ idleSeconds: null }) }));
    expect(stateOf(verdict, 'userIdle')).toBe('omitted');
    expect(verdict.ok).toBe(true);
  });

  it('passes when the user has been away for exactly the target', () => {
    const verdict = evaluate(input({ scan: scan({ idleSeconds: 600 }) }));
    expect(stateOf(verdict, 'userIdle')).toBe('pass');
    expect(dataOf(verdict, 'userIdle')).toEqual({ idleSeconds: 600, userIdleSeconds: 600 });
  });

  it('waits while the user is here', () => {
    const verdict = evaluate(input({ scan: scan({ idleSeconds: 4 }) }));
    expect(stateOf(verdict, 'userIdle')).toBe('waiting');
    expect(dataOf(verdict, 'userIdle')).toEqual({ idleSeconds: 4, userIdleSeconds: 600 });
    expect(verdict.allClear).toBe(false);
  });

  it("can't tell when the idle time is unknown", () => {
    const verdict = evaluate(input({ scan: scan({ idleSeconds: null }) }));
    expect(stateOf(verdict, 'userIdle')).toBe('cantTell');
    expect(dataOf(verdict, 'userIdle')).toEqual({ idleSeconds: null, userIdleSeconds: 600 });
  });

  it("can't tell before the first scan", () => {
    const verdict = evaluate(input({ scan: null }));
    expect(stateOf(verdict, 'userIdle')).toBe('cantTell');
    expect(dataOf(verdict, 'userIdle')).toEqual({ idleSeconds: null, userIdleSeconds: 600 });
  });

  it("can't tell when the setting is neither on nor off, instead of dropping the check", () => {
    const verdict = evaluate(input({ contract: { ...contract(), requireUserIdle: illTyped(null) } }));
    expect(stateOf(verdict, 'userIdle')).toBe('cantTell');
  });
});

describe('guard', () => {
  const guarded = contract({ guardProcesses: ['ffmpeg', 'blender*'] });

  it('is omitted when the keep-on list is empty', () => {
    const verdict = evaluate(input({ scan: scan({ guardHits: null }) }));
    expect(stateOf(verdict, 'guard')).toBe('omitted');
  });

  it('passes when nothing on the keep-on list is running', () => {
    const verdict = evaluate(input({ contract: guarded, scan: scan({ guardHits: [] }) }));
    expect(stateOf(verdict, 'guard')).toBe('pass');
    expect(dataOf(verdict, 'guard')).toEqual({ hits: [] });
    expect(verdict.ok).toBe(true);
  });

  it('waits while something on the keep-on list is running', () => {
    const verdict = evaluate(input({ contract: guarded, scan: scan({ guardHits: ['ffmpeg', 'blender-softwaregl'] }) }));
    expect(stateOf(verdict, 'guard')).toBe('waiting');
    expect(dataOf(verdict, 'guard')).toEqual({ hits: ['ffmpeg', 'blender-softwaregl'] });
    expect(verdict.allClear).toBe(false);
  });

  it("can't tell when the process list could not be read", () => {
    const verdict = evaluate(input({ contract: guarded, scan: scan({ guardHits: null }) }));
    expect(stateOf(verdict, 'guard')).toBe('cantTell');
    expect(dataOf(verdict, 'guard')).toEqual({ hits: [] });
  });

  it("can't tell before the first scan", () => {
    expect(stateOf(evaluate(input({ contract: guarded, scan: null })), 'guard')).toBe('cantTell');
  });

  it("can't tell when the keep-on list itself is unreadable, instead of dropping the check", () => {
    const verdict = evaluate(input({ contract: { ...contract(), guardProcesses: illTyped('ffmpeg') } }));
    expect(stateOf(verdict, 'guard')).toBe('cantTell');
  });
});
