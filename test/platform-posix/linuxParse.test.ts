import { describe, expect, it } from 'vitest';

import {
  buildLinuxDetail,
  capabilityFromLogind,
  chooseProcessName,
  cleanExePath,
  commMayBeTruncated,
  hasExited,
  idleSecondsFromLogind,
  idleSources,
  inhibitArgs,
  isFlatpak,
  logindCanArgs,
  notifySendArgs,
  parseBootTimeSeconds,
  parseBusctlString,
  parseBusctlUint64,
  parseClockTicks,
  parseGdbusUint64,
  parseLoginctlProperties,
  parseProcIo,
  parseProcStat,
  parseXprintidle,
  sessionTargets,
  systemctlArgs,
  type LinuxClock,
  type ReadOutcome,
} from '../../src/platform/linux';
import type { CountdownAlertOptions } from '../../src/platform/types';
import { BOOT_TIME_SECONDS, ioFile, procStatFile, statLine } from './fakeSystem';

const ok = (value: string): ReadOutcome => ({ ok: true, value });
const failed = (code: string): ReadOutcome => ({ ok: false, code });
const CLOCK: LinuxClock = { ticksPerSecond: 100, bootTimeSeconds: BOOT_TIME_SECONDS };

// The line the Python reference tests with: comm contains spaces AND parentheses.
const REFERENCE_STAT = '4242 (Web (x) Content) S 1 4242 4242 0 -1 4194560 100 0 0 0 250 50 0 0 20 0 12 0 633076 123456 789';

describe('parseProcStat', () => {
  it('counts fields from the last parenthesis, so a comm with spaces and parentheses cannot shift them', () => {
    expect(parseProcStat(REFERENCE_STAT)).toEqual({
      comm: 'Web (x) Content',
      state: 'S',
      ppid: 1,
      cpuTicks: 300,
      startTicks: '633076',
    });
  });

  it('reads a full 52-field line as a current kernel prints it', () => {
    const line = statLine({ pid: 72450, comm: 'claude', state: 'R', ppid: 1200, utime: 8, stime: 3, start: 9_876_543 });
    expect(parseProcStat(line)).toEqual({ comm: 'claude', state: 'R', ppid: 1200, cpuTicks: 11, startTicks: '9876543' });
  });

  it('is not fooled by a comm that imitates the rest of a stat line', () => {
    const parsed = parseProcStat(statLine({ pid: 7, comm: 'evil) Z 1 (x', state: 'S', ppid: 55, start: 42 }));
    expect(parsed).toMatchObject({ comm: 'evil) Z 1 (x', state: 'S', ppid: 55, startTicks: '42' });
  });

  it('handles the names systemd and the kernel really use', () => {
    expect(parseProcStat(statLine({ pid: 900, comm: '(sd-pam)' }))?.comm).toBe('(sd-pam)');
    expect(parseProcStat(statLine({ pid: 2, comm: 'kthreadd', ppid: 0 }))).toMatchObject({ comm: 'kthreadd', ppid: 0 });
    expect(parseProcStat(statLine({ pid: 31, comm: 'kworker/0:1H-events_highpri' }))?.comm).toBe('kworker/0:1H-events_highpri');
  });

  it('reports a zombie as state Z', () => {
    const parsed = parseProcStat(statLine({ pid: 5150, comm: 'claude', state: 'Z', start: 633076 }));
    expect(parsed?.state).toBe('Z');
    expect(hasExited(parsed?.state ?? '')).toBe(true);
  });

  it('keeps what a short line has and leaves the rest unknown', () => {
    expect(parseProcStat('1 (x) S 1 2')).toEqual({ comm: 'x', state: 'S', ppid: 1, cpuTicks: null, startTicks: null });
    // utime present, stime missing: the sum is unknown, not "utime".
    expect(parseProcStat('1 (x) S 1 2 3 4 5 6 7 8 9 10 250')?.cpuTicks).toBeNull();
  });

  it('refuses a start time that is not a plain number', () => {
    const line = REFERENCE_STAT.replace('633076', '-5');
    expect(parseProcStat(line)?.startTicks).toBeNull();
  });

  it.each(['', '\n', '123 no parentheses S 1', 'abc (x) S 1 2', '12 (x)', '12 (x) ', '12 (x) 77 1 2', ') 12 ( S'])(
    'returns null for garbage %j',
    (raw) => {
      expect(parseProcStat(raw)).toBeNull();
    },
  );
});

describe('hasExited', () => {
  it.each([
    ['Z', true],
    ['X', true],
    ['x', true],
    ['R', false],
    ['S', false],
    ['D', false],
    ['I', false],
    ['T', false],
    ['t', false],
  ])('%s -> %s', (state, expected) => {
    expect(hasExited(state)).toBe(expected);
  });
});

describe('parseBootTimeSeconds', () => {
  it('finds btime in /proc/stat', () => {
    expect(parseBootTimeSeconds(procStatFile(1_790_000_000))).toBe(1_790_000_000);
  });

  it.each(['', 'cpu 1 2 3\n', 'btime\n', 'btime soon\n', 'xbtime 5\n', 'btime 12 13\n'])('is null for %j', (raw) => {
    expect(parseBootTimeSeconds(raw)).toBeNull();
  });
});

describe('parseProcIo', () => {
  it('adds rchar and wchar', () => {
    expect(parseProcIo(ioFile(323_934_931, 323_929_600))).toBe(647_864_531);
  });

  it('is null when either counter is missing or malformed', () => {
    expect(parseProcIo('rchar: 5\n')).toBeNull();
    expect(parseProcIo('wchar: 5\n')).toBeNull();
    expect(parseProcIo('rchar: many\nwchar: 5\n')).toBeNull();
    expect(parseProcIo('')).toBeNull();
  });
});

describe('parseClockTicks', () => {
  it.each([
    ['100\n', 100],
    ['250', 250],
    ['1024\n', 1024],
  ])('%j -> %s', (out, expected) => {
    expect(parseClockTicks(out)).toBe(expected);
  });

  it.each(['', 'undefined\n', '0\n', '-100\n', '1e2', '100 200', '99999999'])('rejects %j', (out) => {
    expect(parseClockTicks(out)).toBeNull();
  });
});

describe('process names', () => {
  it('strips the " (deleted)" suffix of a binary that was replaced by an update', () => {
    expect(cleanExePath('/home/u/.local/share/claude/versions/2.1.283 (deleted)')).toBe('/home/u/.local/share/claude/versions/2.1.283');
    expect(cleanExePath('/usr/bin/node')).toBe('/usr/bin/node');
  });

  it('knows when comm may have been cut (15 bytes, not 15 characters)', () => {
    expect(commMayBeTruncated('blender-softwar')).toBe(true);
    expect(commMayBeTruncated('blender')).toBe(false);
    expect(commMayBeTruncated('żółć-żółć')).toBe(true); // 9 characters, 17 bytes
  });

  it('uses the argv[0] file name when comm was cut at 15 bytes', () => {
    expect(chooseProcessName('blender-softwar', '/usr/bin/blender-softwaregl\0--background\0scene.blend\0')).toBe('blender-softwaregl');
    expect(chooseProcessName('chrome_crashpad', '/opt/google/chrome/chrome_crashpad_handler\0--monitor-self\0')).toBe('chrome_crashpad_handler');
  });

  it('keeps comm when argv[0] does not continue it', () => {
    // A script: comm is the script name, argv[0] the interpreter.
    expect(chooseProcessName('my-long-script-', '/usr/bin/python3\0/home/u/my-long-script-name.py\0')).toBe('my-long-script-');
    expect(chooseProcessName('exactly15chars!', '/usr/bin/exactly15chars!\0')).toBe('exactly15chars!');
  });

  it('never renames a complete comm, even when the program rewrote its title', () => {
    expect(chooseProcessName('nginx', 'nginx: worker process\0')).toBe('nginx');
    expect(chooseProcessName('claude', '/home/u/.local/bin/claude-something\0')).toBe('claude');
  });

  it('falls back to comm without a readable cmdline (kernel thread, other user)', () => {
    expect(chooseProcessName('kworker/u16:3-ev', null)).toBe('kworker/u16:3-ev');
    expect(chooseProcessName('blender-softwar', '')).toBe('blender-softwar');
  });

  it('lower-cases and drops a trailing .exe (ProcRow.name contract)', () => {
    expect(chooseProcessName('Xorg', null)).toBe('xorg');
    expect(chooseProcessName('Notepad.exe', null)).toBe('notepad');
  });
});

describe('buildLinuxDetail', () => {
  const stat = ok(statLine({ pid: 72450, comm: 'claude', utime: 250, stime: 50, start: 633076 }));
  const exe = ok('/home/u/.local/share/claude/versions/2.1.283');

  it('is ok when everything was read', () => {
    expect(buildLinuxDetail({ stat, exe, io: ok(ioFile(1000, 500)) }, CLOCK)).toEqual({
      state: 'ok',
      path: '/home/u/.local/share/claude/versions/2.1.283',
      startRaw: '633076',
      startEpochMs: 1_790_006_330_760,
      cpuSeconds: 3,
      ioBytes: 1500,
    });
  });

  it('scales with CLK_TCK', () => {
    const detail = buildLinuxDetail({ stat, exe, io: null }, { ticksPerSecond: 250, bootTimeSeconds: BOOT_TIME_SECONDS });
    expect(detail.cpuSeconds).toBe(1.2);
    expect(detail.startEpochMs).toBe(Math.round((BOOT_TIME_SECONDS + 633076 / 250) * 1000));
    expect(detail.startRaw).toBe('633076');
  });

  it('strips " (deleted)" from the path', () => {
    const detail = buildLinuxDetail({ stat, exe: ok('/opt/claude/claude (deleted)'), io: null }, CLOCK);
    expect(detail.path).toBe('/opt/claude/claude');
    expect(detail.state).toBe('ok');
  });

  it('is gone only when the kernel says there is no such process', () => {
    expect(buildLinuxDetail({ stat: failed('ENOENT'), exe: null, io: null }, CLOCK).state).toBe('gone');
    expect(buildLinuxDetail({ stat: failed('ESRCH'), exe: null, io: null }, CLOCK).state).toBe('gone');
  });

  it.each(['EACCES', 'EPERM', 'EIO', 'EMFILE', 'UNKNOWN'])('treats %s on stat as alive but unreadable, never dead', (code) => {
    expect(buildLinuxDetail({ stat: failed(code), exe: null, io: null }, CLOCK)).toEqual({
      state: 'denied',
      path: null,
      startRaw: null,
      startEpochMs: null,
      cpuSeconds: null,
      ioBytes: null,
    });
  });

  it('is partial with a null path when the exe link is not readable - comm is NOT used as a path', () => {
    const detail = buildLinuxDetail({ stat, exe: failed('EACCES'), io: failed('EACCES') }, CLOCK);
    expect(detail).toMatchObject({ state: 'partial', path: null, startRaw: '633076', cpuSeconds: 3, ioBytes: null });
  });

  it('reports a zombie as exited, with its start time still readable', () => {
    const zombie = ok(statLine({ pid: 72450, comm: 'claude', state: 'Z', start: 633076 }));
    const detail = buildLinuxDetail({ stat: zombie, exe: failed('ENOENT'), io: null }, CLOCK);
    expect(detail).toMatchObject({ state: 'exited', path: null, startRaw: '633076', ioBytes: null });
  });

  it('is partial when the stat line cannot be understood', () => {
    expect(buildLinuxDetail({ stat: ok('garbage'), exe, io: null }, CLOCK)).toMatchObject({ state: 'partial', path: null, startRaw: null });
  });

  it('is partial when the line is cut before the start time', () => {
    const detail = buildLinuxDetail({ stat: ok('72450 (claude) S 1 2'), exe, io: null }, CLOCK);
    expect(detail).toMatchObject({
      state: 'partial',
      path: '/home/u/.local/share/claude/versions/2.1.283',
      startRaw: null,
      startEpochMs: null,
      cpuSeconds: null,
    });
  });

  it('leaves the epoch start unknown without the boot time, and says partial', () => {
    const detail = buildLinuxDetail({ stat, exe, io: null }, { ticksPerSecond: 100, bootTimeSeconds: null });
    expect(detail).toMatchObject({ state: 'partial', startRaw: '633076', startEpochMs: null });
  });

  it('does not downgrade a process because its io file is unreadable', () => {
    expect(buildLinuxDetail({ stat, exe, io: failed('EACCES') }, CLOCK)).toMatchObject({ state: 'ok', ioBytes: null });
    expect(buildLinuxDetail({ stat, exe, io: ok('nonsense') }, CLOCK)).toMatchObject({ state: 'ok', ioBytes: null });
  });

  it('treats an empty exe link as unreadable', () => {
    expect(buildLinuxDetail({ stat, exe: ok(''), io: null }, CLOCK)).toMatchObject({ state: 'partial', path: null });
  });
});

describe('idle replies', () => {
  it('parses the busctl reply `t <ms>`', () => {
    expect(parseBusctlUint64('t 66615\n')).toBe(66615);
    expect(parseBusctlUint64('t 0')).toBe(0);
  });

  it.each(['', 's "yes"', 't', 't -5', 't 12 13', 'u 66615', 't 1.5', 'Failed to connect to bus'])('rejects busctl reply %j', (out) => {
    expect(parseBusctlUint64(out)).toBeNull();
  });

  it('parses the gdbus reply `(uint64 <ms>,)`', () => {
    expect(parseGdbusUint64('(uint64 66615,)\n')).toBe(66615);
    expect(parseGdbusUint64('(uint64 0,)')).toBe(0);
  });

  it.each(['', '(uint64 ,)', '(uint32 66615,)', 'uint64 66615', '(uint64 66615, uint64 5)', 'Error: GDBus.Error'])(
    'rejects gdbus reply %j',
    (out) => {
      expect(parseGdbusUint64(out)).toBeNull();
    },
  );

  it('parses xprintidle output', () => {
    expect(parseXprintidle('2500\n')).toBe(2500);
    expect(parseXprintidle('0\n')).toBe(0);
  });

  it.each(['', 'couldn\'t open display', '-1', '2500 ms', '2.5'])('rejects xprintidle output %j', (out) => {
    expect(parseXprintidle(out)).toBeNull();
  });
});

describe('logind replies', () => {
  it('parses busctl string replies', () => {
    expect(parseBusctlString('s "yes"\n')).toBe('yes');
    expect(parseBusctlString('s "challenge"')).toBe('challenge');
    expect(parseBusctlString('s ""')).toBe('');
  });

  it.each(['', 't 5', 's yes', 'yes', 's "yes" extra'])('rejects %j as a string reply', (out) => {
    expect(parseBusctlString(out)).toBeNull();
  });

  it('parses loginctl show-session output', () => {
    expect(parseLoginctlProperties('IdleHint=no\nIdleSinceHint=1790000123456789\nLockedHint=yes\n')).toEqual({
      IdleHint: 'no',
      IdleSinceHint: '1790000123456789',
      LockedHint: 'yes',
    });
    expect(parseLoginctlProperties('Name=a=b\n\nnoise\n=x\n')).toEqual({ Name: 'a=b' });
  });

  const NOW_MS = 1_790_000_600_000;
  const since = (msAgo: number): string => String((NOW_MS - msAgo) * 1000);

  it('IdleHint=yes: idle since the hint was set', () => {
    expect(idleSecondsFromLogind({ IdleHint: 'yes', IdleSinceHint: since(420_000) }, NOW_MS)).toBe(420);
  });

  it('IdleHint=no after the desktop has reported before: the user is active', () => {
    expect(idleSecondsFromLogind({ IdleHint: 'no', IdleSinceHint: since(5_000) }, NOW_MS)).toBe(0);
  });

  it('IdleSinceHint=0 means the desktop never reported anything: unknown, not "active"', () => {
    expect(idleSecondsFromLogind({ IdleHint: 'no', IdleSinceHint: '0' }, NOW_MS)).toBeNull();
    expect(idleSecondsFromLogind({ IdleHint: 'yes', IdleSinceHint: '0' }, NOW_MS)).toBeNull();
  });

  it('is unknown for anything else', () => {
    expect(idleSecondsFromLogind({}, NOW_MS)).toBeNull();
    expect(idleSecondsFromLogind({ IdleHint: 'yes' }, NOW_MS)).toBeNull();
    expect(idleSecondsFromLogind({ IdleHint: 'maybe', IdleSinceHint: since(1000) }, NOW_MS)).toBeNull();
    expect(idleSecondsFromLogind({ IdleHint: 'yes', IdleSinceHint: 'Sat 2026-10-03 12:00:00 UTC' }, NOW_MS)).toBeNull();
    // A hint from the future (clock was set back): no negative idle time.
    expect(idleSecondsFromLogind({ IdleHint: 'yes', IdleSinceHint: since(-60_000) }, NOW_MS)).toBeNull();
  });
});

describe('idleSources', () => {
  const ids = (env: NodeJS.ProcessEnv): string[] => idleSources(env).map((source) => source.id);

  it('never offers xprintidle on Wayland', () => {
    expect(ids({ XDG_SESSION_TYPE: 'wayland' })).toEqual(['mutter-busctl', 'mutter-gdbus', 'logind-auto']);
    expect(ids({})).toEqual(['mutter-busctl', 'mutter-gdbus', 'logind-auto']);
  });

  it('offers xprintidle on X11, after Mutter and before logind', () => {
    expect(ids({ XDG_SESSION_TYPE: 'x11', XDG_SESSION_ID: '3' })).toEqual([
      'mutter-busctl',
      'mutter-gdbus',
      'xprintidle',
      'logind-auto',
      'logind-3',
    ]);
  });

  it('asks Mutter exactly as documented', () => {
    const [busctl, gdbus] = idleSources({});
    expect(busctl).toMatchObject({
      tool: 'busctl',
      args: ['--user', 'call', 'org.gnome.Mutter.IdleMonitor', '/org/gnome/Mutter/IdleMonitor/Core', 'org.gnome.Mutter.IdleMonitor', 'GetIdletime'],
    });
    expect(gdbus).toMatchObject({
      tool: 'gdbus',
      args: [
        'call',
        '--session',
        '--dest',
        'org.gnome.Mutter.IdleMonitor',
        '--object-path',
        '/org/gnome/Mutter/IdleMonitor/Core',
        '--method',
        'org.gnome.Mutter.IdleMonitor.GetIdletime',
      ],
    });
  });

  it('converts each reply to seconds', () => {
    const sources = idleSources({ XDG_SESSION_TYPE: 'x11' });
    const parse = (id: string, out: string): number | null => sources.find((source) => source.id === id)?.parse(out, 1_790_000_600_000) ?? null;
    expect(parse('mutter-busctl', 't 66615\n')).toBe(66.615);
    expect(parse('mutter-gdbus', '(uint64 1500,)\n')).toBe(1.5);
    expect(parse('xprintidle', '2500\n')).toBe(2.5);
    expect(parse('logind-auto', 'IdleHint=yes\nIdleSinceHint=1790000000000000\n')).toBe(600);
    expect(parse('mutter-busctl', 'nonsense')).toBeNull();
  });

  it('only passes a well-formed session id to loginctl', () => {
    expect(sessionTargets({ XDG_SESSION_ID: 'c2' })).toEqual(['auto', 'c2']);
    expect(sessionTargets({ XDG_SESSION_ID: '--help' })).toEqual(['auto']);
    expect(sessionTargets({ XDG_SESSION_ID: '3; reboot' })).toEqual(['auto']);
    expect(sessionTargets({ XDG_SESSION_ID: '' })).toEqual(['auto']);
    expect(sessionTargets({})).toEqual(['auto']);
  });
});

describe('capabilityFromLogind', () => {
  it('yes is the only answer that allows the action', () => {
    expect(capabilityFromLogind('shutdown', 'yes').ok).toBe(true);
  });

  it.each(['challenge', 'no', 'na'])('%s is a refusal', (answer) => {
    for (const action of ['shutdown', 'hibernate', 'sleep'] as const) {
      const capability = capabilityFromLogind(action, answer);
      expect(capability.ok).toBe(false);
      expect(capability.detail).not.toBe('');
    }
  });

  it('says that a password prompt cannot be answered unattended', () => {
    expect(capabilityFromLogind('shutdown', 'challenge').detail).toMatch(/password/);
  });

  it.each([null, '', 'YES', 'maybe', 'true'])('anything else (%j) is unknown, never a pass', (answer) => {
    expect(capabilityFromLogind('sleep', answer).ok).toBeNull();
  });
});

describe('command lines', () => {
  it('asks logind about the matching Can* method', () => {
    const base = ['call', 'org.freedesktop.login1', '/org/freedesktop/login1', 'org.freedesktop.login1.Manager'];
    expect(logindCanArgs('shutdown')).toEqual([...base, 'CanPowerOff']);
    expect(logindCanArgs('hibernate')).toEqual([...base, 'CanHibernate']);
    expect(logindCanArgs('sleep')).toEqual([...base, 'CanSuspend']);
  });

  it('passes -i to poweroff only when forced', () => {
    expect(systemctlArgs('shutdown', true)).toEqual(['poweroff', '-i']);
    expect(systemctlArgs('shutdown', false)).toEqual(['poweroff']);
  });

  it('never passes -i to hibernate or suspend', () => {
    expect(systemctlArgs('hibernate', true)).toEqual(['hibernate']);
    expect(systemctlArgs('hibernate', false)).toEqual(['hibernate']);
    expect(systemctlArgs('sleep', true)).toEqual(['suspend']);
    expect(systemctlArgs('sleep', false)).toEqual(['suspend']);
  });

  it('inhibits idle and sleep for as long as cat has its stdin', () => {
    expect(inhibitArgs('/usr/bin/cat')).toEqual([
      '--what=idle:sleep',
      '--who=Claude Auto Shutdown',
      '--why=Claude Code sessions are still working',
      '/usr/bin/cat',
    ]);
  });
});

describe('notifySendArgs', () => {
  const options: CountdownAlertOptions = {
    seconds: 90,
    kind: 'real',
    title: 'Shutting down this PC in',
    body: 'All Claude sessions finished.',
    cancelLabel: 'Cancel: keep this PC on',
    sound: true,
  };

  it('sends a critical notification for a real countdown, with the text after `--`', () => {
    const args = notifySendArgs(options, Date.UTC(2026, 9, 3, 12, 0, 0));
    expect(args.slice(0, 9)).toEqual(['-u', 'critical', '-a', 'Claude Auto Shutdown', '-i', 'dialog-warning', '-t', '90000', '--']);
    expect(args[9]).toBe('Shutting down this PC in 1:30');
    expect(args[10]).toMatch(/^All Claude sessions finished\.\nPlanned for \d\d:\d\d:\d\d\. To cancel, go back to your editor\.$/);
    expect(args).toHaveLength(11);
  });

  it.each(['test', 'preview'] as const)('is not critical for a %s countdown', (kind) => {
    expect(notifySendArgs({ ...options, kind }, 0).slice(0, 2)).toEqual(['-u', 'normal']);
  });

  it('stays up until the same whole-second deadline it names, never longer', () => {
    const now = new Date(2026, 9, 3, 2, 59, 30, 500).getTime();
    const args = notifySendArgs({ ...options, seconds: 29.7 }, now);
    expect(args[7]).toBe('29000');
    expect(args[9]).toBe('Shutting down this PC in 0:29');
    expect(args[10]).toContain('Planned for 02:59:59.');
  });

  it('survives a nonsense duration', () => {
    const args = notifySendArgs({ ...options, seconds: Number.NaN }, 0);
    expect(args[7]).toBe('0');
    expect(args[9]).toBe('Shutting down this PC in 0:00');
  });
});

describe('isFlatpak', () => {
  it('detects FLATPAK_ID', () => {
    expect(isFlatpak({ FLATPAK_ID: 'com.visualstudio.code' }, () => false)).toBe(true);
  });

  it('detects /.flatpak-info', () => {
    expect(isFlatpak({}, (file) => file === '/.flatpak-info')).toBe(true);
  });

  it('is false on a normal install', () => {
    expect(isFlatpak({}, () => false)).toBe(false);
    expect(isFlatpak({ FLATPAK_ID: '' }, () => false)).toBe(false);
  });
});
