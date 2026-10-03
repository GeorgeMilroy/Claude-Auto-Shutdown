// Live smoke tests: the REAL helper script on this PC (Windows only).
//
// Safety rules of this file:
// - the only process ever opened is this test process itself (process.pid); nothing is looked up
//   by name, so no other program - Claude in particular - is touched;
// - no power action is run (Platform.execute is not called; vitest also sets the kill switch);
// - the visible countdown window is opt-in: set CAS_LIVE_ALERT=1 to show it once for under 3 s
//   (and CAS_LIVE_ALERT_SHOT=<file.png> to save a picture of it).

import { spawn, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AlertProcess } from '../../src/platform/winAlert';
import { buildHelperLaunch, WinHelper } from '../../src/platform/winHelper';
import { powershellPath } from '../../src/platform/winPower';
import { WindowsPlatform } from '../../src/platform/windows';
import { isAlive, REPO_ROOT, waitFor, waitUntilGone } from './support';

const onWindows = process.platform === 'win32';
const systemRoot = process.env.SystemRoot ?? 'C:\\Windows';
const ownName = path
  .basename(process.execPath)
  .toLowerCase()
  .replace(/\.exe$/, '');
const startedAboutMs = () => Date.now() - process.uptime() * 1000;

function newPlatform(helperArgs: string[] = []): { platform: WindowsPlatform; logs: string[] } {
  const logs: string[] = [];
  return { platform: new WindowsPlatform({ extensionPath: REPO_ROOT, log: (message) => logs.push(message) }, { helperArgs }), logs };
}

/** A PID that no running process has (Windows PIDs are multiples of 4). */
function unusedPid(used: Set<number>): number {
  let candidate = 3_999_996;
  while (used.has(candidate)) candidate += 4;
  return candidate;
}

/** Collects the stdout lines of a raw helper process. */
function lineReader(child: ChildProcess) {
  const lines: Buffer[] = [];
  let buffered = Buffer.alloc(0);
  child.stdout?.on('data', (chunk: Buffer) => {
    buffered = Buffer.concat([buffered, chunk]);
    let newline: number;
    while ((newline = buffered.indexOf(0x0a)) >= 0) {
      lines.push(buffered.subarray(0, newline));
      buffered = buffered.subarray(newline + 1);
    }
  });
  return lines;
}

describe.skipIf(!onWindows)('live: the real helper, native tier', () => {
  let platform: WindowsPlatform;
  let logs: string[];

  beforeAll(() => {
    ({ platform, logs } = newPlatform());
  });
  afterAll(async () => {
    await platform.dispose();
  });

  it('has nothing to complain about before and after the first use', async () => {
    expect(platform.environmentProblem()).toBeNull();
    const snapshot = await platform.snapshot({ detailPids: [process.pid], detailNames: [] });
    expect(snapshot.problem).toBeNull();
    const status = platform.helperStatus();
    expect(status.tier, `${status.problem} / ${logs.join(' | ')}`).toBe('full');
    expect(status.problem).toBeNull();
  });

  it('lists every process with a parent and details exactly the one PID asked for', async () => {
    const before = Date.now();
    const snapshot = await platform.snapshot({ detailPids: [process.pid], detailNames: [] });
    expect(snapshot.takenAtMs).toBeGreaterThanOrEqual(before);
    const processes = snapshot.processes ?? [];
    expect(processes.length).toBeGreaterThan(20);

    const own = processes.find((row) => row.pid === process.pid);
    expect(own).toEqual({ pid: process.pid, ppid: process.ppid, name: ownName });
    for (const row of processes) {
      expect(Number.isInteger(row.pid) && row.pid >= 0).toBe(true);
      expect(row.ppid === null || Number.isInteger(row.ppid)).toBe(true);
      expect(row.name).toBe(row.name.toLowerCase());
      expect(row.name.endsWith('.exe')).toBe(false);
    }
    expect(processes.filter((row) => row.ppid !== null).length).toBe(processes.length);

    // Lean snapshot: no other process was opened.
    expect(Object.keys(snapshot.details)).toEqual([String(process.pid)]);
    const detail = snapshot.details[process.pid];
    expect(detail?.state).toBe('ok');
    expect(detail?.path?.toLowerCase()).toBe(process.execPath.toLowerCase());
    expect(detail?.startRaw).toMatch(/^\d{18}$/);
    expect(Math.abs((detail?.startEpochMs ?? 0) - startedAboutMs())).toBeLessThan(5000);
    expect(detail?.cpuSeconds).toBeGreaterThan(0);
    expect(detail?.ioBytes).toBeGreaterThan(0);
    expect(typeof snapshot.idleSeconds).toBe('number');
    expect(snapshot.idleSeconds).toBeGreaterThanOrEqual(0);
  });

  it('probes this process: alive, with the same start time as the snapshot and growing counters', async () => {
    const snapshot = await platform.snapshot({ detailPids: [process.pid], detailNames: [] });
    const probed = (await platform.probe([process.pid]))[process.pid];
    const listed = snapshot.details[process.pid];
    expect(probed?.state).toBe('ok');
    expect(probed?.startRaw).toBe(listed?.startRaw);
    expect(probed?.startEpochMs).toBe(listed?.startEpochMs);
    expect(Math.abs((probed?.startEpochMs ?? 0) - startedAboutMs())).toBeLessThan(5000);
    expect(probed?.cpuSeconds ?? -1).toBeGreaterThanOrEqual(listed?.cpuSeconds ?? 0);
    expect(probed?.ioBytes ?? -1).toBeGreaterThanOrEqual(listed?.ioBytes ?? 0);
    // The registry stores procStart in the same unit: equal within one second of FILETIME units.
    const difference = BigInt(probed?.startRaw ?? '0') - BigInt(listed?.startRaw ?? '1');
    expect(difference <= BigInt(platform.procStartUnitsPerSecond) && difference >= -BigInt(platform.procStartUnitsPerSecond)).toBe(true);
  });

  it('reports a PID that does not exist as gone, in a probe and in a snapshot', async () => {
    const snapshot = await platform.snapshot({ detailPids: [], detailNames: [] });
    const missing = unusedPid(new Set((snapshot.processes ?? []).map((row) => row.pid)));
    expect((await platform.probe([missing]))[missing]).toEqual({ state: 'gone', path: null, startRaw: null, startEpochMs: null, cpuSeconds: null, ioBytes: null });

    const again = await platform.snapshot({ detailPids: [missing], detailNames: [] });
    expect(again.details[missing]?.state).toBe('gone');
    expect(again.processes?.some((row) => row.pid === missing)).toBe(false);
  });

  it('reports idle time as a number', async () => {
    const idle = await platform.idleSeconds();
    expect(typeof idle).toBe('number');
    expect(idle).toBeGreaterThanOrEqual(0);
    expect(idle).toBeLessThan(365 * 24 * 3600);
  });

  it('answers the capability of every action in the documented shape', async () => {
    for (const action of ['shutdown', 'hibernate', 'sleep', 'lock', 'notify'] as const) {
      const capability = await platform.capability(action);
      expect([true, false, null], action).toContain(capability.ok);
      expect(capability.detail.length, action).toBeGreaterThan(5);
    }
    expect((await platform.capability('notify')).ok).toBe(true);
    // The token of this process can always be read in the native tier.
    expect(typeof (await platform.capability('shutdown')).ok).toBe('boolean');
  });

  it('holds and releases the keep-awake request', async () => {
    expect(await platform.keepAwake(true)).toEqual({ ok: true, detail: 'Windows is being kept awake.' });
    expect(await platform.keepAwake(true)).toMatchObject({ ok: true });
    expect(await platform.keepAwake(false)).toEqual({ ok: true, detail: 'Windows may go to sleep by itself again.' });
    expect(await platform.keepAwake(false)).toMatchObject({ ok: true });
  });

  it('runs one helper, a powershell child of this process, and leaves no orphan after dispose', async () => {
    const snapshot = await platform.snapshot({ detailPids: [], detailNames: [] });
    const helperPid = platform.helperPid() as number;
    expect(Number.isInteger(helperPid)).toBe(true);
    expect(snapshot.processes?.find((row) => row.pid === helperPid)).toEqual({ pid: helperPid, ppid: process.pid, name: 'powershell' });
    expect(snapshot.processes?.filter((row) => row.name === 'powershell' && row.ppid === process.pid)).toHaveLength(1);

    await platform.keepAwake(true);
    await platform.dispose();
    expect(await waitUntilGone(helperPid, 3000)).toBe(true);
    expect(platform.helperPid()).toBeNull();
    expect((await platform.snapshot({ detailPids: [], detailNames: [] })).processes).toBeNull();
  });
});

describe.skipIf(!onWindows)('live: the real helper process, raw', () => {
  const launch = buildHelperLaunch(systemRoot, REPO_ROOT, process.pid);
  const children: ChildProcess[] = [];
  afterAll(() => {
    for (const child of children) child.kill();
  });

  function start(args: string[]): { child: ChildProcess; lines: Buffer[]; exit: Promise<number | null> } {
    const child = spawn(launch.file, args, { cwd: launch.cwd, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    children.push(child);
    return { child, lines: lineReader(child), exit: new Promise((resolve) => child.on('exit', (code) => resolve(code))) };
  }

  it('greets with one ASCII-only JSON line and exits with code 0 when stdin closes', async () => {
    const { child, lines, exit } = start(launch.args);
    expect(await waitFor(() => lines.length >= 1, 15_000)).toBe(true);
    const hello = JSON.parse(lines[0]!.toString('utf8')) as Record<string, unknown>;
    expect(hello).toMatchObject({ id: 0, ok: true, hello: true, protocol: 2, pid: child.pid });
    expect(typeof hello.native).toBe('boolean');

    child.stdin?.write(`${JSON.stringify({ id: 1, op: 'snapshot', pids: [process.pid], detailNames: [] })}\n`);
    expect(await waitFor(() => lines.length >= 2, 8000)).toBe(true);
    for (const line of lines) {
      const text = line.toString('latin1').replace(/\r$/, '');
      expect(/^[\x20-\x7e]+$/.test(text)).toBe(true);
    }
    const reply = JSON.parse(lines[1]!.toString('utf8')) as { ok: boolean; opened: number };
    expect(reply.ok).toBe(true);
    expect(reply.opened).toBe(1);

    const closedAt = Date.now();
    child.stdin?.end();
    expect(await Promise.race([exit, new Promise((resolve) => setTimeout(() => resolve('still running'), 3000))])).toBe(0);
    expect(Date.now() - closedAt).toBeLessThan(3000);
    expect(isAlive(child.pid as number)).toBe(false);
  });

  it('exits by itself when nobody has talked to it for -IdleExitSeconds, even with stdin still open', async () => {
    const args = launch.args.map((arg, index) => (launch.args[index - 1] === '-IdleExitSeconds' ? '2' : arg));
    const { child, lines, exit } = start(args);
    expect(await waitFor(() => lines.length >= 1, 15_000)).toBe(true);
    const hello = JSON.parse(lines[0]!.toString('utf8')) as { native: boolean };
    if (hello.native) {
      // Exit code 4 = "idle for too long" (the watchdog needs the native tier).
      expect(await Promise.race([exit, new Promise((resolve) => setTimeout(() => resolve('still running'), 8000))])).toBe(4);
      expect(isAlive(child.pid as number)).toBe(false);
    }
  });

  it('is classified as blocked by policy when PowerShell refuses to load the script', async () => {
    // AllSigned stands in for a locked-down PC: the unsigned helper script is refused.
    const refused = { ...launch, args: launch.args.map((arg) => (arg === 'Bypass' ? 'AllSigned' : arg)) };
    const logs: string[] = [];
    // PowerShell stays silent about the refusal while its stdin is open; the client closes it
    // after the greeting timeout (15 s in production, shortened here) to hear the reason.
    const helper = new WinHelper({ launch: refused, log: (message) => logs.push(message), helloTimeoutMs: 3000 });
    try {
      const reply = await helper.call('idle');
      expect(reply.ok).toBe(false);
      const status = helper.status();
      expect(status.tier, logs.join(' | ')).toBe('unavailable');
      expect(status.problem, logs.join(' | ')).toMatch(/blocked by a script policy/);
      expect(helper.running).toBe(false);
    } finally {
      await helper.dispose();
    }
  });

  it('exits by itself when the process it was started for is gone, even with stdin still open', async () => {
    const standIn = spawn(process.execPath, ['-e', 'setInterval(() => undefined, 1000)'], { windowsHide: true, stdio: 'ignore' });
    children.push(standIn);
    const args = launch.args.map((arg, index) => (launch.args[index - 1] === '-ParentPid' ? String(standIn.pid) : arg));
    const { child, lines, exit } = start(args);
    expect(await waitFor(() => lines.length >= 1, 15_000)).toBe(true);
    const hello = JSON.parse(lines[0]!.toString('utf8')) as { native: boolean };

    standIn.kill();
    if (hello.native) {
      // Exit code 3 = "my parent is gone" (the watchdog needs the native tier).
      expect(await Promise.race([exit, new Promise((resolve) => setTimeout(() => resolve('still running'), 6000))])).toBe(3);
      expect(isAlive(child.pid as number)).toBe(false);
    }
  });
});

describe.skipIf(!onWindows)('live: the real helper, limited tier (-NoNative)', () => {
  let platform: WindowsPlatform;
  beforeAll(() => {
    ({ platform } = newPlatform(['-NoNative']));
  });
  afterAll(async () => {
    await platform.dispose();
  });

  it('still lists processes with parents and details this process, with the same start time as the native tier', async () => {
    const snapshot = await platform.snapshot({ detailPids: [process.pid], detailNames: [] });
    expect(snapshot.problem).toBeNull();
    expect(platform.helperStatus().tier).toBe('limited');
    expect(platform.helperStatus().problem).toMatch(/idle time, keep-awake and Sleep are unavailable/);
    expect(snapshot.idleSeconds).toBeNull();

    const processes = snapshot.processes ?? [];
    expect(processes.length).toBeGreaterThan(20);
    expect(processes.find((row) => row.pid === process.pid)).toEqual({ pid: process.pid, ppid: process.ppid, name: ownName });
    expect(Object.keys(snapshot.details)).toEqual([String(process.pid)]);

    const detail = snapshot.details[process.pid];
    expect(detail?.state).toBe('ok');
    expect(detail?.path?.toLowerCase()).toBe(process.execPath.toLowerCase());
    expect(detail?.ioBytes).toBeNull();
    expect(Math.abs((detail?.startEpochMs ?? 0) - startedAboutMs())).toBeLessThan(5000);

    const native = newPlatform();
    try {
      const reference = (await native.platform.probe([process.pid]))[process.pid];
      expect(detail?.startRaw).toBe(reference?.startRaw);
    } finally {
      await native.platform.dispose();
    }
  });

  it('probes, but has no idle time and no keep-awake', async () => {
    const probed = await platform.probe([process.pid, 3_999_996]);
    expect(probed[process.pid]?.state).toBe('ok');
    expect(probed[3_999_996]?.state).toBe('gone');
    expect(await platform.idleSeconds()).toBeNull();
    const keepAwake = await platform.keepAwake(true);
    expect(keepAwake.ok).toBe(false);
    expect(keepAwake.detail).toMatch(/isn't available/);
  });

  it('offers no Sleep, and still answers for the other actions', async () => {
    const sleep = await platform.capability('sleep');
    expect(sleep.ok).toBe(false);
    expect(sleep.detail).toMatch(/Use Hibernate/);
    expect([true, false, null]).toContain((await platform.capability('hibernate')).ok);
    expect((await platform.capability('lock')).ok).toBe(true);
  });
});

describe.skipIf(!onWindows)('live: the real helper under a simulated locked-down PowerShell (-SimulateClm)', () => {
  it('works through pipeline output with CRLF line ends', async () => {
    const { platform } = newPlatform(['-SimulateClm']);
    try {
      const snapshot = await platform.snapshot({ detailPids: [process.pid], detailNames: [] });
      expect(snapshot.problem).toBeNull();
      const status = platform.helperStatus();
      expect(status.tier).toBe('limited');
      expect(status.problem).toMatch(/not supported in this language mode/);
      expect(snapshot.processes?.find((row) => row.pid === process.pid)?.name).toBe(ownName);
      expect(snapshot.details[process.pid]?.state).toBe('ok');
      expect((await platform.probe([process.pid]))[process.pid]?.state).toBe('ok');
      expect(await platform.idleSeconds()).toBeNull();
      const helperPid = platform.helperPid() as number;
      await platform.dispose();
      expect(await waitUntilGone(helperPid, 3000)).toBe(true);
    } finally {
      await platform.dispose();
    }
  });
});

// Opt-in, because it puts a window on the screen of whoever runs the tests.
describe.skipIf(!onWindows || process.env.CAS_LIVE_ALERT !== '1')('live: the real countdown window (CAS_LIVE_ALERT=1)', () => {
  it('appears as a preview, reports no cancel, and is gone as soon as it is stopped', async () => {
    const shot = process.env.CAS_LIVE_ALERT_SHOT;
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'cas-'));
    const trigger = path.join(scratch, 'take-picture');
    const { platform, logs } = newPlatform();
    let camera: ChildProcess | null = null;
    let cameraOutput = '';
    let alert: AlertProcess | null = null;
    try {
      if (shot) {
        const powershell = powershellPath(systemRoot);
        camera = spawn(
          powershell,
          ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(__dirname, 'capture-region.ps1'), '-OutFile', shot, '-TriggerFile', trigger],
          { cwd: path.dirname(powershell), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] },
        );
        camera.stdout?.on('data', (chunk: Buffer) => (cameraOutput += chunk.toString('utf8')));
        expect(await waitFor(() => cameraOutput.includes('READY'), 15_000)).toBe(true);
      }

      let cancels = 0;
      alert = platform.startCountdownAlert({
        seconds: 20,
        kind: 'preview',
        title: 'Shutting down this PC in',
        body: 'All Claude Code sessions have finished.',
        cancelLabel: 'Cancel: keep this PC on',
        sound: false,
      }) as AlertProcess;
      alert.onCancel(() => cancels++);
      // Whatever happens below, the window never stays up for 3 seconds.
      const lifetime = setTimeout(() => alert?.stop(), 2900);
      try {
        expect(await waitFor(() => alert?.isShown === true, 2500), logs.join(' | ')).toBe(true);
        const pid = alert.pid as number;
        expect(isAlive(pid)).toBe(true);
        if (shot) {
          await new Promise((resolve) => setTimeout(resolve, 350));
          fs.writeFileSync(trigger, '');
          await waitFor(() => cameraOutput.includes('SAVED'), 1200);
        } else {
          await new Promise((resolve) => setTimeout(resolve, 500));
        }
        alert.stop();
        await alert.exited;
        expect(await waitUntilGone(pid, 2000)).toBe(true);
        expect(cancels).toBe(0);
        if (shot) expect(fs.statSync(shot).size).toBeGreaterThan(1000);
      } finally {
        clearTimeout(lifetime);
      }
    } finally {
      alert?.stop();
      camera?.kill();
      await platform.dispose();
      fs.rmSync(scratch, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
    }
  });
});
