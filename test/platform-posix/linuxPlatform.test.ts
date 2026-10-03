// The whole Linux backend against a fake machine. Nothing here touches the real OS: /proc is an
// in-memory map and every tool is a scripted reply.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { FLATPAK_PROBLEM, createLinuxPlatform } from '../../src/platform/linux';
import type { CountdownAlertOptions, Platform } from '../../src/platform/types';
import { BOOT_TIME_SECONDS, FakeSystem, errno, fakeOptions, ioFile, statLine } from './fakeSystem';

const CLAUDE_EXE = '/home/u/.local/share/claude/versions/2.1.283';

function setup(configure?: (system: FakeSystem) => void): { system: FakeSystem; platform: Platform; lines: string[] } {
  const system = new FakeSystem();
  configure?.(system);
  const options = fakeOptions();
  return { system, platform: createLinuxPlatform(options, system), lines: options.lines };
}

/** A small but realistic desktop: init, a shell, two Claude sessions, a zombie and a kernel thread. */
function desktop(system: FakeSystem): void {
  system.mountProc([
    { pid: 1, comm: 'systemd', ppid: 0, start: 2, exe: errno('EACCES') },
    { pid: 2, comm: 'kthreadd', ppid: 0, start: 2 },
    { pid: 1200, comm: 'bash', ppid: 1, start: 5000, exe: '/usr/bin/bash' },
    { pid: 4242, comm: 'code', ppid: 1, start: 6000, exe: '/usr/share/code/code' },
    { pid: 72450, comm: 'claude', ppid: 1200, utime: 250, stime: 50, start: 633076, exe: CLAUDE_EXE, io: ioFile(1000, 500) },
    { pid: 72460, comm: '2.1.283', ppid: 1200, start: 640000, exe: `${CLAUDE_EXE} (deleted)`, io: ioFile(10, 20) },
    { pid: 72470, comm: 'claude', state: 'Z', ppid: 1200, start: 650000 },
    {
      pid: 72480,
      comm: 'blender-softwar',
      ppid: 1200,
      start: 660000,
      exe: '/usr/bin/blender-softwaregl',
      argv: ['/usr/bin/blender-softwaregl', '--background', 'scene.blend'],
    },
  ]);
}

describe('linux snapshot', () => {
  it('lists every running process with parent and lower-case name', async () => {
    const { platform } = setup(desktop);
    const snapshot = await platform.snapshot({ detailPids: [], detailNames: [] });
    expect(snapshot.problem).toBeNull();
    expect(snapshot.processes).toEqual([
      { pid: 1, ppid: 0, name: 'systemd' },
      { pid: 2, ppid: 0, name: 'kthreadd' },
      { pid: 1200, ppid: 1, name: 'bash' },
      { pid: 4242, ppid: 1, name: 'code' },
      { pid: 72450, ppid: 1200, name: 'claude' },
      { pid: 72460, ppid: 1200, name: '2.1.283' },
      { pid: 72480, ppid: 1200, name: 'blender-softwaregl' },
    ]);
    expect(snapshot.details).toEqual({});
    expect(snapshot.takenAtMs).toBe(Date.UTC(2026, 9, 3, 12, 0, 0));
  });

  it('does not list a zombie as a running process, but reports it as exited when asked by PID', async () => {
    const { platform } = setup(desktop);
    const snapshot = await platform.snapshot({ detailPids: [72470], detailNames: ['claude'] });
    expect(snapshot.processes?.some((row) => row.pid === 72470)).toBe(false);
    expect(snapshot.details[72470]).toMatchObject({ state: 'exited', path: null, startRaw: '650000' });
  });

  it('returns full detail for requested PIDs and for name matches', async () => {
    const { platform } = setup(desktop);
    const snapshot = await platform.snapshot({ detailPids: [1200], detailNames: ['claude'] });
    expect(snapshot.details[72450]).toEqual({
      state: 'ok',
      path: CLAUDE_EXE,
      startRaw: '633076',
      startEpochMs: 1_790_006_330_760,
      cpuSeconds: 3,
      ioBytes: 1500,
    });
    expect(snapshot.details[1200]).toMatchObject({ state: 'ok', path: '/usr/bin/bash', startRaw: '5000', ioBytes: null });
    expect(Object.keys(snapshot.details).map(Number).sort((a, b) => a - b)).toEqual([1200, 72450, 72460]);
  });

  it('also matches the executable path: the native binary is a file named after its version', async () => {
    const { platform } = setup(desktop);
    const snapshot = await platform.snapshot({ detailPids: [], detailNames: ['claude'] });
    expect(snapshot.details[72460]).toMatchObject({ state: 'ok', path: CLAUDE_EXE, startRaw: '640000', ioBytes: 30 });
  });

  it('keeps a process whose exe link is not readable alive, with a null path', async () => {
    const { platform } = setup(desktop);
    const snapshot = await platform.snapshot({ detailPids: [1], detailNames: [] });
    expect(snapshot.details[1]).toMatchObject({ state: 'partial', path: null, startRaw: '2' });
    expect(snapshot.processes?.find((row) => row.pid === 1)?.name).toBe('systemd');
  });

  it('reports a requested PID that does not exist as gone', async () => {
    const { platform } = setup(desktop);
    const snapshot = await platform.snapshot({ detailPids: [99999], detailNames: [] });
    expect(snapshot.details[99999]).toEqual({ state: 'gone', path: null, startRaw: null, startEpochMs: null, cpuSeconds: null, ioBytes: null });
  });

  it('skips a process that ends between the directory listing and the read, without a problem', async () => {
    const { platform } = setup((system) => {
      desktop(system);
      system.dirs.set('/proc', [...(system.dirs.get('/proc') as string[]), '80000', '80001']);
      system.files.set('/proc/80001/stat', errno('ESRCH'));
    });
    const snapshot = await platform.snapshot({ detailPids: [80000], detailNames: [] });
    expect(snapshot.problem).toBeNull();
    expect(snapshot.processes?.some((row) => row.pid === 80000 || row.pid === 80001)).toBe(false);
    expect(snapshot.details[80000]?.state).toBe('gone');
  });

  it('flags the list as incomplete when a listed process cannot be read for any other reason', async () => {
    const { platform } = setup((system) => {
      desktop(system);
      system.dirs.set('/proc', [...(system.dirs.get('/proc') as string[]), '80000', '80001']);
      system.files.set('/proc/80000/stat', errno('EACCES'));
      system.files.set('/proc/80001/stat', 'not a stat line');
    });
    const snapshot = await platform.snapshot({ detailPids: [80000], detailNames: [] });
    expect(snapshot.problem).toBe('2 running programs could not be inspected, so the list is incomplete.');
    expect(snapshot.processes).toHaveLength(7);
    expect(snapshot.details[80000]?.state).toBe('denied');
  });

  it('answers "unknown" for everything when /proc cannot be listed - nothing is called gone', async () => {
    const { platform } = setup((system) => {
      system.dirs.set('/proc', errno('EACCES'));
    });
    const snapshot = await platform.snapshot({ detailPids: [72450], detailNames: ['claude'] });
    expect(snapshot.processes).toBeNull();
    expect(snapshot.details).toEqual({});
    expect(snapshot.problem).toBe("Couldn't read the list of running programs (/proc: EACCES).");
    expect(platform.helperStatus()).toEqual({ tier: 'unavailable', problem: snapshot.problem });
  });

  it('treats a /proc without any process as unreadable', async () => {
    const { platform } = setup((system) => {
      system.dirs.set('/proc', ['cpuinfo', 'meminfo']);
    });
    const snapshot = await platform.snapshot({ detailPids: [72450], detailNames: [] });
    expect(snapshot.processes).toBeNull();
    expect(snapshot.details).toEqual({});
    expect(snapshot.problem).toMatch(/lists no processes/);
  });

  it('recovers the helper status once /proc can be listed again', async () => {
    const { system, platform } = setup((fake) => {
      fake.dirs.set('/proc', errno('EIO'));
    });
    await platform.snapshot({ detailPids: [], detailNames: [] });
    expect(platform.helperStatus().tier).toBe('unavailable');
    desktop(system);
    await platform.snapshot({ detailPids: [], detailNames: [] });
    expect(platform.helperStatus().tier).not.toBe('unavailable');
  });

  it('ignores invalid PIDs and empty detail names instead of matching everything', async () => {
    const { platform } = setup(desktop);
    const snapshot = await platform.snapshot({
      detailPids: [0, -5, 1.5, Number.NaN, '72450' as unknown as number],
      detailNames: ['', '  '],
    });
    expect(snapshot.details).toEqual({});
  });

  it('leaves the epoch start unknown when /proc/stat has no btime', async () => {
    const { platform } = setup((system) => {
      desktop(system);
      system.files.set('/proc/stat', 'cpu 1 2 3\n');
    });
    const snapshot = await platform.snapshot({ detailPids: [72450], detailNames: [] });
    expect(snapshot.details[72450]).toMatchObject({ state: 'partial', startRaw: '633076', startEpochMs: null });
  });

  it('includes the idle time and never rejects', async () => {
    const { platform } = setup((system) => {
      desktop(system);
      system.install('busctl');
      system.on('busctl', () => ({ stdout: 't 66615\n' }));
    });
    const snapshot = await platform.snapshot({ detailPids: [], detailNames: [] });
    expect(snapshot.idleSeconds).toBe(66.615);
  });

  it('turns an unexpected failure into an unknown snapshot', async () => {
    const { system, platform } = setup(desktop);
    system.readdir = () => {
      throw new Error('boom');
    };
    const snapshot = await platform.snapshot({ detailPids: [1], detailNames: [] });
    expect(snapshot.processes).toBeNull();
    expect(snapshot.details).toEqual({});
    expect(snapshot.problem).not.toBeNull();
  });

  it('reads many processes without losing any (bounded concurrency)', async () => {
    const { platform } = setup((system) => {
      system.mountProc(Array.from({ length: 500 }, (_, index) => ({ pid: 1000 + index, comm: `worker${index}`, start: index })));
    });
    const snapshot = await platform.snapshot({ detailPids: [], detailNames: ['worker49'] });
    expect(snapshot.processes).toHaveLength(500);
    expect(Object.keys(snapshot.details)).toHaveLength(11); // worker49 and worker490..499
  });
});

describe('linux clock ticks', () => {
  it('is 100 until getconf has been asked, then what getconf says', async () => {
    const { system, platform } = setup((fake) => {
      desktop(fake);
      fake.install('getconf');
      fake.on('getconf', () => ({ stdout: '250\n' }));
    });
    expect(platform.procStartUnitsPerSecond).toBe(100);
    const snapshot = await platform.snapshot({ detailPids: [72450], detailNames: [] });
    expect(platform.procStartUnitsPerSecond).toBe(250);
    expect(snapshot.details[72450]).toMatchObject({ cpuSeconds: 1.2, startEpochMs: Math.round((BOOT_TIME_SECONDS + 633076 / 250) * 1000) });
    await platform.snapshot({ detailPids: [], detailNames: [] });
    expect(system.callsTo('getconf')).toHaveLength(1);
    expect(system.callsTo('getconf')[0]?.args).toEqual(['CLK_TCK']);
  });

  it.each([
    ['getconf is missing', undefined],
    ['getconf fails', { code: 1, stderr: 'getconf: Unrecognized variable' }],
    ['getconf prints nonsense', { stdout: 'undefined\n' }],
  ])('stays at 100 when %s', async (_name, reply) => {
    const { platform } = setup((fake) => {
      desktop(fake);
      if (reply !== undefined) {
        fake.install('getconf');
        fake.on('getconf', () => reply);
      }
    });
    await platform.probe([72450]);
    expect(platform.procStartUnitsPerSecond).toBe(100);
  });
});

describe('linux probe', () => {
  it('returns detail per PID, gone for a missing one', async () => {
    const { platform } = setup(desktop);
    const details = await platform.probe([72450, 99999, 72470]);
    expect(details[72450]).toMatchObject({ state: 'ok', path: CLAUDE_EXE, cpuSeconds: 3, ioBytes: 1500 });
    expect(details[99999]?.state).toBe('gone');
    expect(details[72470]?.state).toBe('exited');
  });

  it('leaves invalid PIDs out (unknown)', async () => {
    const { platform } = setup(desktop);
    expect(await platform.probe([0, -1, 2.5, Number.NaN])).toEqual({});
    expect(await platform.probe([])).toEqual({});
  });

  it('calls nothing gone while /proc itself does not answer', async () => {
    const { platform } = setup(); // no /proc at all: every read fails with ENOENT
    expect(await platform.probe([72450, 1])).toEqual({});
  });

  it('never rejects', async () => {
    const { system, platform } = setup(desktop);
    system.readFile = () => {
      throw new Error('boom');
    };
    await expect(platform.probe([72450])).resolves.toEqual({ 72450: expect.objectContaining({ state: 'denied' }) });
  });
});

describe('linux idle time', () => {
  it('prefers Mutter through busctl', async () => {
    const { system, platform } = setup((fake) => {
      fake.install('busctl');
      fake.install('gdbus');
      fake.on('busctl', () => ({ stdout: 't 66615\n' }));
    });
    expect(await platform.idleSeconds()).toBe(66.615);
    expect(system.calls).toHaveLength(1);
    expect(system.calls[0]).toMatchObject({
      file: '/usr/bin/busctl',
      args: ['--user', 'call', 'org.gnome.Mutter.IdleMonitor', '/org/gnome/Mutter/IdleMonitor/Core', 'org.gnome.Mutter.IdleMonitor', 'GetIdletime'],
    });
    expect(system.calls[0]?.options.timeoutMs).toBe(5000);
    expect(platform.helperStatus()).toEqual({ tier: 'full', problem: null });
  });

  it('falls back to gdbus when busctl cannot reach Mutter', async () => {
    const { platform } = setup((fake) => {
      fake.install('busctl');
      fake.install('gdbus');
      fake.on('busctl', () => ({ code: 1, stderr: 'Call failed: The name is not activatable' }));
      fake.on('gdbus', () => ({ stdout: '(uint64 1500,)\n' }));
    });
    expect(await platform.idleSeconds()).toBe(1.5);
  });

  it('uses xprintidle on X11 when Mutter is not there', async () => {
    const { platform } = setup((fake) => {
      fake.env = { XDG_SESSION_TYPE: 'x11' };
      fake.install('xprintidle');
      fake.on('xprintidle', () => ({ stdout: '2500\n' }));
    });
    expect(await platform.idleSeconds()).toBe(2.5);
  });

  it('does NOT trust xprintidle under Wayland', async () => {
    const { system, platform } = setup((fake) => {
      fake.env = { XDG_SESSION_TYPE: 'wayland' };
      fake.install('xprintidle');
      fake.on('xprintidle', () => ({ stdout: '999000\n' }));
    });
    expect(await platform.idleSeconds()).toBeNull();
    expect(system.callsTo('xprintidle')).toHaveLength(0);
  });

  it('uses the logind idle hint as a last resort', async () => {
    const { system, platform } = setup((fake) => {
      fake.install('loginctl');
      const sinceMicros = (fake.nowMs - 420_000) * 1000;
      fake.on('loginctl', () => ({ stdout: `IdleHint=yes\nIdleSinceHint=${sinceMicros}\n` }));
    });
    expect(await platform.idleSeconds()).toBe(420);
    expect(system.calls[0]?.args).toEqual(['show-session', 'auto', '-p', 'IdleHint', '-p', 'IdleSinceHint']);
  });

  it('asks about the own session when logind does not know "auto"', async () => {
    const { platform } = setup((fake) => {
      fake.env = { XDG_SESSION_ID: 'c2' };
      fake.install('loginctl');
      fake.on('loginctl', (args) =>
        args[1] === 'c2' ? { stdout: `IdleHint=no\nIdleSinceHint=${(fake.nowMs - 1000) * 1000}\n` } : { code: 1, stderr: "No session 'auto' known" },
      );
    });
    expect(await platform.idleSeconds()).toBe(0);
  });

  it('is null - never 0 - when no source answers, and says so in the helper status', async () => {
    const { platform } = setup((fake) => {
      fake.env = { XDG_SESSION_TYPE: 'x11' };
      fake.install('busctl');
      fake.install('gdbus');
      fake.install('xprintidle');
      fake.install('loginctl');
      fake.on('busctl', () => ({ code: 1 }));
      fake.on('gdbus', () => ({ timedOut: true, code: null }));
      fake.on('xprintidle', () => ({ stdout: "couldn't open display\n" }));
      fake.on('loginctl', () => ({ stdout: 'IdleHint=no\nIdleSinceHint=0\n' }));
    });
    expect(await platform.idleSeconds()).toBeNull();
    const status = platform.helperStatus();
    expect(status.tier).toBe('limited');
    expect(status.problem).toMatch(/how long you've been away/);
  });

  it('is null when no tool is installed at all', async () => {
    const { system, platform } = setup();
    expect(await platform.idleSeconds()).toBeNull();
    expect(system.calls).toHaveLength(0);
  });

  it('does not ask a failed source again on every poll, but retries it after a minute', async () => {
    const { system, platform } = setup((fake) => {
      fake.install('busctl');
      fake.install('loginctl');
      fake.on('busctl', () => ({ code: 1 }));
      const sinceMicros = (fake.nowMs - 60_000) * 1000;
      fake.on('loginctl', () => ({ stdout: `IdleHint=yes\nIdleSinceHint=${sinceMicros}\n` }));
    });
    expect(await platform.idleSeconds()).toBe(60);
    system.nowMs += 10_000;
    expect(await platform.idleSeconds()).toBe(70);
    expect(system.callsTo('busctl')).toHaveLength(1);

    system.on('busctl', () => ({ stdout: 't 5000\n' }));
    system.nowMs += 60_000;
    expect(await platform.idleSeconds()).toBe(5);
    expect(system.callsTo('busctl')).toHaveLength(2);
  });

  it('cleans the environment of the tools it spawns', async () => {
    const { system, platform } = setup((fake) => {
      fake.env = {
        HOME: '/home/u',
        DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/1000/bus',
        LD_LIBRARY_PATH: '/snap/code/1/usr/lib',
        GIO_MODULE_DIR: '/snap/code/1/gio',
        GTK_PATH: '/snap/code/1/gtk',
        XDG_DATA_DIRS: '/snap/code/1/share',
        XDG_DATA_DIRS_VSCODE_SNAP_ORIG: '/usr/share',
        LC_ALL: 'pl_PL.UTF-8',
      };
      fake.install('busctl');
      fake.on('busctl', () => ({ stdout: 't 1000\n' }));
    });
    await platform.idleSeconds();
    expect(system.calls[0]?.options.env).toEqual({
      HOME: '/home/u',
      DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/1000/bus',
      XDG_DATA_DIRS: '/usr/share',
      LC_ALL: 'C',
    });
  });

  it('never rejects', async () => {
    const { system, platform } = setup((fake) => {
      fake.install('busctl');
    });
    system.run = () => Promise.reject(new Error('boom'));
    await expect(platform.idleSeconds()).resolves.toBeNull();
  });
});

describe('linux capability', () => {
  const withLogind = (answer: string) => (fake: FakeSystem) => {
    fake.install('systemctl');
    fake.install('busctl');
    fake.on('busctl', () => ({ stdout: `s "${answer}"\n` }));
  };

  it.each([
    ['shutdown', 'CanPowerOff'],
    ['hibernate', 'CanHibernate'],
    ['sleep', 'CanSuspend'],
  ] as const)('asks logind %s -> %s and allows on "yes"', async (action, method) => {
    const { system, platform } = setup(withLogind('yes'));
    expect(await platform.capability(action)).toEqual({ ok: true, detail: 'Allowed by this system.' });
    expect(system.calls).toHaveLength(1);
    expect(system.calls[0]).toMatchObject({
      file: '/usr/bin/busctl',
      args: ['call', 'org.freedesktop.login1', '/org/freedesktop/login1', 'org.freedesktop.login1.Manager', method],
    });
  });

  it.each(['challenge', 'no', 'na'])('refuses on "%s"', async (answer) => {
    const { platform } = setup(withLogind(answer));
    expect((await platform.capability('shutdown')).ok).toBe(false);
    expect((await platform.capability('hibernate')).ok).toBe(false);
  });

  it('is unknown when busctl is not installed', async () => {
    const { system, platform } = setup((fake) => {
      fake.install('systemctl');
    });
    const capability = await platform.capability('shutdown');
    expect(capability.ok).toBeNull();
    expect(capability.detail).toMatch(/busctl was not found/);
    expect(system.calls).toHaveLength(0);
  });

  it('is unknown when logind does not answer', async () => {
    const { platform } = setup((fake) => {
      fake.install('systemctl');
      fake.install('busctl');
      fake.on('busctl', () => ({ code: 1, stderr: 'Failed to connect to bus: No such file or directory\n' }));
    });
    const capability = await platform.capability('sleep');
    expect(capability.ok).toBeNull();
    expect(capability.detail).toMatch(/Failed to connect to bus/);
  });

  it('is unknown when the query times out or the reply is not understood', async () => {
    const timedOut = setup((fake) => {
      fake.install('systemctl');
      fake.install('busctl');
      fake.on('busctl', () => ({ timedOut: true, code: null }));
    });
    expect((await timedOut.platform.capability('shutdown')).ok).toBeNull();

    const garbage = setup(withLogind('perhaps'));
    expect((await garbage.platform.capability('shutdown')).ok).toBeNull();
  });

  it('refuses when systemctl is missing, whatever logind would say', async () => {
    const { system, platform } = setup((fake) => {
      fake.install('busctl');
      fake.on('busctl', () => ({ stdout: 's "yes"\n' }));
    });
    const capability = await platform.capability('shutdown');
    expect(capability.ok).toBe(false);
    expect(capability.detail).toMatch(/systemctl was not found/);
    expect(system.calls).toHaveLength(0);
  });

  it('lock needs loginctl and nothing else', async () => {
    const present = setup((fake) => {
      fake.install('loginctl');
    });
    expect((await present.platform.capability('lock')).ok).toBe(true);
    expect(present.system.calls).toHaveLength(0);

    const absent = setup();
    expect((await absent.platform.capability('lock')).ok).toBe(false);
  });

  it('notify is always possible', async () => {
    const { system, platform } = setup();
    expect((await platform.capability('notify')).ok).toBe(true);
    expect(system.calls).toHaveLength(0);
  });

  it('answers unknown for an action that does not exist', async () => {
    const { platform } = setup(withLogind('yes'));
    expect((await platform.capability('reboot' as never)).ok).toBeNull();
  });

  it('never rejects', async () => {
    const { system, platform } = setup(withLogind('yes'));
    system.run = () => Promise.reject(new Error('boom'));
    expect((await platform.capability('shutdown')).ok).toBeNull();
  });
});

describe('linux execute', () => {
  const powerTools = (fake: FakeSystem): void => {
    fake.install('systemctl');
    fake.install('loginctl');
  };

  it('refuses every power action when CLAUDE_AUTOSHUTDOWN_NO_POWER=1, without spawning anything', async () => {
    const { system, platform } = setup((fake) => {
      powerTools(fake);
      fake.env = { CLAUDE_AUTOSHUTDOWN_NO_POWER: '1' };
    });
    for (const action of ['shutdown', 'hibernate', 'sleep', 'lock'] as const) {
      const result = await platform.execute(action, { force: true });
      expect(result).toEqual({
        ok: false,
        detail: 'Power actions are switched off here (CLAUDE_AUTOSHUTDOWN_NO_POWER=1), so nothing was run.',
        command: null,
        exitCode: null,
        confirmed: null,
      });
    }
    expect(system.calls).toHaveLength(0);
    expect(system.holds).toHaveLength(0);
  });

  it.each([
    ['shutdown', true, ['poweroff', '-i'], '/usr/bin/systemctl poweroff -i'],
    ['shutdown', false, ['poweroff'], '/usr/bin/systemctl poweroff'],
    ['hibernate', true, ['hibernate'], '/usr/bin/systemctl hibernate'],
    ['sleep', true, ['suspend'], '/usr/bin/systemctl suspend'],
  ] as const)('%s (force %s) runs systemctl %j by absolute path', async (action, force, args, command) => {
    const { system, platform } = setup(powerTools);
    const result = await platform.execute(action, { force });
    // systemctl returns once logind accepted the request: nothing shows that it happened.
    expect(result).toMatchObject({ ok: true, command, exitCode: 0, confirmed: null });
    expect(system.calls).toHaveLength(1);
    expect(system.calls[0]).toMatchObject({ file: '/usr/bin/systemctl', args });
    expect(system.calls[0]?.options.timeoutMs).toBe(25_000);
  });

  it('only forces when force is literally true', async () => {
    const { system, platform } = setup(powerTools);
    await platform.execute('shutdown', { force: 'yes' as unknown as boolean });
    await platform.execute('shutdown', undefined as unknown as { force: boolean });
    expect(system.calls.map((call) => call.args)).toEqual([['poweroff'], ['poweroff']]);
  });

  it('reports a refusal by systemctl as a failed action, with its message', async () => {
    const { platform } = setup((fake) => {
      powerTools(fake);
      fake.on('systemctl', () => ({ code: 1, stderr: 'Call to PowerOff failed: Access denied\n' }));
    });
    const result = await platform.execute('shutdown', { force: true });
    expect(result.ok).toBe(false);
    expect(result.exitCode).toBe(1);
    expect(result.command).toBe('/usr/bin/systemctl poweroff -i');
    expect(result.detail).toBe('systemctl failed with exit code 1: Call to PowerOff failed: Access denied');
  });

  it('fails when systemctl is not installed', async () => {
    const { system, platform } = setup();
    const result = await platform.execute('shutdown', { force: true });
    expect(result).toMatchObject({ ok: false, command: null, exitCode: null });
    expect(result.detail).toMatch(/systemctl was not found/);
    expect(system.calls).toHaveLength(0);
  });

  it('fails when systemctl cannot be started', async () => {
    const { platform } = setup((fake) => {
      powerTools(fake);
      fake.on('systemctl', () => ({ started: false, code: null, error: 'spawn EACCES' }));
    });
    const result = await platform.execute('sleep', { force: false });
    expect(result.ok).toBe(false);
    expect(result.detail).toMatch(/could not be started \(spawn EACCES\)/);
  });

  it('fails a shutdown that hangs', async () => {
    const { platform } = setup((fake) => {
      powerTools(fake);
      fake.on('systemctl', () => ({ timedOut: true, code: null, elapsedMs: 25_010 }));
    });
    const result = await platform.execute('shutdown', { force: true });
    expect(result).toMatchObject({ ok: false, exitCode: null });
    expect(result.detail).toMatch(/did not answer in time/);
  });

  it('fails a sleep that hangs without the clock jumping: the machine never slept', async () => {
    const { platform } = setup((fake) => {
      powerTools(fake);
      fake.on('systemctl', () => ({ timedOut: true, code: null, elapsedMs: 25_010 }));
    });
    expect((await platform.execute('sleep', { force: false })).ok).toBe(false);
  });

  it.each(['sleep', 'hibernate'] as const)('counts a %s as done when the wall clock jumped past the timeout: we slept', async (action) => {
    const { platform } = setup((fake) => {
      powerTools(fake);
      fake.on('systemctl', () => ({ timedOut: true, code: null, elapsedMs: 8 * 3600 * 1000 }));
    });
    const result = await platform.execute(action, { force: false });
    expect(result).toMatchObject({ ok: true, confirmed: true });
    expect(result.detail).toMatch(/woken up again/);
  });

  it('does not excuse a late, failed shutdown as "we slept"', async () => {
    const { platform } = setup((fake) => {
      powerTools(fake);
      fake.on('systemctl', () => ({ code: 1, stderr: 'nope', elapsedMs: 8 * 3600 * 1000 }));
    });
    expect((await platform.execute('shutdown', { force: true })).ok).toBe(false);
  });

  it('notify is a no-op that succeeds, even with power actions switched off', async () => {
    const { system, platform } = setup((fake) => {
      fake.env = { CLAUDE_AUTOSHUTDOWN_NO_POWER: '1' };
    });
    expect(await platform.execute('notify', { force: true })).toMatchObject({ ok: true, command: null, exitCode: null });
    expect(system.calls).toHaveLength(0);
  });

  it('fails for an action that does not exist, without running anything', async () => {
    const { system, platform } = setup(powerTools);
    expect((await platform.execute('reboot' as never, { force: true })).ok).toBe(false);
    expect(system.calls).toHaveLength(0);
  });

  it('releases its own sleep inhibitor before asking for sleep', async () => {
    const { system, platform } = setup((fake) => {
      powerTools(fake);
      fake.install('systemd-inhibit');
      fake.install('cat');
    });
    await platform.keepAwake(true);
    const order: string[] = [];
    system.on('systemctl', () => {
      order.push(`systemctl while inhibitor stopped=${String(system.holds[0]?.stopped)}`);
      return {};
    });
    expect((await platform.execute('sleep', { force: false })).ok).toBe(true);
    expect(order).toEqual(['systemctl while inhibitor stopped=true']);
  });

  it('never rejects', async () => {
    const { system, platform } = setup(powerTools);
    system.run = () => Promise.reject(new Error('boom'));
    const result = await platform.execute('shutdown', { force: true });
    expect(result.ok).toBe(false);
    expect(result.detail).toMatch(/boom/);
  });
});

describe('linux lock', () => {
  it('locks the session logind picks, then confirms with LockedHint', async () => {
    const { system, platform } = setup((fake) => {
      fake.install('loginctl');
      fake.on('loginctl', (args) => (args[0] === 'show-session' ? { stdout: 'LockedHint=yes\n' } : {}));
    });
    const result = await platform.execute('lock', { force: false });
    expect(result).toEqual({ ok: true, detail: 'The screen is locked.', command: '/usr/bin/loginctl lock-session auto', exitCode: 0, confirmed: true });
    expect(system.calls.map((call) => call.args)).toEqual([
      ['lock-session', 'auto'],
      ['show-session', 'auto', '-p', 'LockedHint'],
    ]);
  });

  it('waits a little for the desktop to lock', async () => {
    let asked = 0;
    const { platform } = setup((fake) => {
      fake.install('loginctl');
      fake.on('loginctl', (args) => {
        if (args[0] !== 'show-session') return {};
        asked++;
        return { stdout: asked >= 3 ? 'LockedHint=yes\n' : 'LockedHint=no\n' };
      });
    });
    expect((await platform.execute('lock', { force: false })).detail).toBe('The screen is locked.');
    expect(asked).toBe(3);
  });

  it('still succeeds, but reports it as NOT confirmed, when the desktop never confirms', async () => {
    const { system, platform } = setup((fake) => {
      fake.install('loginctl');
      fake.on('loginctl', (args) => (args[0] === 'show-session' ? { stdout: 'LockedHint=no\n' } : {}));
    });
    const started = system.nowMs;
    const result = await platform.execute('lock', { force: false });
    expect(result).toMatchObject({ ok: true, confirmed: false });
    expect(result.detail).toMatch(/didn't confirm/);
    expect(system.callsTo('loginctl').filter((call) => call.args[0] === 'show-session')).toHaveLength(6);
    expect(system.nowMs - started).toBe(3000);
  });

  it('falls back to $XDG_SESSION_ID when "auto" is refused', async () => {
    const { system, platform } = setup((fake) => {
      fake.env = { XDG_SESSION_ID: '3' };
      fake.install('loginctl');
      fake.on('loginctl', (args) => {
        if (args[0] === 'show-session') return { stdout: 'LockedHint=yes\n' };
        return args[1] === 'auto' ? { code: 1, stderr: "Could not lock session: No session 'auto' known\n" } : {};
      });
    });
    const result = await platform.execute('lock', { force: false });
    expect(result).toMatchObject({ ok: true, command: '/usr/bin/loginctl lock-session 3' });
    expect(system.calls.map((call) => call.args)).toEqual([
      ['lock-session', 'auto'],
      ['lock-session', '3'],
      ['show-session', '3', '-p', 'LockedHint'],
    ]);
  });

  it('fails with the message of loginctl when no session can be locked', async () => {
    const { platform } = setup((fake) => {
      fake.install('loginctl');
      fake.on('loginctl', () => ({ code: 1, stderr: "Could not lock session: No session 'auto' known\n" }));
    });
    const result = await platform.execute('lock', { force: false });
    expect(result).toMatchObject({ ok: false, exitCode: 1, command: '/usr/bin/loginctl lock-session auto' });
    expect(result.detail).toMatch(/No session 'auto' known/);
  });

  it('fails when loginctl is not installed', async () => {
    const { platform } = setup();
    const result = await platform.execute('lock', { force: false });
    expect(result).toMatchObject({ ok: false, command: null });
    expect(result.detail).toMatch(/loginctl was not found/);
  });
});

describe('linux keep awake', () => {
  const inhibitTools = (fake: FakeSystem): void => {
    fake.install('systemd-inhibit');
    fake.install('cat', '/bin');
  };

  it('holds a systemd inhibitor that lives as long as its stdin pipe', async () => {
    const { system, platform } = setup(inhibitTools);
    expect(await platform.keepAwake(true)).toEqual({ ok: true, detail: 'Keeping this computer awake while Claude works.' });
    expect(system.holds).toHaveLength(1);
    expect(system.holds[0]).toMatchObject({
      file: '/usr/bin/systemd-inhibit',
      args: ['--what=idle:sleep', '--who=Claude Auto Shutdown', '--why=Claude Code sessions are still working', '/bin/cat'],
      stopped: false,
    });
  });

  it('is idempotent', async () => {
    const { system, platform } = setup(inhibitTools);
    await platform.keepAwake(true);
    expect((await platform.keepAwake(true)).ok).toBe(true);
    expect(system.holds).toHaveLength(1);
  });

  it('releases the inhibitor', async () => {
    const { system, platform } = setup(inhibitTools);
    await platform.keepAwake(true);
    expect((await platform.keepAwake(false)).ok).toBe(true);
    expect(system.holds[0]?.stopped).toBe(true);
    expect((await platform.keepAwake(false)).ok).toBe(true);
    await platform.keepAwake(true);
    expect(system.holds).toHaveLength(2);
  });

  it('does not wait for ever for a child that ignores the stop', async () => {
    const { system, platform } = setup(inhibitTools);
    await platform.keepAwake(true);
    const held = system.holds[0];
    if (held) held.exitsOnStop = false;
    const before = system.nowMs;
    expect((await platform.keepAwake(false)).ok).toBe(true);
    expect(system.nowMs - before).toBe(2000);
  });

  it('reports a refused inhibitor', async () => {
    const { system, platform } = setup((fake) => {
      inhibitTools(fake);
      fake.holdEndsWith = { code: 1, stderr: 'Failed to inhibit: Access denied\n' };
    });
    expect(await platform.keepAwake(true)).toEqual({ ok: false, detail: "Can't keep this computer awake: Failed to inhibit: Access denied" });
    // A later attempt starts a fresh child instead of believing the dead one.
    system.holdEndsWith = null;
    expect((await platform.keepAwake(true)).ok).toBe(true);
    expect(system.holds).toHaveLength(2);
  });

  it('notices when the inhibitor dies later', async () => {
    const { system, platform } = setup(inhibitTools);
    await platform.keepAwake(true);
    system.holds[0]?.exit(143);
    await Promise.resolve();
    await platform.keepAwake(true);
    expect(system.holds).toHaveLength(2);
  });

  it.each(['systemd-inhibit', 'cat'])('is not possible without %s', async (missing) => {
    const { system, platform } = setup((fake) => {
      for (const tool of ['systemd-inhibit', 'cat']) if (tool !== missing) fake.install(tool);
    });
    const outcome = await platform.keepAwake(true);
    expect(outcome.ok).toBe(false);
    expect(outcome.detail).toContain(`${missing} was not found`);
    expect(system.holds).toHaveLength(0);
  });

  it('applies quick on / off calls in order', async () => {
    const { system, platform } = setup(inhibitTools);
    const outcomes = await Promise.all([platform.keepAwake(true), platform.keepAwake(false), platform.keepAwake(true)]);
    expect(outcomes.map((outcome) => outcome.ok)).toEqual([true, true, true]);
    expect(system.holds.map((held) => held.stopped)).toEqual([true, false]);
  });

  it('is released by dispose', async () => {
    const { system, platform } = setup(inhibitTools);
    await platform.keepAwake(true);
    await platform.dispose();
    expect(system.holds[0]?.stopped).toBe(true);
  });
});

describe('linux environment', () => {
  it('has no problem on a normal install', () => {
    const { platform } = setup();
    expect(platform.environmentProblem()).toBeNull();
    expect(platform.helperStatus()).toEqual({ tier: 'full', problem: null });
  });

  it('refuses to work inside Flatpak (FLATPAK_ID)', () => {
    const { platform } = setup((fake) => {
      fake.env = { FLATPAK_ID: 'com.visualstudio.code' };
    });
    expect(platform.environmentProblem()).toBe("VS Code runs inside Flatpak, so other programs on this PC can't be seen.");
    expect(platform.helperStatus()).toEqual({ tier: 'unavailable', problem: FLATPAK_PROBLEM });
  });

  it('refuses to work inside Flatpak (/.flatpak-info)', () => {
    const { platform } = setup((fake) => {
      fake.present.add('/.flatpak-info');
    });
    expect(platform.environmentProblem()).toBe(FLATPAK_PROBLEM);
  });

  it('describes itself', async () => {
    const { platform } = setup();
    expect(platform).toMatchObject({ id: 'linux', osName: 'Linux', experimental: false, procStartUnitsPerSecond: 100 });
    expect(await platform.foreignRoots()).toEqual({ roots: [], problem: null });
  });

  it('finds tools only in fixed system directories, never through PATH', async () => {
    const { system, platform } = setup((fake) => {
      fake.env = { PATH: '/home/u/workspace/bin' };
      fake.present.add('/home/u/workspace/bin/systemctl');
      fake.present.add('/home/u/workspace/bin/busctl');
    });
    expect((await platform.capability('shutdown')).ok).toBe(false);
    expect((await platform.execute('shutdown', { force: true })).ok).toBe(false);
    expect(system.calls).toHaveLength(0);
  });
});

describe('linux countdown alert', () => {
  const options: CountdownAlertOptions = {
    seconds: 30,
    kind: 'real',
    title: 'Shutting down this PC in',
    body: 'All Claude sessions finished.',
    cancelLabel: 'Cancel: keep this PC on',
    sound: true,
  };

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const alertTools = (fake: FakeSystem): void => {
    fake.install('notify-send');
    fake.install('canberra-gtk-play');
  };

  it('sends one critical notification with the user\'s own locale', () => {
    const { system, platform } = setup((fake) => {
      alertTools(fake);
      fake.env = { LANG: 'pl_PL.UTF-8', GTK_PATH: '/snap/x' };
    });
    platform.startCountdownAlert({ ...options, sound: false });
    expect(system.calls).toHaveLength(1);
    expect(system.calls[0]?.file).toBe('/usr/bin/notify-send');
    expect(system.calls[0]?.args.slice(0, 10)).toEqual([
      '-u',
      'critical',
      '-a',
      'Claude Auto Shutdown',
      '-i',
      'dialog-warning',
      '-t',
      '30000',
      '--',
      'Shutting down this PC in 0:30',
    ]);
    expect(system.calls[0]?.options.env).toEqual({ LANG: 'pl_PL.UTF-8' });
  });

  it('plays the warning sound at the start and once per second for the last five seconds', () => {
    const { system, platform } = setup(alertTools);
    platform.startCountdownAlert(options);
    const sounds = (): number => system.callsTo('canberra-gtk-play').length;
    expect(sounds()).toBe(1);
    expect(system.callsTo('canberra-gtk-play')[0]?.args).toEqual(['-i', 'dialog-warning']);
    vi.advanceTimersByTime(24_999);
    expect(sounds()).toBe(1);
    vi.advanceTimersByTime(1);
    expect(sounds()).toBe(2);
    vi.advanceTimersByTime(4_000);
    expect(sounds()).toBe(6);
    vi.advanceTimersByTime(60_000);
    expect(sounds()).toBe(6);
  });

  it('times the last five sounds to the same whole-second deadline the notification names', () => {
    const { system, platform } = setup(alertTools);
    platform.startCountdownAlert({ ...options, seconds: 29.7 });
    const notification = system.callsTo('notify-send')[0]?.args ?? [];
    expect(notification[7]).toBe('29000'); // shown until the deadline, not 0.7 s past it
    expect(notification[9]).toBe('Shutting down this PC in 0:29');
    const sounds = (): number => system.callsTo('canberra-gtk-play').length;
    vi.advanceTimersByTime(23_999);
    expect(sounds()).toBe(1);
    vi.advanceTimersByTime(1);
    expect(sounds()).toBe(2); // 5 s before the deadline at 29 s
    vi.advanceTimersByTime(4_000);
    expect(sounds()).toBe(6); // 1 s before it
  });

  it('stop() cancels the sounds that have not played yet, and is idempotent', () => {
    const { system, platform } = setup(alertTools);
    const alert = platform.startCountdownAlert(options);
    alert.stop();
    alert.stop();
    vi.advanceTimersByTime(60_000);
    expect(system.callsTo('canberra-gtk-play')).toHaveLength(1);
  });

  it('dispose() stops running alerts', async () => {
    const { system, platform } = setup(alertTools);
    platform.startCountdownAlert(options);
    await platform.dispose();
    vi.advanceTimersByTime(60_000);
    expect(system.callsTo('canberra-gtk-play')).toHaveLength(1);
  });

  it('has no Cancel button: onCancel never fires', () => {
    const { platform } = setup(alertTools);
    const listener = vi.fn();
    const alert = platform.startCountdownAlert(options);
    alert.onCancel(listener);
    vi.advanceTimersByTime(60_000);
    alert.stop();
    expect(listener).not.toHaveBeenCalled();
  });

  it('is silent when sound is off', () => {
    const { system, platform } = setup(alertTools);
    platform.startCountdownAlert({ ...options, sound: false });
    vi.advanceTimersByTime(60_000);
    expect(system.callsTo('canberra-gtk-play')).toHaveLength(0);
  });

  it('does nothing, and does not throw, when the tools are missing', () => {
    const { system, platform, lines } = setup();
    const alert = platform.startCountdownAlert(options);
    alert.stop();
    expect(system.calls).toHaveLength(0);
    expect(lines.some((line) => line.includes('notify-send was not found'))).toBe(true);
  });

  it('returns an inert alert when showing it fails', () => {
    const { system, platform } = setup(alertTools);
    system.run = () => {
      throw new Error('boom');
    };
    const alert = platform.startCountdownAlert(options);
    expect(() => alert.stop()).not.toThrow();
  });
});

describe('fixture sanity', () => {
  it('builds stat lines with the start time in field 22', () => {
    const fields = statLine({ pid: 1, comm: 'x', start: 987654 }).trim().split(' ');
    expect(fields).toHaveLength(52);
    expect(fields[21]).toBe('987654');
    expect(fields[13]).toBe('250');
    expect(fields[14]).toBe('50');
  });
});
