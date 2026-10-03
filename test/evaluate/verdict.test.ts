import { describe, expect, it } from 'vitest';

import { evaluate } from '../../src/core/evaluate';
import type { EvaluateInput } from '../../src/core/evaluate';
import type { CheckId, Verdict } from '../../src/core/types';
import {
  cantTellSession,
  child,
  contract,
  dataOf,
  find,
  ids,
  illTyped,
  input,
  remoteWindow,
  scan,
  session,
  stateOf,
  stray,
  unmet,
  workingSession,
} from './fixtures';

/** One way to break each check except `confirmed`, starting from an input where everything passes. */
const UNMET: Record<Exclude<CheckId, 'confirmed'>, () => EvaluateInput> = {
  armed: () => input({ armed: false }),
  stopFile: () => input({ stopPresent: true }),
  scanner: () => input({ scanStale: true }),
  helper: () => input({ helperTier: 'unavailable' }),
  actionAllowed: () => input({ capability: { ok: false, detail: 'Not allowed' } }),
  remoteWindows: () => input({ remoteWindows: [remoteWindow()] }),
  registry: () => input({ scan: scan({ strays: [stray()] }) }),
  unclaimedTranscripts: () =>
    input({
      scan: scan({
        unclaimedRecent: [{ path: 'C:\\fixture\\p\\x.jsonl', project: 'p', mtimeMs: 1_790_000_990_000, secondsAgo: 10 }],
      }),
    }),
  hasSessions: () => input({ scan: scan({ sessions: [] }), sawAnySession: false, secondsSinceLastSession: null }),
  sessionsIdle: () => input({ scan: scan({ sessions: [session({ working: true, status: 'working' })] }) }),
  turnsClosed: () => input({ scan: scan({ sessions: [session({ turn: 'OPEN', turnReason: 'thinking' })] }) }),
  quiet: () => input({ scan: scan({ sessions: [session({ silenceSeconds: 10 })] }) }),
  childProcesses: () => input({ scan: scan({ sessions: [session({ children: [child()] })] }) }),
  userIdle: () => input({ scan: scan({ idleSeconds: 3 }) }),
  guard: () => input({ contract: contract({ guardProcesses: ['ffmpeg'] }), scan: scan({ guardHits: ['ffmpeg'] }) }),
};

describe('confirmed', () => {
  it('is always the last check', () => {
    const inputs = [input(), input({ scan: null }), input({ armed: false }), ...Object.values(UNMET).map((make) => make())];
    for (const each of inputs) {
      const verdict = evaluate(each);
      expect(ids(verdict).indexOf('confirmed')).toBe(verdict.checks.length - 1);
      expect(ids(verdict).filter((id) => id === 'confirmed')).toHaveLength(1);
    }
  });

  it('counts this poll: k = stablePolls + 1 while everything is clear', () => {
    const verdict = evaluate(input({ stablePolls: 0 }));
    expect(verdict.allClear).toBe(true);
    expect(verdict.stablePolls).toBe(1);
    expect(verdict.requiredPolls).toBe(3);
    expect(find(verdict, 'confirmed')).toEqual({ id: 'confirmed', state: 'waiting', data: { k: 1, n: 3 } });
    expect(verdict.ok).toBe(false);
  });

  it('passes exactly when k reaches n', () => {
    const below = evaluate(input({ stablePolls: 1 }));
    expect(find(below, 'confirmed')).toEqual({ id: 'confirmed', state: 'waiting', data: { k: 2, n: 3 } });
    expect(below.ok).toBe(false);

    const reached = evaluate(input({ stablePolls: 2 }));
    expect(find(reached, 'confirmed')).toEqual({ id: 'confirmed', state: 'pass', data: { k: 3, n: 3 } });
    expect(reached.ok).toBe(true);
    expect(reached.stablePolls).toBe(3);
  });

  it('keeps passing, and keeps counting, after n', () => {
    const verdict = evaluate(input({ stablePolls: 7 }));
    expect(find(verdict, 'confirmed')).toEqual({ id: 'confirmed', state: 'pass', data: { k: 8, n: 3 } });
    expect(verdict.stablePolls).toBe(8);
    expect(verdict.ok).toBe(true);
  });

  it.each([2, 3, 5, 10])('needs exactly %i clear polls in a row when the contract asks for that many', (n) => {
    const rules = contract({ requiredPolls: n });
    let stablePolls = 0;
    for (let poll = 1; poll <= n; poll++) {
      const verdict = evaluate(input({ contract: rules, stablePolls }));
      expect(verdict.allClear).toBe(true);
      expect(verdict.stablePolls).toBe(poll);
      expect(verdict.requiredPolls).toBe(n);
      expect(verdict.ok).toBe(poll === n);
      stablePolls = verdict.stablePolls;
    }
  });

  it('starts again from zero after one unmet poll in the middle of a run', () => {
    const clear = input({ stablePolls: 0 });
    const first = evaluate(clear);
    const second = evaluate({ ...clear, stablePolls: first.stablePolls });
    expect(second.stablePolls).toBe(2);

    const interrupted = evaluate({ ...UNMET.userIdle(), stablePolls: second.stablePolls });
    expect(interrupted.stablePolls).toBe(0);

    const resumed = evaluate({ ...clear, stablePolls: interrupted.stablePolls });
    expect(resumed.stablePolls).toBe(1);
    expect(resumed.ok).toBe(false);
  });

  it("can't tell when the count so far is not a count", () => {
    for (const stablePolls of [NaN, Infinity, -1, 1.5, '2', null, undefined]) {
      const verdict = evaluate(input({ stablePolls: illTyped(stablePolls) }));
      expect(verdict.allClear).toBe(true);
      expect(find(verdict, 'confirmed')).toEqual({ id: 'confirmed', state: 'cantTell', data: { k: 0, n: 3 } });
      expect(verdict.stablePolls).toBe(0);
      expect(verdict.ok).toBe(false);
    }
  });

  it("can't tell when the required count is unreadable, and reports the strictest count instead", () => {
    for (const requiredPolls of [NaN, Infinity, -1, 0, 1, 2.5, '3', null, undefined]) {
      const verdict = evaluate(input({ contract: { ...contract(), requiredPolls: illTyped(requiredPolls) }, stablePolls: 50 }));
      expect(verdict.allClear).toBe(true);
      expect(find(verdict, 'confirmed')).toEqual({ id: 'confirmed', state: 'cantTell', data: { k: 0, n: null } });
      // A caller comparing the two numbers itself must not arrive at "confirmed" either.
      expect(verdict.stablePolls).toBe(0);
      expect(verdict.requiredPolls).toBe(10);
      expect(verdict.ok).toBe(false);
    }
  });
});

describe('allClear, ok and stablePolls', () => {
  it.each(Object.keys(UNMET) as (keyof typeof UNMET)[])('an unmet %s check alone blocks and resets the count', (id) => {
    const verdict = evaluate({ ...UNMET[id](), stablePolls: 9 });
    expect(unmet(verdict)).toEqual([id]);
    expect(verdict.allClear).toBe(false);
    expect(verdict.ok).toBe(false);
    expect(verdict.stablePolls).toBe(0);
    expect(find(verdict, 'confirmed')).toEqual({ id: 'confirmed', state: 'waiting', data: { k: 0, n: 3 } });
  });

  it('allClear is about every check except confirmed', () => {
    const confirming = evaluate(input({ stablePolls: 0 }));
    expect(stateOf(confirming, 'confirmed')).toBe('waiting');
    expect(confirming.allClear).toBe(true);
    expect(confirming.ok).toBe(false);
  });

  it('ok needs both allClear and confirmed', () => {
    const confirmed = evaluate(input());
    expect(confirmed.allClear && stateOf(confirmed, 'confirmed') === 'pass').toBe(true);
    expect(confirmed.ok).toBe(true);
  });

  it("blocks on can't tell exactly as on waiting and fail", () => {
    const states = {
      waiting: evaluate({ ...input({ scan: scan({ idleSeconds: 3 }) }), stablePolls: 9 }),
      cantTell: evaluate({ ...input({ scan: scan({ idleSeconds: null }) }), stablePolls: 9 }),
      fail: evaluate({ ...input({ stopPresent: true }), stablePolls: 9 }),
    };
    for (const verdict of Object.values(states)) {
      expect(verdict.allClear).toBe(false);
      expect(verdict.ok).toBe(false);
      expect(verdict.stablePolls).toBe(0);
    }
  });

  it('before the first scan nothing that needs a scan passes', () => {
    const verdict = evaluate(input({ scan: null, contract: contract({ guardProcesses: ['ffmpeg'] }) }));
    expect(unmet(verdict)).toEqual([
      'scanner',
      'registry',
      'unclaimedTranscripts',
      'sessionsIdle',
      'turnsClosed',
      'userIdle',
      'guard',
    ]);
    expect(verdict.ok).toBe(false);
  });

  it('a stale scan blocks even though the stale picture looks clear', () => {
    const verdict = evaluate(input({ scanStale: true }));
    expect(unmet(verdict)).toEqual(['scanner']);
    expect(verdict.ok).toBe(false);
  });
});

describe('ignored sessions', () => {
  const sessions = [
    workingSession({ ignored: true, children: [child()] }),
    cantTellSession({ ignored: true }),
    session({ name: 'done' }),
  ];

  it('do not block any check', () => {
    const verdict = evaluate(input({ scan: scan({ sessions }) }));
    expect(unmet(verdict)).toEqual([]);
    expect(verdict.ok).toBe(true);
  });

  it('are still counted in the data', () => {
    const verdict = evaluate(input({ scan: scan({ sessions }) }));
    expect(dataOf(verdict, 'sessionsIdle')).toEqual({ total: 3, working: 0, cantTell: 0, ignored: 2, names: [] });
  });

  it('block again as soon as the ignore is gone', () => {
    const revived = sessions.map((each) => ({ ...each, ignored: false }));
    const verdict = evaluate(input({ scan: scan({ sessions: revived }) }));
    expect(unmet(verdict)).toEqual(['sessionsIdle', 'turnsClosed', 'quiet', 'childProcesses']);
  });

  it('when every session is ignored, the zero-session rule does not apply and nothing waits', () => {
    const verdict = evaluate(
      input({ scan: scan({ sessions: [workingSession({ ignored: true })] }), sawAnySession: false, secondsSinceLastSession: null }),
    );
    expect(stateOf(verdict, 'hasSessions')).toBe('omitted');
    expect(stateOf(verdict, 'quiet')).toBe('omitted');
    expect(verdict.ok).toBe(true);
  });

  it('are ignored only by the boolean true', () => {
    for (const ignored of ['true', 1, {}, [], 'false']) {
      const verdict = evaluate(input({ scan: scan({ sessions: [workingSession({ ignored: illTyped(ignored) })] }) }));
      expect(unmet(verdict)).toContain('sessionsIdle');
      expect(dataOf(verdict, 'sessionsIdle')?.ignored).toBe(0);
    }
  });
});

describe('purity', () => {
  function deepFreeze<T>(value: T): T {
    if (value !== null && typeof value === 'object') {
      for (const inner of Object.values(value)) deepFreeze(inner);
      Object.freeze(value);
    }
    return value;
  }

  function busyInput(): EvaluateInput {
    return input({
      contract: contract({ guardProcesses: ['ffmpeg'] }),
      remoteWindows: [remoteWindow(), remoteWindow({ name: 'WSL: Ubuntu', covered: true })],
      scan: scan({
        sessions: [workingSession({ children: [child()] }), cantTellSession(), session()],
        errors: ['Something could not be read.'],
        strays: [stray()],
        guardHits: ['ffmpeg'],
        unclaimedRecent: [{ path: 'C:\\fixture\\p\\x.jsonl', project: 'p', mtimeMs: 1_790_000_990_000, secondsAgo: 10 }],
      }),
    });
  }

  it('does not write to its input', () => {
    const frozen = deepFreeze(busyInput());
    expect(evaluate(frozen)).toEqual(evaluate(busyInput()));
    expect(frozen).toEqual(busyInput());
  });

  it('returns the same verdict for the same input', () => {
    expect(evaluate(busyInput())).toEqual(evaluate(busyInput()));
    expect(evaluate(input())).toEqual(evaluate(input()));
  });

  it('returns data that does not alias the input', () => {
    const source = busyInput();
    const verdict = evaluate(source);
    (dataOf(verdict, 'scanner')?.errors as string[]).push('written by the caller');
    (dataOf(verdict, 'guard')?.hits as string[]).push('written by the caller');
    expect(source).toEqual(busyInput());
  });

  it('returns plain JSON: the verdict survives the trip to another window unchanged', () => {
    for (const each of [busyInput(), input(), input({ scan: null }), input({ contract: illTyped({}) })]) {
      const verdict = evaluate(each);
      expect(JSON.parse(JSON.stringify(verdict))).toStrictEqual(verdict);
    }
  });
});

describe('never throws', () => {
  function expectBlocked(verdict: Verdict): void {
    expect(verdict.ok).toBe(false);
    expect(verdict.allClear).toBe(false);
    expect(verdict.stablePolls).toBe(0);
    expect(ids(verdict).at(-1)).toBe('confirmed');
  }

  it.each([undefined, null, NaN, 42, 'input', true, [], {}, () => undefined])(
    'blocks when the whole input is %s',
    (garbage) => {
      const verdict = evaluate(illTyped(garbage));
      expectBlocked(verdict);
      expect(ids(verdict)[0]).toBe('armed');
      expect(unmet(verdict)).toContain('armed');
      expect(unmet(verdict)).toContain('scanner');
    },
  );

  it('blocks when the contract is missing', () => {
    for (const garbage of [undefined, null, 7, 'contract', []]) {
      const verdict = evaluate(input({ contract: illTyped(garbage) }));
      expectBlocked(verdict);
      expect(unmet(verdict)).toEqual(['actionAllowed', 'quiet', 'childProcesses', 'userIdle', 'guard']);
      expect(verdict.requiredPolls).toBe(10);
    }
  });

  it('blocks on sessions, strays, children and windows that are not objects', () => {
    const verdict = evaluate(
      input({
        remoteWindows: illTyped([null, 'SSH: box']),
        scan: scan({
          sessions: illTyped([null, 17, 'session', session({ children: illTyped([null, 'npm']) })]),
          strays: illTyped([undefined, 'claude']),
        }),
      }),
    );
    expectBlocked(verdict);
    expect(unmet(verdict)).toEqual(['remoteWindows', 'registry', 'sessionsIdle', 'turnsClosed', 'quiet', 'childProcesses']);
    expect(dataOf(verdict, 'sessionsIdle')).toEqual({ total: 4, working: 0, cantTell: 3, ignored: 0, names: ['?', '?', '?'] });
    expect(dataOf(verdict, 'registry')).toEqual({ reason: 'unaccounted', pids: [], names: ['?', '?'], strays: 2 });
    expect(dataOf(verdict, 'childProcesses')).toEqual({
      items: ['? (PID ?) started by web-ui', '? (PID ?) started by web-ui'],
    });
  });

  it('does not let a hole in a list hide an entry', () => {
    const sessions = [session()];
    sessions.length = 2;
    const verdict = evaluate(input({ scan: scan({ sessions }) }));
    expectBlocked(verdict);
    expect(dataOf(verdict, 'sessionsIdle')).toMatchObject({ total: 2, cantTell: 1 });
  });

  it('turns an internal failure into a blocking verdict that names the cause', () => {
    const hostile = Object.defineProperty(input(), 'scan', {
      get(): never {
        throw new Error('boom');
      },
    });
    let verdict: Verdict | undefined;
    expect(() => {
      verdict = evaluate(hostile);
    }).not.toThrow();
    expect(verdict).toEqual({
      checks: [
        {
          id: 'scanner',
          state: 'cantTell',
          data: { reason: 'errors', errors: ['The checks could not be evaluated: boom'], roots: null },
        },
        { id: 'confirmed', state: 'cantTell', data: { k: 0, n: null } },
      ],
      allClear: false,
      ok: false,
      stablePolls: 0,
      requiredPolls: 10,
    });
  });
});
