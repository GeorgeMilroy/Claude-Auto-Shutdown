// WindowsPlatform wired to a FAKE helper and a FAKE process runner: nothing real is inspected and
// no power command can run.

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { RunOptions } from '../../src/platform/exec';
import type { AlertProcess } from '../../src/platform/winAlert';
import { createWindowsPlatform, WindowsPlatform, type WindowsPlatformOverrides } from '../../src/platform/windows';
import type { WslFs } from '../../src/platform/winWsl';
import { fakeAlertLaunch, isAlive, makeFakeHelper, REPO_ROOT, runResult, waitFor, waitUntilGone, type FakePlan } from './support';

const onWindows = process.platform === 'win32';
// 2024-01-17T21:20:00Z
const START = '133500000000000000';

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

interface RunCall {
  file: string;
  args: readonly string[];
  options: RunOptions;
}

function setup(plans: FakePlan[], overrides: WindowsPlatformOverrides = {}) {
  const fake = makeFakeHelper(plans);
  const logs: string[] = [];
  const runs: RunCall[] = [];
  const platform = new WindowsPlatform(
    { extensionPath: REPO_ROOT, log: (message) => logs.push(message) },
    {
      helperLaunch: fake.launch,
      helperTimings: { helloTimeoutMs: 4000, requestTimeoutMs: 4000, stopGraceMs: 1500, restartBackoffMs: 60_000 },
      run: async (file, args, options) => {
        runs.push({ file, args, options });
        return runResult();
      },
      delay: async () => undefined,
      ...overrides,
    },
  );
  cleanups.push(async () => {
    await platform.dispose();
    fake.cleanup();
  });
  return { fake, platform, logs, runs };
}

const SNAPSHOT = {
  idleMs: 90_000,
  nameStyle: 'image',
  processes: [
    { pid: 4, ppid: 0, name: 'System' },
    { pid: 500, ppid: 4, name: 'Code.exe' },
    { pid: 800, ppid: 500, name: 'claude.exe', st: 'ok', path: 'C:\\Users\\me\\.local\\bin\\claude.exe', start: START, cpu: '30000000', io: '2048' },
    { pid: 900, ppid: 800, name: 'node.exe', st: 'denied', err: 5 },
    { pid: 7777, name: null, listed: false, st: 'gone', err: 87 },
  ],
};

describe('identity', () => {
  it('describes itself as the Windows backend', () => {
    const { platform } = setup([{}]);
    expect(platform.id).toBe('windows');
    expect(platform.osName).toBe('Windows');
    expect(platform.procStartUnitsPerSecond).toBe(10_000_000);
    expect(platform.experimental).toBe(false);
  });

  it('is created through createWindowsPlatform without starting anything', () => {
    const platform = createWindowsPlatform({ extensionPath: REPO_ROOT, log: () => undefined });
    expect(platform.id).toBe('windows');
    return platform.dispose();
  });
});

describe('snapshot', () => {
  it('maps the helper reply to processes, details and idle time', async () => {
    const { platform } = setup([{ replies: { snapshot: SNAPSHOT } }]);
    const before = Date.now();
    const snapshot = await platform.snapshot({ detailPids: [800, 7777], detailNames: ['claude'] });
    expect(snapshot.problem).toBeNull();
    expect(snapshot.idleSeconds).toBe(90);
    expect(snapshot.takenAtMs).toBeGreaterThanOrEqual(before);
    expect(snapshot.processes).toEqual([
      { pid: 4, ppid: 0, name: 'system' },
      { pid: 500, ppid: 4, name: 'code' },
      { pid: 800, ppid: 500, name: 'claude' },
      { pid: 900, ppid: 800, name: 'node' },
    ]);
    expect(snapshot.details[800]).toEqual({
      state: 'ok',
      path: 'C:\\Users\\me\\.local\\bin\\claude.exe',
      startRaw: START,
      startEpochMs: 1_705_526_400_000,
      cpuSeconds: 3,
      ioBytes: 2048,
    });
    expect(snapshot.details[900]).toMatchObject({ state: 'denied' });
    expect(snapshot.details[7777]).toMatchObject({ state: 'gone' });
    expect(snapshot.details[4]).toBeUndefined();
  });

  it('keeps paths with accents, CJK characters and emoji intact', async () => {
    const exotic = 'C:\\Users\\Zo\u00eb\\\u65e5\u672c \ud83d\ude00\\claude.exe';
    const { platform } = setup([{ replies: { snapshot: { processes: [{ pid: 800, ppid: 4, name: 'Cl\u00e4ude.exe', st: 'ok', path: exotic, start: START, cpu: '1', io: '1' }] } } }]);
    const snapshot = await platform.snapshot({ detailPids: [800], detailNames: [] });
    expect(snapshot.details[800]?.path).toBe(exotic);
    expect(snapshot.processes).toEqual([{ pid: 800, ppid: 4, name: 'cl\u00e4ude' }]);
  });

  it('asks the helper only for validated PIDs and names', async () => {
    const { fake, platform } = setup([{ replies: { snapshot: SNAPSHOT } }]);
    await platform.snapshot({ detailPids: [800, 800, 1.5, -1, 0, Number.NaN, '12' as never], detailNames: ['Claude.EXE', '', 5 as never] });
    expect(fake.requests('snapshot')[0]).toMatchObject({ op: 'snapshot', pids: [800], detailNames: ['claude'] });
  });

  it('says "could not be read" instead of an empty list when the helper cannot run', async () => {
    const { platform } = setup([{ exitBeforeHello: { code: 1, stderr: 'FullyQualifiedErrorId : UnauthorizedAccess' } }]);
    const snapshot = await platform.snapshot({ detailPids: [800], detailNames: ['claude'] });
    expect(snapshot.processes).toBeNull();
    expect(snapshot.details).toEqual({});
    expect(snapshot.idleSeconds).toBeNull();
    expect(snapshot.problem).toMatch(/couldn't be read/);
    expect(platform.helperStatus().tier).toBe('unavailable');
  });

  it('says so when the helper does not answer in time', async () => {
    const { platform } = setup([{ hangOn: 'snapshot' }], { helperTimings: { requestTimeoutMs: 300, stopGraceMs: 500 } });
    const snapshot = await platform.snapshot({ detailPids: [], detailNames: [] });
    expect(snapshot.processes).toBeNull();
    expect(snapshot.problem).toMatch(/did not answer/);
  });

  it('rejects a list it cannot fully understand', async () => {
    const { platform } = setup([{ replies: { snapshot: { idleMs: 5, processes: [{ pid: 4, name: 'System' }, { pid: 'x', name: 'claude.exe' }] } } }]);
    const snapshot = await platform.snapshot({ detailPids: [], detailNames: [] });
    expect(snapshot.processes).toBeNull();
    expect(snapshot.problem).toMatch(/could not be understood/);
  });

  it('reports the limited tier without calling it a snapshot problem', async () => {
    const limited = { idleMs: null, nameStyle: 'noext', processes: [{ pid: 4, name: 'System' }, { pid: 800, ppid: 4, name: 'claude' }] };
    const { platform } = setup([{ native: false, replies: { snapshot: limited } }]);
    const snapshot = await platform.snapshot({ detailPids: [], detailNames: [] });
    expect(snapshot.problem).toBeNull();
    expect(snapshot.idleSeconds).toBeNull();
    expect(snapshot.processes).toEqual([
      { pid: 4, ppid: null, name: 'system' },
      { pid: 800, ppid: 4, name: 'claude' },
    ]);
    expect(platform.helperStatus().tier).toBe('limited');
  });
});

describe('probe and idle', () => {
  it('probes PIDs through the helper', async () => {
    const probe = { processes: [{ pid: 800, st: 'ok', path: 'C:\\x\\claude.exe', start: START, cpu: '0', io: '0' }, { pid: 801, st: 'gone', err: 87 }] };
    const { fake, platform } = setup([{ replies: { probe } }]);
    const details = await platform.probe([800, 801, 801]);
    expect(details[800]).toMatchObject({ state: 'ok', startRaw: START });
    expect(details[801]).toMatchObject({ state: 'gone' });
    expect(fake.requests('probe')[0]).toMatchObject({ pids: [800, 801] });
  });

  it('does not start the helper to probe nothing', async () => {
    const { fake, platform } = setup([{}]);
    expect(await platform.probe([])).toEqual({});
    expect(await platform.probe([0, -5, 2.5])).toEqual({});
    expect(fake.spawns()).toHaveLength(0);
  });

  it('returns no detail (= unknown) when the helper fails', async () => {
    const { platform } = setup([{ replies: { probe: { error: 'boom' } } }]);
    expect(await platform.probe([800])).toEqual({});
  });

  it('reports idle seconds, and null when it cannot tell', async () => {
    expect(await setup([{ replies: { idle: { idleMs: 2500 } } }]).platform.idleSeconds()).toBe(2.5);
    expect(await setup([{ native: false, replies: { idle: { idleMs: null } } }]).platform.idleSeconds()).toBeNull();
    expect(await setup([{ replies: { idle: { error: 'no' } } }]).platform.idleSeconds()).toBeNull();
    expect(await setup([{ exitBeforeHello: { code: 1 } }], { helperTimings: { helloTimeoutMs: 1000 } }).platform.idleSeconds()).toBeNull();
  });
});

describe.skipIf(!onWindows)('capability (needs the real System32 tools to exist)', () => {
  const s3 = { shutdownPrivilege: 'present', hibernateAllowed: true, suspendAllowed: true, s1: false, s2: false, s3: true, modernStandby: false };

  it('asks the helper and allows every action on a normal PC', async () => {
    const { fake, platform } = setup([{ replies: { capability: s3 } }]);
    for (const action of ['shutdown', 'hibernate', 'sleep'] as const) {
      expect(await platform.capability(action), action).toEqual({ ok: true, detail: 'Allowed by Windows.' });
    }
    expect(fake.requests('capability')).toHaveLength(3);
    expect(fake.requests('capability').some((request) => request.allowWhoami === true)).toBe(false);
  });

  it('answers notify and lock without the helper', async () => {
    const { fake, platform } = setup([{}]);
    expect((await platform.capability('notify')).ok).toBe(true);
    expect((await platform.capability('lock')).ok).toBe(true);
    expect(fake.spawns()).toHaveLength(0);
  });

  it('says Sleep is not available on a Modern Standby PC', async () => {
    const { platform } = setup([{ replies: { capability: { ...s3, s3: false, suspendAllowed: false, modernStandby: true } } }]);
    const sleep = await platform.capability('sleep');
    expect(sleep.ok).toBe(false);
    expect(sleep.detail).toMatch(/Use Hibernate/);
  });

  it('cannot tell when the helper is unavailable', async () => {
    const { platform } = setup([{ exitBeforeHello: { code: 1, stderr: 'FullyQualifiedErrorId : UnauthorizedAccess' } }]);
    for (const action of ['shutdown', 'hibernate', 'sleep'] as const) {
      expect((await platform.capability(action)).ok, action).toBeNull();
    }
  });

  it('asks whoami for the shutdown right only in the limited tier, and only once', async () => {
    const registry = { shutdownPrivilege: 'unknown', privilegeSource: 'none', hibernateAllowed: true, suspendAllowed: null };
    const { fake, platform } = setup([{ native: false, replies: { capability: registry, capabilityWithWhoami: { ...registry, shutdownPrivilege: 'present', privilegeSource: 'whoami' } } }]);
    expect((await platform.capability('shutdown')).ok).toBe(true);
    expect((await platform.capability('hibernate')).ok).toBe(true);
    expect((await platform.capability('shutdown')).ok).toBe(true);
    expect(fake.requests('capability').filter((request) => request.allowWhoami === true)).toHaveLength(1);
    const sleep = await platform.capability('sleep');
    expect(sleep.ok).toBe(false);
  });

  it('stays at "cannot tell" in the limited tier when whoami gives no answer', async () => {
    const registry = { shutdownPrivilege: 'unknown', privilegeSource: 'none', hibernateAllowed: true, suspendAllowed: null };
    const { fake, platform } = setup([{ native: false, replies: { capability: registry } }]);
    expect((await platform.capability('shutdown')).ok).toBeNull();
    expect((await platform.capability('shutdown')).ok).toBeNull();
    expect(fake.requests('capability').filter((request) => request.allowWhoami === true)).toHaveLength(1);
  });
});

describe('execute', () => {
  it('refuses every power action under vitest (CLAUDE_AUTOSHUTDOWN_NO_POWER=1) and runs nothing', async () => {
    expect(process.env.CLAUDE_AUTOSHUTDOWN_NO_POWER).toBe('1');
    const { platform, runs, fake } = setup([{}]);
    for (const action of ['shutdown', 'hibernate', 'sleep', 'lock'] as const) {
      const result = await platform.execute(action, { force: true });
      expect(result, action).toMatchObject({ ok: false, command: null, exitCode: null });
    }
    expect(runs).toHaveLength(0);
    expect(fake.spawns()).toHaveLength(0);
  });

  it('is wired to the real kill switch, the injected runner and a process list that is never cached', async () => {
    const { fake, platform, runs } = setup([{ replies: { snapshot: SNAPSHOT } }]);
    const deps = platform.powerDeps();
    expect(deps.env).toBe(process.env);
    expect(deps.systemRoot).toBe(process.env.SystemRoot || process.env.windir || null);

    // A lock is confirmed by a process that appears after the command, so every poll asks again.
    await platform.snapshot({ detailPids: [], detailNames: [] });
    expect(await deps.processNames()).toEqual(['system', 'code', 'claude', 'node']);
    expect(await deps.processNames()).toEqual(['system', 'code', 'claude', 'node']);
    expect(fake.requests('snapshot')).toHaveLength(3);

    await deps.run('C:\\nothing.exe', [], { timeoutMs: 1 });
    expect(runs).toEqual([{ file: 'C:\\nothing.exe', args: [], options: { timeoutMs: 1 } }]);
  });

  it('reports an unreadable process list to the lock confirmation as null', async () => {
    const { platform } = setup([{ replies: { snapshot: { error: 'boom' } } }]);
    expect(await platform.powerDeps().processNames()).toBeNull();
  });

  it('lets notify through as a no-op', async () => {
    const { platform, runs } = setup([{}]);
    expect(await platform.execute('notify', { force: true })).toMatchObject({ ok: true, command: null });
    expect(runs).toHaveLength(0);
  });
});

describe('keepAwake', () => {
  it('holds and releases the request through the helper', async () => {
    const { fake, platform } = setup([{}]);
    expect(await platform.keepAwake(true)).toMatchObject({ ok: true });
    expect(await platform.keepAwake(true)).toMatchObject({ ok: true });
    expect(await platform.keepAwake(false)).toMatchObject({ ok: true });
    expect(fake.requests('keepAwake').map((request) => request.on)).toEqual([true, false]);
  });

  it('does not start the helper just to release nothing', async () => {
    const { fake, platform } = setup([{}]);
    expect(await platform.keepAwake(false)).toMatchObject({ ok: true });
    expect(fake.spawns()).toHaveLength(0);
  });

  it('is unavailable in the limited tier', async () => {
    const { platform } = setup([{ native: false }]);
    const result = await platform.keepAwake(true);
    expect(result.ok).toBe(false);
    expect(result.detail).toMatch(/isn't available/);
  });

  it('reports a failure of the helper', async () => {
    const { platform } = setup([{ replies: { keepAwake: { error: 'PowerSetRequest failed, error 5' } } }]);
    const result = await platform.keepAwake(true);
    expect(result.ok).toBe(false);
    expect(result.detail).toContain('PowerSetRequest failed, error 5');
  });

  it('asks again after the helper that held the request was replaced', async () => {
    const { fake, platform } = setup([{ replies: { snapshot: SNAPSHOT } }]);
    expect((await platform.keepAwake(true)).ok).toBe(true);
    process.kill(fake.spawns()[0]?.pid as number);
    expect(await waitUntilGone(fake.spawns()[0]?.pid as number)).toBe(true);

    await platform.snapshot({ detailPids: [], detailNames: [] });
    expect(await waitFor(() => fake.requests('keepAwake').length === 2)).toBe(true);
    expect(fake.requests('keepAwake').map((request) => request.on)).toEqual([true, true]);
    expect(fake.spawns()).toHaveLength(2);
  });

  it('does not ask again once it was released', async () => {
    const { fake, platform } = setup([{ replies: { snapshot: SNAPSHOT } }]);
    await platform.keepAwake(true);
    await platform.keepAwake(false);
    process.kill(fake.spawns()[0]?.pid as number);
    expect(await waitUntilGone(fake.spawns()[0]?.pid as number)).toBe(true);
    await platform.snapshot({ detailPids: [], detailNames: [] });
    await platform.keepAwake(false);
    expect(fake.requests('keepAwake')).toHaveLength(2);
  });

  it('keeps "on, off" in order even when both are requested at once', async () => {
    const { fake, platform } = setup([{}]);
    const [on, off] = await Promise.all([platform.keepAwake(true), platform.keepAwake(false)]);
    expect(on.ok).toBe(true);
    expect(off.ok).toBe(true);
    const sent = fake.requests('keepAwake').map((request) => request.on);
    expect(sent[sent.length - 1] ?? false).toBe(false);
  });
});

describe('countdown alert', () => {
  const options = { seconds: 20, kind: 'preview', title: 'Shutting down this PC in', body: 'All Claude sessions finished.', cancelLabel: 'Cancel: keep this PC on', sound: false } as const;

  it('fires onCancel exactly once when the window reports CANCEL', async () => {
    const { platform } = setup([{}], { alertLaunch: () => fakeAlertLaunch('cancel') });
    let cancels = 0;
    const alert = platform.startCountdownAlert(options);
    alert.onCancel(() => cancels++);
    expect(await waitFor(() => cancels > 0)).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(cancels).toBe(1);
    alert.stop();
  });

  it('survives a cancel handler that throws', async () => {
    const { platform, logs } = setup([{}], { alertLaunch: () => fakeAlertLaunch('cancel') });
    let second = 0;
    const alert = platform.startCountdownAlert(options);
    alert.onCancel(() => {
      throw new Error('handler broke');
    });
    alert.onCancel(() => second++);
    expect(await waitFor(() => second === 1)).toBe(true);
    expect(logs.join('\n')).toContain('handler broke');
  });

  it('stop() kills the window and is idempotent; no cancel is reported for it', async () => {
    const { platform } = setup([{}], { alertLaunch: () => fakeAlertLaunch('shown') });
    let cancels = 0;
    const alert = platform.startCountdownAlert(options) as AlertProcess;
    alert.onCancel(() => cancels++);
    expect(await waitFor(() => alert.isShown)).toBe(true);
    const pid = alert.pid as number;
    expect(isAlive(pid)).toBe(true);
    alert.stop();
    alert.stop();
    await alert.exited;
    expect(await waitUntilGone(pid)).toBe(true);
    expect(cancels).toBe(0);
  });

  it('passes the texts through the environment and only numbers and fixed words as arguments', async () => {
    const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cas-')), 'alert.json');
    cleanups.push(() => fs.rmSync(path.dirname(out), { recursive: true, force: true }));
    const { platform } = setup([{}], {
      alertLaunch: () => ({ ...fakeAlertLaunch('env', out), env: { CAS_ALERT_TITLE: '-Title "quoted" \u65e5\u672c', CAS_ALERT_BODY: 'body', CAS_ALERT_CANCEL: 'Cancel', CAS_ALERT_BADGE: '' } }),
    });
    const alert = platform.startCountdownAlert(options);
    expect(await waitFor(() => fs.existsSync(out))).toBe(true);
    await waitFor(() => fs.readFileSync(out, 'utf8').endsWith('}'));
    const seen = JSON.parse(fs.readFileSync(out, 'utf8')) as { texts: Record<string, string> };
    expect(seen.texts.CAS_ALERT_TITLE).toBe('-Title "quoted" \u65e5\u672c');
    expect(seen.texts.CAS_ALERT_CANCEL).toBe('Cancel');
    alert.stop();
  });

  it('logs when the window cannot be shown and reports no cancel', async () => {
    const { platform, logs } = setup([{}], { alertLaunch: () => fakeAlertLaunch('fail') });
    let cancels = 0;
    const alert = platform.startCountdownAlert(options);
    alert.onCancel(() => cancels++);
    expect(await waitFor(() => logs.some((line) => line.includes('could not be shown')))).toBe(true);
    expect(logs.join('\n')).toContain('The window could not be created.');
    expect(cancels).toBe(0);
    alert.stop();
  });

  it('fixes the deadline at the moment it is asked for the alert', () => {
    const asked: number[] = [];
    const { platform } = setup([{}], {
      alertLaunch: (_options, nowMs) => {
        asked.push(nowMs);
        return null;
      },
    });
    const before = Date.now();
    platform.startCountdownAlert(options).stop();
    const after = Date.now();
    expect(asked).toHaveLength(1);
    expect(asked[0]).toBeGreaterThanOrEqual(before);
    expect(asked[0]).toBeLessThanOrEqual(after);
  });

  it('returns an inert alert for unusable options', () => {
    const { platform, logs } = setup([{}], { alertLaunch: () => null });
    const alert = platform.startCountdownAlert(options);
    alert.onCancel(() => undefined);
    alert.stop();
    expect(logs.join('\n')).toMatch(/could not be started/);
  });

  it('closes open alerts on dispose and starts none afterwards', async () => {
    const { platform } = setup([{}], { alertLaunch: () => fakeAlertLaunch('shown') });
    const alert = platform.startCountdownAlert(options) as AlertProcess;
    expect(await waitFor(() => alert.isShown)).toBe(true);
    const pid = alert.pid as number;
    await platform.dispose();
    expect(await waitUntilGone(pid)).toBe(true);
    const after = platform.startCountdownAlert(options) as { pid?: number | null };
    expect(after.pid ?? null).toBeNull();
  });
});

describe.skipIf(!onWindows)('foreignRoots (needs System32\\wsl.exe to exist)', () => {
  const wslFs: WslFs = {
    readdir: async (dir) => {
      if (dir === '\\\\wsl.localhost\\Ubuntu\\home') return ['me'];
      throw Object.assign(new Error(`ENOENT: ${dir}`), { code: 'ENOENT' });
    },
    isDirectory: async (file) => {
      if (file === '\\\\wsl.localhost\\Ubuntu\\home\\me\\.claude') return true;
      throw Object.assign(new Error(`ENOENT: ${file}`), { code: 'ENOENT' });
    },
  };
  const withWsl = { idleMs: 1, nameStyle: 'image', processes: [{ pid: 4, ppid: 0, name: 'System' }, { pid: 60, ppid: 4, name: 'vmmemWSL' }] };

  it('never runs wsl.exe when no WSL process is in the snapshot', async () => {
    const { platform, runs } = setup([{ replies: { snapshot: SNAPSHOT } }], { wslFs });
    await platform.snapshot({ detailPids: [], detailNames: [] });
    expect(await platform.foreignRoots()).toEqual({ roots: [], problem: null });
    expect(runs).toHaveLength(0);
  });

  it('lists the Claude folders of running distros when WSL is in the snapshot', async () => {
    const runs: RunCall[] = [];
    const { platform } = setup([{ replies: { snapshot: withWsl } }], {
      wslFs,
      run: async (file, args, options) => {
        runs.push({ file, args, options });
        return runResult({ stdout: 'Ubuntu\r\ndocker-desktop\r\n' });
      },
    });
    await platform.snapshot({ detailPids: [], detailNames: [] });
    expect(await platform.foreignRoots()).toEqual({ roots: [{ path: '\\\\wsl.localhost\\Ubuntu\\home\\me\\.claude', label: 'WSL: Ubuntu' }], problem: null });
    expect(runs).toHaveLength(1);
    expect(runs[0]?.file.toLowerCase()).toMatch(/\\system32\\wsl\.exe$/);
    expect(runs[0]?.args).toEqual(['-l', '--running', '-q']);
    expect(runs[0]?.options).toMatchObject({ timeoutMs: 5000, encoding: 'utf16le' });
  });

  it('takes its own look at the process names when no snapshot was taken yet', async () => {
    const { fake, platform } = setup([{ replies: { snapshot: withWsl } }], { wslFs, run: async () => runResult({ stdout: 'Ubuntu\r\n' }) });
    const found = await platform.foreignRoots();
    expect(found.roots).toHaveLength(1);
    expect(fake.requests('snapshot')[0]).toMatchObject({ pids: [], detailNames: [] });
  });

  it('reports a problem when it cannot tell whether WSL is running', async () => {
    const { platform } = setup([{ exitBeforeHello: { code: 1, stderr: 'FullyQualifiedErrorId : UnauthorizedAccess' } }], { wslFs });
    const found = await platform.foreignRoots();
    expect(found.roots).toEqual([]);
    expect(found.problem).toMatch(/Couldn't check whether WSL is running/);
  });
});

describe('environment and dispose', () => {
  it.skipIf(!onWindows)('has no environment problem on a normal Windows PC', () => {
    const platform = new WindowsPlatform({ extensionPath: REPO_ROOT, log: () => undefined });
    cleanups.push(() => platform.dispose());
    expect(platform.environmentProblem()).toBeNull();
    expect(platform.helperStatus()).toEqual({ tier: 'full', problem: null });
  });

  it('refuses to work without a Windows folder', async () => {
    const platform = new WindowsPlatform({ extensionPath: REPO_ROOT, log: () => undefined }, { systemRoot: null });
    cleanups.push(() => platform.dispose());
    expect(platform.environmentProblem()).toMatch(/SystemRoot is not set/);
    expect(platform.helperStatus().tier).toBe('unavailable');
    const snapshot = await platform.snapshot({ detailPids: [], detailNames: [] });
    expect(snapshot.processes).toBeNull();
    expect(snapshot.problem).toMatch(/SystemRoot is not set/);
    expect((await platform.capability('shutdown')).ok).not.toBe(true);
  });

  it.skipIf(!onWindows)('reports a missing helper script as an environment problem', () => {
    const platform = new WindowsPlatform({ extensionPath: path.join(REPO_ROOT, 'no-such-folder'), log: () => undefined });
    cleanups.push(() => platform.dispose());
    expect(platform.environmentProblem()).toMatch(/win-helper\.ps1/);
    expect(platform.helperStatus().tier).toBe('unavailable');
  });

  it('stops the helper on dispose and answers "unknown" afterwards', async () => {
    const { fake, platform } = setup([{ replies: { snapshot: SNAPSHOT } }]);
    await platform.snapshot({ detailPids: [], detailNames: [] });
    const pid = platform.helperPid() as number;
    expect(pid).toBe(fake.spawns()[0]?.pid);
    await platform.dispose();
    expect(isAlive(pid)).toBe(false);
    expect(platform.helperPid()).toBeNull();

    const snapshot = await platform.snapshot({ detailPids: [], detailNames: [] });
    expect(snapshot.processes).toBeNull();
    expect(await platform.idleSeconds()).toBeNull();
    expect(await platform.probe([800])).toEqual({});
    expect((await platform.keepAwake(true)).ok).toBe(false);
    expect(fake.spawns()).toHaveLength(1);
    await platform.dispose();
  });
});
