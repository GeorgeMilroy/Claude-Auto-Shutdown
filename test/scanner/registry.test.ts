import { describe, expect, it } from 'vitest';

import { judgeLiveness, parseRegistryEntry, writtenByAnotherSystem, type RegistryFields } from '../../src/core/registry';
import type { ProcDetail } from '../../src/platform/types';
import { CLAUDE_EXE, detail } from './support';

function fieldsOf(value: unknown): RegistryFields {
  const parsed = parseRegistryEntry(JSON.stringify(value));
  if (!parsed.ok) throw new Error(`expected a usable entry, got: ${parsed.problem}`);
  return parsed.fields;
}

function problemOf(content: string): string {
  const parsed = parseRegistryEntry(content);
  if (parsed.ok) throw new Error('expected a problem, got a usable entry');
  return parsed.problem;
}

describe('parseRegistryEntry', () => {
  it('reads every field it uses', () => {
    expect(
      fieldsOf({
        pid: 4242,
        sessionId: 'aaaaaaaa-1111-2222-3333-444444444444',
        cwd: 'C:\\work\\shop',
        name: 'checkout flow',
        entrypoint: 'cli',
        kind: 'interactive',
        startedAt: 1_790_000_000_000,
        procStart: '134355037717240959',
      }),
    ).toEqual({
      pid: 4242,
      sessionId: 'aaaaaaaa-1111-2222-3333-444444444444',
      cwd: 'C:\\work\\shop',
      name: 'checkout flow',
      entrypoint: 'cli',
      startedAtMs: 1_790_000_000_000,
      procStart: 134355037717240959n,
    });
  });

  it.each([
    ['cut off mid-write', '{"pid": 12, "sessionId": "ab'],
    ['empty', ''],
    ['not JSON at all', 'pid=12'],
  ])('reports a file that is %s', (_label, content) => {
    expect(problemOf(content)).toBe("isn't valid JSON");
  });

  it.each([
    ['an array', '[{"pid": 12}]'],
    ['null', 'null'],
    ['a number', '12'],
    ['a string', '"12"'],
  ])('reports %s as not an object', (_label, content) => {
    expect(problemOf(content)).toBe("isn't a JSON object");
  });

  it.each([
    ['a string', '"4242"'],
    ['a float', '42.5'],
    ['negative', '-4242'],
    ['zero', '0'],
    ['null', 'null'],
    ['a boolean', 'true'],
    ['far too large', '1e300'],
  ])('reports a pid that is %s', (_label, pid) => {
    expect(problemOf(`{"pid": ${pid}, "sessionId": "abc"}`)).toBe('has no usable process id (pid)');
  });

  it('reports a missing pid', () => {
    expect(problemOf('{"sessionId": "abc"}')).toBe('has no usable process id (pid)');
  });

  it('turns fields of the wrong type into empty text', () => {
    expect(fieldsOf({ pid: 1, sessionId: 77, cwd: ['x'], name: { a: 1 }, entrypoint: null })).toMatchObject({
      sessionId: '',
      cwd: '',
      name: '',
      entrypoint: '',
    });
  });

  it('makes startedAt null - never NaN - unless it is a finite number', () => {
    expect(fieldsOf({ pid: 1, startedAt: '2026-10-03T12:00:00.000Z' }).startedAtMs).toBeNull();
    expect(fieldsOf({ pid: 1, startedAt: '1790000000000' }).startedAtMs).toBeNull();
    expect(fieldsOf({ pid: 1, startedAt: null }).startedAtMs).toBeNull();
    expect(fieldsOf({ pid: 1, startedAt: -5 }).startedAtMs).toBeNull();
    expect(fieldsOf({ pid: 1 }).startedAtMs).toBeNull();
    expect(parseRegistryEntry('{"pid": 1, "startedAt": 1e999}')).toMatchObject({ ok: true, fields: { startedAtMs: null } });
  });

  it('reads procStart from a number or a string of digits, and nothing else', () => {
    expect(fieldsOf({ pid: 1, procStart: 633076 }).procStart).toBe(633076n);
    expect(fieldsOf({ pid: 1, procStart: '633076' }).procStart).toBe(633076n);
    expect(fieldsOf({ pid: 1, procStart: ' 633076 ' }).procStart).toBe(633076n);
    expect(fieldsOf({ pid: 1, procStart: '0x9a8f4' }).procStart).toBeNull();
    expect(fieldsOf({ pid: 1, procStart: '2026-10-03' }).procStart).toBeNull();
    expect(fieldsOf({ pid: 1, procStart: -1 }).procStart).toBeNull();
    expect(fieldsOf({ pid: 1, procStart: 1.5 }).procStart).toBeNull();
    expect(fieldsOf({ pid: 1, procStart: null }).procStart).toBeNull();
    expect(fieldsOf({ pid: 1 }).procStart).toBeNull();
  });

  it('accepts a byte order mark and cuts oversized text', () => {
    const parsed = parseRegistryEntry(`\uFEFF${JSON.stringify({ pid: 9, name: 'n'.repeat(5000), cwd: 'c'.repeat(5000) })}`);
    expect(parsed).toMatchObject({ ok: true, fields: { pid: 9 } });
    if (parsed.ok) {
      expect(parsed.fields.name).toHaveLength(120);
      expect(parsed.fields.cwd).toHaveLength(1024);
    }
  });
});

describe('writtenByAnotherSystem', () => {
  const FILETIME_2000 = 125_911_584_000_000_000n;
  const entry = (cwd: string, procStart: bigint | null = null) => ({ cwd, procStart });

  it('on Windows: a POSIX working directory, or a start time no FILETIME of a living process has', () => {
    expect(writtenByAnotherSystem(entry('/home/me/proj', 134355037717240959n), 'windows')).toBe(true);
    expect(writtenByAnotherSystem(entry('C:\\work\\shop', 123456n), 'windows')).toBe(true);
    expect(writtenByAnotherSystem(entry('C:\\work\\shop', FILETIME_2000 - 1n), 'windows')).toBe(true);
  });

  it('on Windows: not for a Windows path with a plausible, missing or zero start time', () => {
    expect(writtenByAnotherSystem(entry('C:\\work\\shop', 134355037717240959n), 'windows')).toBe(false);
    expect(writtenByAnotherSystem(entry('C:\\work\\shop', FILETIME_2000), 'windows')).toBe(false);
    expect(writtenByAnotherSystem(entry('\\\\server\\share\\proj', null), 'windows')).toBe(false);
    expect(writtenByAnotherSystem(entry('', 0n), 'windows')).toBe(false);
  });

  it.each(['linux', 'macos'] as const)('on %s: a Windows working directory', (platform) => {
    expect(writtenByAnotherSystem(entry('C:\\work\\shop', 134355037717240959n), platform)).toBe(true);
    expect(writtenByAnotherSystem(entry('d:/work/shop'), platform)).toBe(true);
    expect(writtenByAnotherSystem(entry('/home/me/proj', 633076n), platform)).toBe(false);
    expect(writtenByAnotherSystem(entry(''), platform)).toBe(false);
  });

  it('says nothing on an OS it does not know', () => {
    expect(writtenByAnotherSystem(entry('/home/me/proj', 1n), 'unsupported')).toBe(false);
  });
});

describe('judgeLiveness', () => {
  const WRITTEN = 1_790_000_000_000;
  const FILETIME_SECOND = 10_000_000;
  /** A FILETIME beyond 2^53: Number() cannot hold it exactly. */
  const START = 134355037717240959n;

  const entry = (procStart: bigint | null, mtimeMs = WRITTEN) => ({ procStart, mtimeMs });
  const running = (overrides: Partial<ProcDetail> = {}) =>
    detail({ path: CLAUDE_EXE, startRaw: START.toString(), startEpochMs: WRITTEN - 60_000, ...overrides });

  it('is unverified when the platform said nothing about the PID', () => {
    expect(judgeLiveness(entry(START), null, 'claude', FILETIME_SECOND)).toBe('unverified');
    expect(judgeLiveness(entry(null), null, null, FILETIME_SECOND)).toBe('unverified');
  });

  it.each(['gone', 'exited'] as const)('is dead when the process is %s, even with a matching start time', (state) => {
    expect(judgeLiveness(entry(START), running({ state }), 'claude', FILETIME_SECOND)).toBe('dead');
  });

  it('is verified when the start times agree', () => {
    expect(judgeLiveness(entry(START), running(), 'claude', FILETIME_SECOND)).toBe('verified');
  });

  it('is verified whatever the process is called, once the start times agree', () => {
    expect(judgeLiveness(entry(START), running({ path: null }), '2.1.283', FILETIME_SECOND)).toBe('verified');
  });

  it('compares FILETIME-sized values exactly at the one second tolerance', () => {
    // As plain numbers both differences below come out as exactly 10,000,000.
    expect(Number(START) - Number(START - 10_000_001n)).toBe(10_000_000);
    for (const sign of [1n, -1n]) {
      expect(judgeLiveness(entry(START + sign * 10_000_000n), running(), 'claude', FILETIME_SECOND)).toBe('verified');
      expect(judgeLiveness(entry(START + sign * 10_000_001n), running(), 'claude', FILETIME_SECOND)).toBe('unverified');
    }
  });

  it('uses the tolerance of the OS (Linux clock ticks)', () => {
    const ticks = running({ startRaw: '633076' });
    expect(judgeLiveness(entry(633176n), ticks, 'claude', 100)).toBe('verified');
    expect(judgeLiveness(entry(633177n), ticks, 'claude', 100)).toBe('unverified');
  });

  describe('start times differ', () => {
    const other = entry(START - 500_000_000n);

    it('is dead when the process started after the entry was written (PID reuse)', () => {
      expect(judgeLiveness(other, running({ startEpochMs: WRITTEN + 2001 }), 'claude', FILETIME_SECOND)).toBe('dead');
    });

    it('is unverified without that proof', () => {
      expect(judgeLiveness(other, running({ startEpochMs: WRITTEN + 2000 }), 'claude', FILETIME_SECOND)).toBe('unverified');
      expect(judgeLiveness(other, running({ startEpochMs: WRITTEN - 1 }), 'claude', FILETIME_SECOND)).toBe('unverified');
      expect(judgeLiveness(other, running({ startEpochMs: null }), 'claude', FILETIME_SECOND)).toBe('unverified');
    });

    it('does not fall back to the name: a changed procStart format must not kill every session', () => {
      expect(judgeLiveness(other, running({ path: 'C:\\Windows\\System32\\svchost.exe' }), 'svchost', FILETIME_SECOND)).toBe('unverified');
    });
  });

  describe('start times cannot be compared', () => {
    const unreadable = { startRaw: null, startEpochMs: null, path: null } as const;

    it('is dead when the process started after the entry was written', () => {
      expect(judgeLiveness(entry(null), running({ startEpochMs: WRITTEN + 2001 }), 'claude', FILETIME_SECOND)).toBe('dead');
      expect(judgeLiveness(entry(null), running({ startEpochMs: WRITTEN + 2000 }), 'claude', FILETIME_SECOND)).toBe('unverified');
    });

    it('is dead when the name is readable and cannot be Claude', () => {
      expect(judgeLiveness(entry(START), running({ state: 'denied', ...unreadable }), 'svchost', FILETIME_SECOND)).toBe('dead');
      expect(judgeLiveness(entry(null), running({ path: 'C:\\Windows\\explorer.exe' }), 'explorer', FILETIME_SECOND)).toBe('dead');
    });

    it.each(['claude', 'claude-code', 'node', 'bun', 'deno'])('is unverified for a process named %s', (name) => {
      expect(judgeLiveness(entry(null), running({ path: null }), name, FILETIME_SECOND)).toBe('unverified');
    });

    it('is unverified when only the path says Claude', () => {
      const versioned = running({ path: '/home/x/.local/share/claude/versions/2.1.283' });
      expect(judgeLiveness(entry(null), versioned, '2.1.283', FILETIME_SECOND)).toBe('unverified');
    });

    it('is unverified when the process cannot be inspected (denied / partial)', () => {
      expect(judgeLiveness(entry(START), running({ state: 'denied', ...unreadable }), 'claude', FILETIME_SECOND)).toBe('unverified');
      expect(judgeLiveness(entry(START), running({ state: 'partial', ...unreadable }), 'claude', FILETIME_SECOND)).toBe('unverified');
    });

    it('is unverified when even the name is unreadable', () => {
      expect(judgeLiveness(entry(START), running({ state: 'denied', ...unreadable }), null, FILETIME_SECOND)).toBe('unverified');
    });

    it('treats an OS without a comparable start time as not comparable', () => {
      expect(judgeLiveness(entry(START - 500_000_000n), running(), 'claude', null)).toBe('unverified');
      expect(judgeLiveness(entry(START), running({ path: '/bin/ps' }), 'ps', null)).toBe('dead');
      expect(judgeLiveness(entry(START), running(), 'claude', Number.NaN)).toBe('unverified');
    });
  });
});
