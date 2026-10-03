import { describe, expect, it } from 'vitest';
import {
  cleanNames,
  cleanPids,
  describeCapability,
  filetimeToEpochMs,
  mapIdleSeconds,
  mapProbe,
  mapSnapshot,
  normaliseProcessName,
  parseDetail,
  parsePowerFacts,
  sentence,
  type CapabilityContext,
  type PowerFacts,
} from '../../src/platform/winRows';

// 2024-01-17T21:20:00Z as a FILETIME, plus 959 units that a JS number would round away.
const START = '133500000000000959';
const START_MS = 1_705_526_400_000;

describe('sentence', () => {
  it('ends in exactly one full stop whatever the reason ends in', () => {
    expect(sentence("It couldn't be read", 'the helper stopped')).toBe("It couldn't be read: the helper stopped.");
    expect(sentence("It couldn't be read", 'Access is denied. \r\n')).toBe("It couldn't be read: Access is denied.");
    expect(sentence("It couldn't be read", 'wait...')).toBe("It couldn't be read: wait.");
  });
});

describe('names and times', () => {
  it('lower-cases image names and strips one .exe', () => {
    expect(normaliseProcessName('Claude.EXE')).toBe('claude');
    expect(normaliseProcessName('node.exe')).toBe('node');
    expect(normaliseProcessName('[System Process]')).toBe('[system process]');
    expect(normaliseProcessName('tool.exe', false)).toBe('tool.exe');
  });

  it('converts a FILETIME string to epoch milliseconds without losing the string', () => {
    expect(filetimeToEpochMs(START)).toBe(START_MS);
    expect(filetimeToEpochMs('134355037717240959')).toBe(Number((134355037717240959n - 116444736000000000n) / 10000n));
  });

  it('treats an implausible start time as unreadable', () => {
    for (const bad of ['0', '116444736000000000', '-5', '12.5', 'abc', '', '1e18', '999999999999999999999']) {
      expect(filetimeToEpochMs(bad), bad).toBeNull();
    }
  });
});

describe('parseDetail', () => {
  const full = { st: 'ok', path: 'C:\\Tools\\claude.exe', start: START, cpu: '25000000', io: '4096' };

  it('maps a fully readable row', () => {
    expect(parseDetail(full, true)).toEqual({
      state: 'ok',
      path: 'C:\\Tools\\claude.exe',
      startRaw: START,
      startEpochMs: START_MS,
      cpuSeconds: 2.5,
      ioBytes: 4096,
    });
  });

  it('keeps the start time as the exact string the registry is compared with', () => {
    const detail = parseDetail({ ...full, start: '134355037717240959' }, true);
    expect(detail?.startRaw).toBe('134355037717240959');
    expect(BigInt(detail!.startRaw!) - 134355037717240959n).toBe(0n);
  });

  it('downgrades "ok" to "partial" when a promised field is missing or of the wrong type', () => {
    expect(parseDetail({ ...full, path: null }, true)).toMatchObject({ state: 'partial', path: null });
    expect(parseDetail({ ...full, path: '' }, true)).toMatchObject({ state: 'partial', path: null });
    expect(parseDetail({ ...full, start: 134355037717240959 }, true)).toMatchObject({ state: 'partial', startRaw: null, startEpochMs: null });
    expect(parseDetail({ ...full, cpu: 12 }, true)).toMatchObject({ state: 'partial', cpuSeconds: null });
  });

  it('does not count missing I/O counters against the row (cmdlet tier has none)', () => {
    expect(parseDetail({ ...full, io: null }, true)).toMatchObject({ state: 'ok', ioBytes: null });
    expect(parseDetail({ ...full, io: 'NaN' }, true)).toMatchObject({ state: 'ok', ioBytes: null });
  });

  it('passes the dead and unreadable states through with unknown fields as null', () => {
    expect(parseDetail({ st: 'gone', err: 87 }, false)).toEqual({ state: 'gone', path: null, startRaw: null, startEpochMs: null, cpuSeconds: null, ioBytes: null });
    expect(parseDetail({ st: 'denied', err: 5 }, true)).toMatchObject({ state: 'denied', path: null, startRaw: null });
    expect(parseDetail({ st: 'exited', path: null, start: START, cpu: '1', io: '0' }, false)).toMatchObject({ state: 'exited', startRaw: START, ioBytes: 0 });
    expect(parseDetail({ st: 'partial', path: null, start: START, cpu: '1' }, true)).toMatchObject({ state: 'partial' });
  });

  it('never turns an unexplained failure into "dead"', () => {
    // Listed by Windows, so it exists; why it cannot be opened is unknown.
    expect(parseDetail({ st: 'error', err: 31 }, true)).toMatchObject({ state: 'denied' });
    // Not in the list and not openable for an unknown reason: no statement at all.
    expect(parseDetail({ st: 'error', err: 31 }, false)).toBeNull();
    for (const st of [undefined, null, 'skipped', 'dead', 0, true, {}]) {
      expect(parseDetail({ st }, true), String(st)).toBeNull();
    }
  });
});

describe('mapSnapshot', () => {
  const body = {
    idleMs: 61_500,
    nameStyle: 'image',
    processes: [
      { pid: 0, ppid: 0, name: '[System Process]' },
      { pid: 4, ppid: 0, name: 'System' },
      { pid: 800, ppid: 4, name: 'Claude.exe', st: 'ok', path: 'C:\\x\\claude.exe', start: START, cpu: '10000000', io: '10' },
      { pid: 900, ppid: 800, name: 'node.exe', st: 'denied', err: 5 },
      { pid: 1000, ppid: 'x', name: 'svchost.exe' },
      { pid: 7777, name: null, listed: false, st: 'gone', err: 87 },
      { pid: 8888, name: null, listed: false, st: 'exited', path: null, start: START, cpu: '5', io: null },
    ],
  };

  it('lists every process with a normalised name and its parent', () => {
    const { processes } = mapSnapshot(body);
    expect(processes).toEqual([
      { pid: 0, ppid: 0, name: '[system process]' },
      { pid: 4, ppid: 0, name: 'system' },
      { pid: 800, ppid: 4, name: 'claude' },
      { pid: 900, ppid: 800, name: 'node' },
      { pid: 1000, ppid: null, name: 'svchost' },
    ]);
  });

  it('returns detail only for rows that carry it, including requested PIDs that are not running', () => {
    const { details } = mapSnapshot(body);
    expect(Object.keys(details).map(Number).sort((a, b) => a - b)).toEqual([800, 900, 7777, 8888]);
    expect(details[800]).toMatchObject({ state: 'ok', cpuSeconds: 1, ioBytes: 10 });
    expect(details[900]).toMatchObject({ state: 'denied', path: null });
    expect(details[7777]).toMatchObject({ state: 'gone' });
    expect(details[8888]).toMatchObject({ state: 'exited', startRaw: START });
  });

  it('reports idle time in seconds and unknown as null, never 0', () => {
    expect(mapSnapshot(body).idleSeconds).toBe(61.5);
    expect(mapIdleSeconds({ idleMs: 0 })).toBe(0);
    for (const idleMs of [null, undefined, -1, Number.NaN, Number.POSITIVE_INFINITY, '1500', true]) {
      expect(mapIdleSeconds({ idleMs }), String(idleMs)).toBeNull();
    }
  });

  it('keeps a real ".exe" in names from the cmdlet tier, which reports names without the extension', () => {
    const { processes } = mapSnapshot({ nameStyle: 'noext', processes: [{ pid: 12, name: 'Tool.exe' }, { pid: 16, name: 'node' }] });
    expect(processes).toEqual([
      { pid: 12, ppid: null, name: 'tool.exe' },
      { pid: 16, ppid: null, name: 'node' },
    ]);
  });

  it('treats a missing, empty or partly unreadable list as "could not be read"', () => {
    expect(mapSnapshot({}).processes).toBeNull();
    expect(mapSnapshot({ processes: 'nope' }).processes).toBeNull();
    expect(mapSnapshot({ processes: [] }).processes).toBeNull();
    expect(mapSnapshot({ processes: [{ pid: 7777, name: null, listed: false, st: 'gone' }] }).processes).toBeNull();
    for (const badRow of [null, 'row', { pid: '12', name: 'a.exe' }, { pid: 1.5, name: 'a.exe' }, { pid: -4, name: 'a.exe' }, { pid: 12 }, { pid: 12, name: 5 }]) {
      const mapped = mapSnapshot({ processes: [{ pid: 4, ppid: 0, name: 'System' }, badRow] });
      expect(mapped.processes, JSON.stringify(badRow)).toBeNull();
    }
  });

  it('still returns the detail it could read when the list as a whole is rejected', () => {
    const mapped = mapSnapshot({ processes: [{ pid: 800, name: 'claude.exe', st: 'denied' }, { pid: 'bad' }] });
    expect(mapped.processes).toBeNull();
    expect(mapped.details[800]).toMatchObject({ state: 'denied' });
  });
});

describe('mapProbe', () => {
  it('maps rows by PID and leaves unusable rows out (= unknown)', () => {
    const details = mapProbe({
      processes: [
        { pid: 800, st: 'ok', path: 'C:\\x\\claude.exe', start: START, cpu: '0', io: '0' },
        { pid: 801, st: 'gone', err: 87 },
        { pid: 802, st: 'error', err: 31 },
        { pid: 'x', st: 'ok' },
        'junk',
      ],
    });
    expect(Object.keys(details).map(Number)).toEqual([800, 801]);
    expect(details[800]).toMatchObject({ state: 'ok', cpuSeconds: 0, ioBytes: 0 });
    expect(details[801]).toMatchObject({ state: 'gone' });
  });

  it('returns nothing for a reply without rows', () => {
    expect(mapProbe({})).toEqual({});
    expect(mapProbe({ processes: null })).toEqual({});
  });
});

describe('request cleaning', () => {
  it('sends only positive integer PIDs, once each', () => {
    expect(cleanPids([12, 12, 1.5, 0, -4, Number.NaN, '16', null, 4294967296, 4294967295, 20])).toEqual([12, 4294967295, 20]);
    expect(cleanPids([1, 2, 3, 4], 2)).toEqual([1, 2]);
  });

  it('sends lower-case names without .exe and without empty needles', () => {
    expect(cleanNames(['Claude', 'node.EXE', '', '  ', 7, 'claude', '.exe'])).toEqual(['claude', 'node']);
  });
});

describe('power capability', () => {
  const tools = { shutdown: true, powershell: true, rundll32: true };
  const facts = (overrides: Partial<PowerFacts> = {}): PowerFacts => ({
    shutdownPrivilege: 'present',
    hibernateAllowed: true,
    suspendAllowed: true,
    classicSleep: true,
    modernStandby: false,
    ...overrides,
  });
  const context = (overrides: Partial<CapabilityContext> = {}): CapabilityContext => ({ facts: facts(), problem: null, limited: false, tools, ...overrides });

  it('reads the helper reply of this machine class (S3 desktop)', () => {
    expect(
      parsePowerFacts({ shutdownPrivilege: 'present', hibernateAllowed: true, suspendAllowed: true, s1: false, s2: false, s3: true, modernStandby: false }),
    ).toEqual(facts());
  });

  it('reads a Modern Standby laptop and a reply without firmware states', () => {
    expect(parsePowerFacts({ shutdownPrivilege: 'absent', hibernateAllowed: false, suspendAllowed: false, s1: false, s2: false, s3: false, modernStandby: true })).toEqual({
      shutdownPrivilege: 'absent',
      hibernateAllowed: false,
      suspendAllowed: false,
      classicSleep: false,
      modernStandby: true,
    });
    expect(parsePowerFacts({ shutdownPrivilege: 'unknown', hibernateAllowed: true, suspendAllowed: null })).toEqual({
      shutdownPrivilege: 'unknown',
      hibernateAllowed: true,
      suspendAllowed: null,
      classicSleep: null,
      modernStandby: null,
    });
  });

  it('never reads a wrongly typed fact as a yes', () => {
    expect(parsePowerFacts({ shutdownPrivilege: true, hibernateAllowed: 'true', suspendAllowed: 1, s1: 'yes', s2: 1, s3: null, modernStandby: 0 })).toEqual({
      shutdownPrivilege: 'unknown',
      hibernateAllowed: null,
      suspendAllowed: null,
      classicSleep: null,
      modernStandby: null,
    });
  });

  it('allows everything on a normal PC', () => {
    for (const action of ['shutdown', 'hibernate', 'sleep', 'lock', 'notify'] as const) {
      expect(describeCapability(action, context()).ok, action).toBe(true);
    }
  });

  it('notify and lock need no answer from Windows', () => {
    expect(describeCapability('notify', context({ facts: null })).ok).toBe(true);
    expect(describeCapability('lock', context({ facts: null })).ok).toBe(true);
  });

  it('refuses shut down, hibernate and sleep without the shutdown right, and cannot tell when it is unknown', () => {
    for (const action of ['shutdown', 'hibernate', 'sleep'] as const) {
      expect(describeCapability(action, context({ facts: facts({ shutdownPrivilege: 'absent' }) })).ok, action).toBe(false);
      expect(describeCapability(action, context({ facts: facts({ shutdownPrivilege: 'unknown' }) })).ok, action).toBeNull();
    }
  });

  it('follows hibernateAllowed for hibernate', () => {
    expect(describeCapability('hibernate', context({ facts: facts({ hibernateAllowed: false }) }))).toEqual({ ok: false, detail: 'Hibernation is turned off on this PC.' });
    expect(describeCapability('hibernate', context({ facts: facts({ hibernateAllowed: null }) })).ok).toBeNull();
  });

  it('offers sleep only when a classic sleep state exists and points to Hibernate otherwise', () => {
    const modern = describeCapability('sleep', context({ facts: facts({ classicSleep: false, modernStandby: true }) }));
    expect(modern.ok).toBe(false);
    expect(modern.detail).toMatch(/Modern Standby/);
    expect(modern.detail).toMatch(/Use Hibernate/);
    const none = describeCapability('sleep', context({ facts: facts({ classicSleep: false, modernStandby: false }) }));
    expect(none).toMatchObject({ ok: false });
    expect(none.detail).toMatch(/Use Hibernate/);
    expect(describeCapability('sleep', context({ facts: facts({ classicSleep: null }) })).ok).toBeNull();
    expect(describeCapability('sleep', context({ facts: facts({ suspendAllowed: false }) })).ok).toBe(false);
  });

  it('refuses sleep in the limited tier, where neither the states nor the command are available', () => {
    const limited = describeCapability('sleep', context({ limited: true, facts: facts({ classicSleep: null, suspendAllowed: null }) }));
    expect(limited.ok).toBe(false);
    expect(limited.detail).toMatch(/Use Hibernate/);
  });

  it('cannot tell when Windows could not be asked', () => {
    for (const action of ['shutdown', 'hibernate', 'sleep'] as const) {
      const result = describeCapability(action, context({ facts: null, problem: 'the helper did not answer within 8 seconds' }));
      expect(result.ok, action).toBeNull();
      expect(result.detail).toContain('the helper did not answer within 8 seconds');
    }
  });

  it('refuses an action whose system tool is missing', () => {
    expect(describeCapability('shutdown', context({ tools: { ...tools, shutdown: false } }))).toMatchObject({ ok: false });
    expect(describeCapability('hibernate', context({ tools: { ...tools, shutdown: false } }))).toMatchObject({ ok: false });
    expect(describeCapability('sleep', context({ tools: { ...tools, powershell: false } }))).toMatchObject({ ok: false });
    expect(describeCapability('lock', context({ tools: { ...tools, rundll32: false } }))).toMatchObject({ ok: false });
  });

  it('answers "cannot tell" for an action it does not know', () => {
    expect(describeCapability('explode' as never, context()).ok).toBeNull();
  });

  it('always explains itself', () => {
    for (const action of ['shutdown', 'hibernate', 'sleep', 'lock', 'notify'] as const) {
      for (const candidate of [context(), context({ facts: null }), context({ limited: true }), context({ facts: facts({ shutdownPrivilege: 'absent' }) })]) {
        expect(describeCapability(action, candidate).detail.length, action).toBeGreaterThan(10);
      }
    }
  });
});
