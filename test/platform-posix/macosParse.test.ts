import { describe, expect, it } from 'vitest';

import {
  caffeinateArgs,
  macDetail,
  macPowerCommand,
  macProcessName,
  notificationArgs,
  parseCpuTime,
  parseHidIdleSeconds,
  parseLstartUtc,
  parsePsLine,
  parsePsOutput,
} from '../../src/platform/macos';
import type { CountdownAlertOptions } from '../../src/platform/types';
import { IOREG_OUTPUT, PS_OUTPUT } from './macFixtures';

describe('parseLstartUtc', () => {
  it('reads the C-locale date, whose day of month is space-padded', () => {
    expect(parseLstartUtc('Sat Oct  3 09:15:02 2026')).toBe(Date.UTC(2026, 9, 3, 9, 15, 2));
    expect(parseLstartUtc('Mon Sep 28 10:00:00 2026')).toBe(Date.UTC(2026, 8, 28, 10, 0, 0));
    expect(parseLstartUtc('Thu Jan  1 00:00:00 1970')).toBe(0);
    expect(parseLstartUtc('Tue Feb 29 23:59:59 2028')).toBe(Date.UTC(2028, 1, 29, 23, 59, 59));
  });

  it.each([
    '',
    'Sat Oct 3 2026',
    'Sat Okt  3 09:15:02 2026', // localised month: ps was not run with LC_ALL=C
    'Sob paź  3 09:15:02 2026',
    'Sat Oct 32 09:15:02 2026',
    'Sun Feb 30 09:15:02 2026',
    'Sat Oct  3 24:15:02 2026',
    'Sat Oct  3 09:61:02 2026',
    'Sat Oct  3 9:15:02 2026',
    'Sat Oct  3 09:15:02 26',
    '2026-10-03 09:15:02',
  ])('is null for %j', (text) => {
    expect(parseLstartUtc(text)).toBeNull();
  });
});

describe('parseCpuTime', () => {
  it.each([
    ['0:00.03', 0.03],
    ['0:41.07', 41.07],
    ['12:34.56', 754.56],
    ['123:45.67', 7425.67], // macOS prints minutes past 59
    ['1:02:03.45', 3723.45],
    ['2-03:04:05', 183_845],
    ['1-00:00:00.50', 86_400.5],
    ['0:00', 0],
  ])('%s -> %s s', (text, expected) => {
    expect(parseCpuTime(text)).toBeCloseTo(expected, 6);
  });

  it.each(['', '12', '1.5', 'abc', '1:2:3:4', '-1:00.00', '1:00.', ':30', '1-', '1:xx'])('is null for %j', (text) => {
    expect(parseCpuTime(text)).toBeNull();
  });
});

describe('parsePsLine', () => {
  it('reads pid, ppid, the five lstart tokens, the CPU time and the command', () => {
    expect(parsePsLine('  501     1 Sat Oct  3 09:15:02 2026   0:00.03 /usr/libexec/trustd')).toEqual({
      pid: 501,
      ppid: 1,
      startEpochMs: Date.UTC(2026, 9, 3, 9, 15, 2),
      cpuSeconds: 0.03,
      command: '/usr/libexec/trustd',
    });
  });

  it('keeps a command with spaces and parentheses whole', () => {
    const line =
      ' 4242     1 Sat Oct  3 11:00:00 2026   1:02.50 /Applications/Visual Studio Code.app/Contents/Frameworks/Code Helper (Plugin).app/Contents/MacOS/Code Helper (Plugin)  ';
    expect(parsePsLine(line)?.command).toBe(
      '/Applications/Visual Studio Code.app/Contents/Frameworks/Code Helper (Plugin).app/Contents/MacOS/Code Helper (Plugin)',
    );
  });

  it('accepts the kernel task (ppid 0) and a two-digit day', () => {
    const row = parsePsLine('    1     0 Mon Sep 28 10:00:00 2026   5:12.34 /sbin/launchd');
    expect(row).toMatchObject({ pid: 1, ppid: 0, startEpochMs: Date.UTC(2026, 8, 28, 10, 0, 0), command: '/sbin/launchd' });
    expect(row?.cpuSeconds).toBeCloseTo(312.34, 6);
  });

  it('keeps a row whose date or CPU time it cannot read, with that field unknown', () => {
    expect(parsePsLine(' 7001  4242 Sob paź  3 11:30:00 2026   0:12.00 /Users/u/.local/bin/claude')).toMatchObject({
      pid: 7001,
      startEpochMs: null,
      cpuSeconds: 12,
    });
    expect(parsePsLine(' 7001  4242 Sat Oct  3 11:30:00 2026   ??? /Users/u/.local/bin/claude')).toMatchObject({
      pid: 7001,
      startEpochMs: Date.UTC(2026, 9, 3, 11, 30, 0),
      cpuSeconds: null,
    });
  });

  it('keeps a row without a command', () => {
    expect(parsePsLine(' 7009     1 Sat Oct  3 11:34:00 2026   0:00.00')).toMatchObject({ pid: 7009, command: '' });
  });

  it.each(['', 'PID PPID STARTED TIME COMM', 'ps: illegal option -- z', '  abc 1 Sat Oct  3 11:30:00 2026 0:00.00 /bin/x', '0 0 Sat Oct  3 11:30:00 2026 0:00.00 /bin/x', '501 1 0:00.03'])(
    'is null for %j',
    (line) => {
      expect(parsePsLine(line)).toBeNull();
    },
  );
});

describe('parsePsOutput', () => {
  it('reads every row of a realistic listing', () => {
    const { rows, unparsed } = parsePsOutput(PS_OUTPUT);
    expect(unparsed).toBe(0);
    expect(rows.map((row) => row.pid)).toEqual([1, 321, 501, 4242, 7001, 7002, 7003, 7004, 7005]);
    const node = rows.find((row) => row.pid === 7002);
    expect(node).toMatchObject({ ppid: 7001, command: '/opt/homebrew/bin/node' });
    expect(node?.cpuSeconds).toBeCloseTo(7425.67, 6);
  });

  it('counts lines that are not rows', () => {
    expect(parsePsOutput(`${PS_OUTPUT}garbage line\n\n   \nmore garbage\n`).unparsed).toBe(2);
  });

  it('handles empty output and CRLF', () => {
    expect(parsePsOutput('')).toEqual({ rows: [], unparsed: 0 });
    expect(parsePsOutput('  501     1 Sat Oct  3 09:15:02 2026   0:00.03 /usr/libexec/trustd\r\n').rows).toHaveLength(1);
  });
});

describe('macProcessName', () => {
  it.each([
    ['/Users/u/.local/bin/claude', 'claude'],
    ['/Applications/Claude.app/Contents/MacOS/Claude', 'claude'],
    ['/Applications/Visual Studio Code.app/Contents/MacOS/Electron', 'electron'],
    ['/Applications/Visual Studio Code.app/Contents/Frameworks/Code Helper (Plugin).app/Contents/MacOS/Code Helper (Plugin)', 'code helper (plugin)'],
    ['-zsh', 'zsh'],
    ['(zsh)', '(zsh)'],
    ['', ''],
  ])('%j -> %j', (command, expected) => {
    expect(macProcessName(command)).toBe(expected);
  });
});

describe('macDetail', () => {
  const row = { pid: 7001, ppid: 4242, startEpochMs: 1_790_000_000_000, cpuSeconds: 12, command: '/Users/u/.local/bin/claude' };

  it('is ok with a path, a start and a CPU time; startRaw and ioBytes do not exist on macOS', () => {
    expect(macDetail(row)).toEqual({
      state: 'ok',
      path: '/Users/u/.local/bin/claude',
      startRaw: null,
      startEpochMs: 1_790_000_000_000,
      cpuSeconds: 12,
      ioBytes: null,
    });
  });

  it('has no path, and is partial, when ps printed only a name', () => {
    expect(macDetail({ ...row, command: '(claude)' })).toMatchObject({ state: 'partial', path: null });
    expect(macDetail({ ...row, command: '-zsh' })).toMatchObject({ state: 'partial', path: null });
    expect(macDetail({ ...row, command: '' })).toMatchObject({ state: 'partial', path: null });
  });

  it('is partial when the start or CPU time is unknown', () => {
    expect(macDetail({ ...row, startEpochMs: null })).toMatchObject({ state: 'partial', startEpochMs: null });
    expect(macDetail({ ...row, cpuSeconds: null })).toMatchObject({ state: 'partial', cpuSeconds: null });
  });
});

describe('parseHidIdleSeconds', () => {
  it('reads HIDIdleTime (nanoseconds) from ioreg output', () => {
    expect(parseHidIdleSeconds(IOREG_OUTPUT)).toBe(66.615);
  });

  it('survives values past 2^53 nanoseconds (104 days)', () => {
    expect(parseHidIdleSeconds('"HIDIdleTime" = 18000000000000000000')).toBe(18_000_000_000);
  });

  it('takes the most recent input when there are several entries', () => {
    expect(parseHidIdleSeconds('"HIDIdleTime" = 900000000000\n"HIDIdleTime" = 2000000000\n')).toBe(2);
  });

  it('reads zero as zero', () => {
    expect(parseHidIdleSeconds('      "HIDIdleTime" = 0')).toBe(0);
  });

  it.each(['', '"HIDIdleTime" = ', '"HIDIdleTime" = unknown', '"IOClass" = "IOHIDSystem"', 'HIDIdleTime = 5'])('is null for %j', (out) => {
    expect(parseHidIdleSeconds(out)).toBeNull();
  });
});

describe('command lines', () => {
  it('sleeps with pmset', () => {
    expect(macPowerCommand('sleep')).toMatchObject({ file: '/usr/bin/pmset', args: ['sleepnow'], suspends: true });
  });

  it('shuts down through System Events', () => {
    expect(macPowerCommand('shutdown')).toMatchObject({
      file: '/usr/bin/osascript',
      args: ['-e', 'tell application "System Events" to shut down'],
      suspends: false,
    });
  });

  it('locks by turning the display off, which never confirms a lock', () => {
    expect(macPowerCommand('lock')).toMatchObject({ file: '/usr/bin/pmset', args: ['displaysleepnow'], suspends: false, neverConfirmed: true });
    expect(macPowerCommand('sleep').neverConfirmed).toBeUndefined();
    expect(macPowerCommand('shutdown').neverConfirmed).toBeUndefined();
  });

  it('keeps awake only while the extension host lives', () => {
    expect(caffeinateArgs(4242)).toEqual(['-i', '-w', '4242']);
  });
});

describe('notificationArgs', () => {
  const options: CountdownAlertOptions = {
    seconds: 90,
    kind: 'real',
    title: 'Shutting down this PC in',
    body: 'All Claude sessions finished.',
    cancelLabel: 'Cancel: keep this PC on',
    sound: false,
  };

  it('passes the text as arguments of the run handler, not as AppleScript source', () => {
    const args = notificationArgs({ ...options, title: 'He said "stop" \\ and', body: 'quote " and backslash \\' }, 0);
    expect(args.slice(0, 6)).toEqual([
      '-e',
      'on run argv',
      '-e',
      'display notification (item 2 of argv) with title (item 1 of argv)',
      '-e',
      'end run',
    ]);
    expect(args[6]).toBe('He said "stop" \\ and 1:30');
    expect(args[7]).toMatch(/^quote " and backslash \\\nPlanned for \d\d:\d\d:\d\d\. To cancel, go back to your editor\.$/);
    expect(args).toHaveLength(8);
  });

  it('never lets the text look like an osascript option', () => {
    const args = notificationArgs({ ...options, title: '-l JavaScript', body: '-e evil' }, 0);
    expect(args[6]?.startsWith('-')).toBe(false);
    expect(args[7]?.startsWith('-')).toBe(false);
  });
});
