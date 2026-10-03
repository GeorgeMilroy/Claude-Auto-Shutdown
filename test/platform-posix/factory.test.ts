import { describe, expect, it, vi } from 'vitest';

// The Windows backend belongs to another module: the factory is tested against a stand-in, so
// this file neither depends on its behaviour nor starts its helper.
const mocks = vi.hoisted(() => ({
  createWindowsPlatform: vi.fn((_options: unknown) => ({ id: 'windows', osName: 'Windows' })),
}));
vi.mock('../../src/platform/windows', () => ({ createWindowsPlatform: mocks.createWindowsPlatform }));

import { createPlatform, createPlatformFor, type PlatformOptions } from '../../src/platform/index';
import { createUnsupportedPlatform, unsupportedProblem } from '../../src/platform/unsupported';

const options: PlatformOptions = { extensionPath: '/opt/extension', log: () => undefined };

describe('createPlatformFor', () => {
  it('win32 -> the Windows backend, given the options', () => {
    mocks.createWindowsPlatform.mockClear();
    const platform = createPlatformFor('win32', options);
    expect(platform.id).toBe('windows');
    expect(mocks.createWindowsPlatform).toHaveBeenCalledTimes(1);
    expect(mocks.createWindowsPlatform).toHaveBeenCalledWith(options);
  });

  it('linux -> the Linux backend', () => {
    const platform = createPlatformFor('linux', options);
    expect(platform).toMatchObject({ id: 'linux', osName: 'Linux', experimental: false, procStartUnitsPerSecond: 100 });
  });

  it('darwin -> the macOS backend, marked experimental', () => {
    const platform = createPlatformFor('darwin', options);
    expect(platform).toMatchObject({ id: 'macos', osName: 'macOS', experimental: true, procStartUnitsPerSecond: null });
  });

  it.each(['freebsd', 'openbsd', 'sunos', 'aix', 'android', 'cygwin', '', 'Linux', 'WIN32'])('%j -> unsupported', (osPlatform) => {
    const platform = createPlatformFor(osPlatform, options);
    expect(platform.id).toBe('unsupported');
    expect(platform.environmentProblem()).toBe(`Claude Auto Shutdown doesn't support this operating system (${osPlatform}).`);
  });

  it('never calls the Windows backend for another OS', () => {
    mocks.createWindowsPlatform.mockClear();
    for (const osPlatform of ['linux', 'darwin', 'freebsd']) createPlatformFor(osPlatform, options);
    expect(mocks.createWindowsPlatform).not.toHaveBeenCalled();
  });
});

describe('createPlatform', () => {
  it('picks the backend for the OS this process runs on', () => {
    const expected: Record<string, string> = { win32: 'windows', linux: 'linux', darwin: 'macos' };
    expect(createPlatform(options).id).toBe(expected[process.platform] ?? 'unsupported');
  });
});

describe('unsupported platform', () => {
  const problem = unsupportedProblem('freebsd');
  const platform = createUnsupportedPlatform('freebsd');

  it('names the operating system in its problem', () => {
    expect(problem).toBe("Claude Auto Shutdown doesn't support this operating system (freebsd).");
    expect(platform).toMatchObject({ id: 'unsupported', osName: 'freebsd', experimental: false, procStartUnitsPerSecond: null });
    expect(platform.environmentProblem()).toBe(problem);
    expect(platform.helperStatus()).toEqual({ tier: 'unavailable', problem });
  });

  it('sees nothing: every answer is unknown', async () => {
    const snapshot = await platform.snapshot({ detailPids: [1], detailNames: ['claude'] });
    expect(snapshot).toMatchObject({ idleSeconds: null, processes: null, details: {}, problem });
    expect(Number.isFinite(snapshot.takenAtMs)).toBe(true);
    expect(await platform.probe([1, 2])).toEqual({});
    expect(await platform.idleSeconds()).toBeNull();
    expect(await platform.foreignRoots()).toEqual({ roots: [], problem: null });
  });

  it('can do nothing: no power action is possible or performed', async () => {
    for (const action of ['shutdown', 'hibernate', 'sleep', 'lock'] as const) {
      expect(await platform.capability(action)).toEqual({ ok: false, detail: problem });
      expect(await platform.execute(action, { force: true })).toEqual({ ok: false, detail: problem, command: null, exitCode: null, confirmed: null });
    }
    expect(await platform.keepAwake(true)).toEqual({ ok: false, detail: problem });
  });

  it('still lets a notification through, which runs nothing and confirms nothing', async () => {
    expect((await platform.capability('notify')).ok).toBe(true);
    expect(await platform.execute('notify', { force: false })).toMatchObject({ ok: true, command: null, confirmed: null });
  });

  it('has an alert that does nothing, and disposes cleanly', async () => {
    const listener = vi.fn();
    const alert = platform.startCountdownAlert({ seconds: 30, kind: 'real', title: 't', body: 'b', cancelLabel: 'c', sound: true });
    alert.onCancel(listener);
    alert.stop();
    expect(listener).not.toHaveBeenCalled();
    await expect(platform.dispose()).resolves.toBeUndefined();
  });
});
