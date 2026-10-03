// The whole macOS backend against a fake machine. Nothing here touches the real OS: every tool is
// a scripted reply shaped like the documented output.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createMacPlatform } from '../../src/platform/macos';
import type { CountdownAlertOptions, Platform } from '../../src/platform/types';
import { FakeSystem, fakeOptions } from './fakeSystem';
import { IOREG_OUTPUT, PS_OUTPUT } from './macFixtures';

const PS = '/bin/ps';
const IOREG = '/usr/sbin/ioreg';
const PMSET = '/usr/bin/pmset';
const OSASCRIPT = '/usr/bin/osascript';
const CAFFEINATE = '/usr/bin/caffeinate';
const AFPLAY = '/usr/bin/afplay';
const SOUND = '/System/Library/Sounds/Sosumi.aiff';

function setup(configure?: (system: FakeSystem) => void): { system: FakeSystem; platform: Platform; lines: string[] } {
  const system = new FakeSystem();
  configure?.(system);
  const options = fakeOptions();
  return { system, platform: createMacPlatform(options, system), lines: options.lines };
}

/** ps answers with the fixture listing; with -p it returns only the rows that were asked for. */
function withPs(system: FakeSystem, listing = PS_OUTPUT): void {
  system.present.add(PS);
  system.on('ps', (args) => {
    const at = args.indexOf('-p');
    if (at < 0) return { stdout: listing };
    const asked = new Set((args[at + 1] ?? '').split(','));
    const rows = listing.split('\n').filter((line) => asked.has(line.trim().split(/\s+/)[0] ?? ''));
    return { stdout: rows.length > 0 ? `${rows.join('\n')}\n` : '', code: rows.length > 0 ? 0 : 1 };
  });
}

describe('macos snapshot', () => {
  it('runs ps by absolute path with a pinned locale and time zone', async () => {
    const { system, platform } = setup((fake) => {
      fake.env = { HOME: '/Users/u', LANG: 'pl_PL.UTF-8', TZ: 'Europe/Warsaw' };
      withPs(fake);
    });
    await platform.snapshot({ detailPids: [], detailNames: [] });
    const call = system.callsTo('ps')[0];
    expect(call).toMatchObject({ file: '/bin/ps', args: ['-axww', '-o', 'pid=', '-o', 'ppid=', '-o', 'lstart=', '-o', 'time=', '-o', 'comm='] });
    expect(call?.options.env).toEqual({ HOME: '/Users/u', LANG: 'pl_PL.UTF-8', LC_ALL: 'C', TZ: 'UTC' });
    expect(call?.options.timeoutMs).toBe(5000);
  });

  it('lists every process with parent and lower-case file name', async () => {
    const { platform } = setup(withPs);
    const snapshot = await platform.snapshot({ detailPids: [], detailNames: [] });
    expect(snapshot.problem).toBeNull();
    expect(snapshot.processes).toEqual([
      { pid: 1, ppid: 0, name: 'launchd' },
      { pid: 321, ppid: 1, name: 'logd' },
      { pid: 501, ppid: 1, name: 'trustd' },
      { pid: 4242, ppid: 1, name: 'code helper (plugin)' },
      { pid: 7001, ppid: 4242, name: 'claude' },
      { pid: 7002, ppid: 7001, name: 'node' },
      { pid: 7003, ppid: 1, name: '(zsh)' },
      { pid: 7004, ppid: 600, name: 'zsh' },
      { pid: 7005, ppid: 1, name: 'claude' },
    ]);
    expect(snapshot.details).toEqual({});
  });

  it('returns detail for requested PIDs and for name matches, with the start parsed as UTC', async () => {
    const { platform } = setup(withPs);
    const snapshot = await platform.snapshot({ detailPids: [7002], detailNames: ['claude'] });
    expect(snapshot.details[7001]).toEqual({
      state: 'ok',
      path: '/Users/u/.local/bin/claude',
      startRaw: null,
      startEpochMs: Date.UTC(2026, 9, 3, 11, 30, 0),
      cpuSeconds: 12,
      ioBytes: null,
    });
    expect(snapshot.details[7005]).toMatchObject({ state: 'ok', path: '/Applications/Claude.app/Contents/MacOS/Claude' });
    expect(snapshot.details[7002]).toMatchObject({ state: 'ok', path: '/opt/homebrew/bin/node' });
    expect(Object.keys(snapshot.details).map(Number).sort((a, b) => a - b)).toEqual([7001, 7002, 7005]);
  });

  it('matches detail names against the path too', async () => {
    const { platform } = setup(withPs);
    const snapshot = await platform.snapshot({ detailPids: [], detailNames: ['homebrew'] });
    expect(Object.keys(snapshot.details)).toEqual(['7002']);
  });

  it('keeps a process ps could not name alive, without a path', async () => {
    const { platform } = setup(withPs);
    const snapshot = await platform.snapshot({ detailPids: [7003], detailNames: [] });
    expect(snapshot.details[7003]).toMatchObject({ state: 'partial', path: null, startEpochMs: Date.UTC(2026, 9, 3, 11, 32, 0) });
  });

  it('reports a requested PID that is not in a complete list as gone', async () => {
    const { platform } = setup(withPs);
    const snapshot = await platform.snapshot({ detailPids: [9999], detailNames: [] });
    expect(snapshot.details[9999]).toEqual({ state: 'gone', path: null, startRaw: null, startEpochMs: null, cpuSeconds: null, ioBytes: null });
  });

  it.each([
    ['ps is missing', (_fake: FakeSystem) => undefined, /ps was not found/],
    [
      'ps fails',
      (fake: FakeSystem) => {
        fake.present.add(PS);
        fake.on('ps', () => ({ code: 1, stderr: 'ps: illegal option -- x\n' }));
      },
      /illegal option/,
    ],
    [
      'ps times out',
      (fake: FakeSystem) => {
        fake.present.add(PS);
        fake.on('ps', () => ({ timedOut: true, code: null }));
      },
      /did not answer in time/,
    ],
    [
      'the output has a line that is not a row',
      (fake: FakeSystem) => withPs(fake, `${PS_OUTPUT}something unexpected\n`),
      /1 line of the ps output could not be understood/,
    ],
    [
      'the output does not contain this very process',
      (fake: FakeSystem) => withPs(fake, PS_OUTPUT.split('\n').filter((line) => !line.startsWith(' 4242')).join('\n')),
      /does not list this program itself/,
    ],
    ['the output is empty', (fake: FakeSystem) => withPs(fake, ''), /does not list this program itself/],
  ])('answers "unknown" for everything when %s - nothing is called gone', async (_name, configure, problem) => {
    const { platform } = setup(configure);
    const snapshot = await platform.snapshot({ detailPids: [7001, 9999], detailNames: ['claude'] });
    expect(snapshot.processes).toBeNull();
    expect(snapshot.details).toEqual({});
    expect(snapshot.problem).toMatch(problem);
    expect(platform.helperStatus()).toEqual({ tier: 'unavailable', problem: snapshot.problem });
  });

  it('recovers the helper status once ps works again', async () => {
    const { system, platform } = setup();
    await platform.snapshot({ detailPids: [], detailNames: [] });
    expect(platform.helperStatus().tier).toBe('unavailable');
    withPs(system);
    await platform.snapshot({ detailPids: [], detailNames: [] });
    expect(platform.helperStatus().tier).not.toBe('unavailable');
  });

  it('includes the idle time', async () => {
    const { platform } = setup((fake) => {
      withPs(fake);
      fake.present.add(IOREG);
      fake.on('ioreg', () => ({ stdout: IOREG_OUTPUT }));
    });
    expect((await platform.snapshot({ detailPids: [], detailNames: [] })).idleSeconds).toBe(66.615);
  });

  it('never rejects', async () => {
    const { system, platform } = setup(withPs);
    system.run = () => Promise.reject(new Error('boom'));
    const snapshot = await platform.snapshot({ detailPids: [7001], detailNames: [] });
    expect(snapshot).toMatchObject({ processes: null, details: {}, idleSeconds: null });
    expect(snapshot.problem).toMatch(/boom/);
  });
});

describe('macos probe', () => {
  it('asks ps for the PIDs plus its own PID as a canary', async () => {
    const { system, platform } = setup(withPs);
    const details = await platform.probe([7001, 9999]);
    expect(system.calls[0]?.args).toEqual(['-ww', '-o', 'pid=', '-o', 'ppid=', '-o', 'lstart=', '-o', 'time=', '-o', 'comm=', '-p', '4242,7001,9999']);
    expect(details[7001]).toMatchObject({ state: 'ok', path: '/Users/u/.local/bin/claude', cpuSeconds: 12 });
    expect(details[9999]?.state).toBe('gone');
    expect(Object.keys(details)).toEqual(['7001', '9999']);
  });

  it('leaves a PID that macOS cannot have out of the question, so ps does not refuse the whole list', async () => {
    const { system, platform } = setup(withPs);
    const details = await platform.probe([7001, 5_000_000]);
    expect(system.calls[0]?.args.at(-1)).toBe('4242,7001');
    expect(Object.keys(details)).toEqual(['7001']);
  });

  it('calls nothing gone when the canary is missing from the answer', async () => {
    const { platform } = setup((fake) => {
      fake.present.add(PS);
      fake.on('ps', () => ({ stdout: '', code: 1 }));
    });
    expect(await platform.probe([7001, 9999])).toEqual({});
  });

  it('is unknown when ps is missing or fails', async () => {
    expect(await setup().platform.probe([7001])).toEqual({});
    const failing = setup((fake) => {
      fake.present.add(PS);
      fake.on('ps', () => ({ timedOut: true, code: null }));
    });
    expect(await failing.platform.probe([7001])).toEqual({});
  });

  it('runs nothing for no valid PID', async () => {
    const { system, platform } = setup(withPs);
    expect(await platform.probe([])).toEqual({});
    expect(await platform.probe([0, -1, 1.5, Number.NaN])).toEqual({});
    expect(system.calls).toHaveLength(0);
  });

  it('never rejects', async () => {
    const { system, platform } = setup(withPs);
    system.run = () => Promise.reject(new Error('boom'));
    await expect(platform.probe([7001])).resolves.toEqual({});
  });
});

describe('macos idle time', () => {
  it('reads HIDIdleTime through ioreg', async () => {
    const { system, platform } = setup((fake) => {
      fake.present.add(IOREG);
      fake.on('ioreg', () => ({ stdout: IOREG_OUTPUT }));
    });
    expect(await platform.idleSeconds()).toBe(66.615);
    expect(system.calls[0]).toMatchObject({ file: '/usr/sbin/ioreg', args: ['-r', '-c', 'IOHIDSystem', '-k', 'HIDIdleTime', '-d', '1'] });
    expect(platform.helperStatus()).toEqual({ tier: 'full', problem: null });
  });

  it.each([
    ['ioreg is missing', (_fake: FakeSystem) => undefined],
    [
      'ioreg fails',
      (fake: FakeSystem) => {
        fake.present.add(IOREG);
        fake.on('ioreg', () => ({ code: 1 }));
      },
    ],
    [
      'the key is absent',
      (fake: FakeSystem) => {
        fake.present.add(IOREG);
        fake.on('ioreg', () => ({ stdout: '+-o IOHIDSystem\n    {\n      "IOClass" = "IOHIDSystem"\n    }\n' }));
      },
    ],
  ])('is null - never 0 - when %s', async (_name, configure) => {
    const { platform } = setup(configure);
    expect(await platform.idleSeconds()).toBeNull();
    expect(platform.helperStatus().tier).toBe('limited');
  });

  it('never rejects', async () => {
    const { system, platform } = setup((fake) => {
      fake.present.add(IOREG);
    });
    system.run = () => Promise.reject(new Error('boom'));
    await expect(platform.idleSeconds()).resolves.toBeNull();
  });
});

describe('macos capability', () => {
  it('does not offer hibernate', async () => {
    const { system, platform } = setup((fake) => {
      fake.present.add(PMSET);
    });
    expect(await platform.capability('hibernate')).toEqual({ ok: false, detail: 'macOS decides between sleep and hibernate itself; use Sleep.' });
    expect(system.calls).toHaveLength(0);
  });

  it('allows sleep and lock when pmset exists, without running it', async () => {
    const { system, platform } = setup((fake) => {
      fake.present.add(PMSET);
    });
    expect((await platform.capability('sleep')).ok).toBe(true);
    const lock = await platform.capability('lock');
    expect(lock.ok).toBe(true);
    expect(lock.detail).toMatch(/Best effort/);
    expect(system.calls).toHaveLength(0);
  });

  it('refuses sleep and lock without pmset', async () => {
    const { platform } = setup();
    expect((await platform.capability('sleep')).ok).toBe(false);
    expect((await platform.capability('lock')).ok).toBe(false);
  });

  it('checks shutdown with a harmless System Events question, so the consent dialog appears now', async () => {
    const { system, platform } = setup((fake) => {
      fake.present.add(OSASCRIPT);
      fake.on('osascript', () => ({ stdout: 'System Events\n' }));
    });
    expect((await platform.capability('shutdown')).ok).toBe(true);
    expect(system.calls).toHaveLength(1);
    expect(system.calls[0]).toMatchObject({ file: '/usr/bin/osascript', args: ['-e', 'tell application "System Events" to get name'] });
    expect(JSON.stringify(system.calls)).not.toContain('shut down');
  });

  it('refuses shutdown when Automation consent was denied', async () => {
    const { platform } = setup((fake) => {
      fake.present.add(OSASCRIPT);
      fake.on('osascript', () => ({ code: 1, stderr: 'execution error: Not authorized to send Apple events to System Events. (-1743)\n' }));
    });
    const capability = await platform.capability('shutdown');
    expect(capability.ok).toBe(false);
    expect(capability.detail).toMatch(/Automation/);
    expect(capability.detail).toMatch(/-1743/);
  });

  it('refuses shutdown while the consent dialog is still unanswered', async () => {
    const { platform } = setup((fake) => {
      fake.present.add(OSASCRIPT);
      fake.on('osascript', () => ({ timedOut: true, code: null }));
    });
    const capability = await platform.capability('shutdown');
    expect(capability.ok).toBe(false);
    expect(capability.detail).toMatch(/Allow it, then try again/);
  });

  it('refuses shutdown without osascript', async () => {
    expect((await setup().platform.capability('shutdown')).ok).toBe(false);
  });

  it('notify is always possible; an unknown action is unknown', async () => {
    const { platform } = setup();
    expect((await platform.capability('notify')).ok).toBe(true);
    expect((await platform.capability('reboot' as never)).ok).toBeNull();
  });

  it('never rejects', async () => {
    const { system, platform } = setup((fake) => {
      fake.present.add(OSASCRIPT);
    });
    system.run = () => Promise.reject(new Error('boom'));
    expect((await platform.capability('shutdown')).ok).toBeNull();
  });
});

describe('macos execute', () => {
  const powerTools = (fake: FakeSystem): void => {
    fake.present.add(PMSET);
    fake.present.add(OSASCRIPT);
  };

  it('refuses every power action when CLAUDE_AUTOSHUTDOWN_NO_POWER=1, without spawning anything', async () => {
    const { system, platform } = setup((fake) => {
      powerTools(fake);
      fake.env = { CLAUDE_AUTOSHUTDOWN_NO_POWER: '1' };
    });
    for (const action of ['shutdown', 'hibernate', 'sleep', 'lock'] as const) {
      const result = await platform.execute(action, { force: true });
      expect(result).toMatchObject({ ok: false, command: null, exitCode: null });
      expect(result.detail).toMatch(/CLAUDE_AUTOSHUTDOWN_NO_POWER=1/);
    }
    expect(system.calls).toHaveLength(0);
  });

  it.each([
    ['sleep', '/usr/bin/pmset', ['sleepnow'], '/usr/bin/pmset sleepnow'],
    ['lock', '/usr/bin/pmset', ['displaysleepnow'], '/usr/bin/pmset displaysleepnow'],
    [
      'shutdown',
      '/usr/bin/osascript',
      ['-e', 'tell application "System Events" to shut down'],
      `/usr/bin/osascript -e 'tell application "System Events" to shut down'`,
    ],
  ] as const)('%s runs %s %j', async (action, file, args, command) => {
    const { system, platform } = setup(powerTools);
    const result = await platform.execute(action, { force: true });
    expect(result).toMatchObject({ ok: true, command, exitCode: 0 });
    expect(system.calls).toHaveLength(1);
    expect(system.calls[0]).toMatchObject({ file, args });
    expect(system.calls[0]?.options.timeoutMs).toBe(25_000);
  });

  it('reports a lock as NOT confirmed (only the display turns off) and confirms nothing else by itself', async () => {
    const { platform } = setup(powerTools);
    expect(await platform.execute('lock', { force: true })).toMatchObject({ ok: true, confirmed: false });
    expect(await platform.execute('sleep', { force: true })).toMatchObject({ ok: true, confirmed: null });
    expect(await platform.execute('shutdown', { force: true })).toMatchObject({ ok: true, confirmed: null });
  });

  it('refuses hibernate without running anything', async () => {
    const { system, platform } = setup(powerTools);
    const result = await platform.execute('hibernate', { force: true });
    expect(result).toEqual({
      ok: false,
      detail: 'macOS decides between sleep and hibernate itself; use Sleep.',
      command: null,
      exitCode: null,
      confirmed: null,
    });
    expect(system.calls).toHaveLength(0);
  });

  it('reports a non-zero exit as a failed action, with the message of the tool', async () => {
    const { platform } = setup((fake) => {
      powerTools(fake);
      fake.on('osascript', () => ({ code: 1, stderr: '36:45: execution error: System Events got an error: AppleEvent timed out. (-1712)\n' }));
    });
    const result = await platform.execute('shutdown', { force: true });
    expect(result).toMatchObject({ ok: false, exitCode: 1 });
    expect(result.detail).toMatch(/-1712/);
  });

  it('fails when the tool is missing', async () => {
    const { system, platform } = setup();
    const result = await platform.execute('sleep', { force: false });
    expect(result).toMatchObject({ ok: false, command: null });
    expect(result.detail).toMatch(/pmset was not found/);
    expect(system.calls).toHaveLength(0);
  });

  it('fails a shutdown that hangs (nobody answers the consent dialog)', async () => {
    const { platform } = setup((fake) => {
      powerTools(fake);
      fake.on('osascript', () => ({ timedOut: true, code: null, elapsedMs: 25_005 }));
    });
    expect((await platform.execute('shutdown', { force: true })).ok).toBe(false);
  });

  it('counts a sleep as done when the wall clock jumped past the timeout', async () => {
    const { platform } = setup((fake) => {
      powerTools(fake);
      fake.on('pmset', () => ({ timedOut: true, code: null, elapsedMs: 6 * 3600 * 1000 }));
    });
    expect(await platform.execute('sleep', { force: false })).toMatchObject({ ok: true, confirmed: true });
  });

  it('notify is a no-op that succeeds; an unknown action fails', async () => {
    const { system, platform } = setup(powerTools);
    expect((await platform.execute('notify', { force: false })).ok).toBe(true);
    expect((await platform.execute('reboot' as never, { force: false })).ok).toBe(false);
    expect(system.calls).toHaveLength(0);
  });

  it('never rejects', async () => {
    const { system, platform } = setup(powerTools);
    system.run = () => Promise.reject(new Error('boom'));
    expect((await platform.execute('sleep', { force: false })).ok).toBe(false);
  });
});

describe('macos keep awake', () => {
  it('holds caffeinate tied to the extension host PID', async () => {
    const { system, platform } = setup((fake) => {
      fake.present.add(CAFFEINATE);
    });
    expect((await platform.keepAwake(true)).ok).toBe(true);
    expect(system.holds[0]).toMatchObject({ file: '/usr/bin/caffeinate', args: ['-i', '-w', '4242'], stopped: false });
    expect((await platform.keepAwake(false)).ok).toBe(true);
    expect(system.holds[0]?.stopped).toBe(true);
  });

  it('is not possible without caffeinate', async () => {
    const { system, platform } = setup();
    const outcome = await platform.keepAwake(true);
    expect(outcome.ok).toBe(false);
    expect(outcome.detail).toMatch(/caffeinate was not found/);
    expect(system.holds).toHaveLength(0);
  });

  it('is released by dispose', async () => {
    const { system, platform } = setup((fake) => {
      fake.present.add(CAFFEINATE);
    });
    await platform.keepAwake(true);
    await platform.dispose();
    expect(system.holds[0]?.stopped).toBe(true);
  });
});

describe('macos environment', () => {
  it('describes itself as experimental, with start times that cannot be compared with procStart', async () => {
    const { platform } = setup();
    expect(platform).toMatchObject({ id: 'macos', osName: 'macOS', experimental: true, procStartUnitsPerSecond: null });
    expect(platform.environmentProblem()).toBeNull();
    expect(platform.helperStatus()).toEqual({ tier: 'full', problem: null });
    expect(await platform.foreignRoots()).toEqual({ roots: [], problem: null });
  });
});

describe('macos countdown alert', () => {
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
    fake.present.add(OSASCRIPT);
    fake.present.add(AFPLAY);
    fake.present.add(SOUND);
  };

  it('shows one notification', () => {
    const { system, platform } = setup(alertTools);
    platform.startCountdownAlert({ ...options, sound: false });
    expect(system.calls).toHaveLength(1);
    expect(system.calls[0]?.file).toBe('/usr/bin/osascript');
    expect(system.calls[0]?.args[3]).toBe('display notification (item 2 of argv) with title (item 1 of argv)');
    expect(system.calls[0]?.args[6]).toBe('Shutting down this PC in 0:30');
  });

  it('plays the warning sound at the start and once per second for the last five seconds', () => {
    const { system, platform } = setup(alertTools);
    platform.startCountdownAlert(options);
    const sounds = (): number => system.callsTo('afplay').length;
    expect(sounds()).toBe(1);
    expect(system.callsTo('afplay')[0]?.args).toEqual(['/System/Library/Sounds/Sosumi.aiff']);
    vi.advanceTimersByTime(25_000);
    expect(sounds()).toBe(2);
    vi.advanceTimersByTime(4_000);
    expect(sounds()).toBe(6);
  });

  it('times the last five sounds to the same whole-second deadline the notification names', () => {
    const { system, platform } = setup(alertTools);
    platform.startCountdownAlert({ ...options, seconds: 29.7 });
    expect(system.callsTo('osascript')[0]?.args[6]).toBe('Shutting down this PC in 0:29');
    const sounds = (): number => system.callsTo('afplay').length;
    vi.advanceTimersByTime(23_999);
    expect(sounds()).toBe(1);
    vi.advanceTimersByTime(1);
    expect(sounds()).toBe(2);
  });

  it('stop() and dispose() cancel the remaining sounds; onCancel never fires', async () => {
    const first = setup(alertTools);
    const listener = vi.fn();
    const alert = first.platform.startCountdownAlert(options);
    alert.onCancel(listener);
    alert.stop();
    alert.stop();
    vi.advanceTimersByTime(60_000);
    expect(first.system.callsTo('afplay')).toHaveLength(1);
    expect(listener).not.toHaveBeenCalled();

    const second = setup(alertTools);
    second.platform.startCountdownAlert(options);
    await second.platform.dispose();
    vi.advanceTimersByTime(60_000);
    expect(second.system.callsTo('afplay')).toHaveLength(1);
  });

  it('does nothing, and does not throw, when the tools are missing', () => {
    const { system, platform } = setup();
    expect(() => platform.startCountdownAlert(options).stop()).not.toThrow();
    expect(system.calls).toHaveLength(0);
  });
});
