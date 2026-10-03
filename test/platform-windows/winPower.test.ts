// Power actions are tested WITHOUT running anything: the command lines come from pure functions and
// the process runner is a fake that only records what it was asked to start.

import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { RunOptions, RunResult } from '../../src/platform/exec';
import {
  ACTION_TIMEOUT_MS,
  buildPowerCommand,
  executePowerAction,
  formatCommandLine,
  interpretPowerResult,
  SLEEP_SCRIPT,
  type PowerDeps,
  type RealPowerAction,
} from '../../src/platform/winPower';
import { runResult } from './support';

const ROOT = 'C:\\Windows';
const REAL_ACTIONS: RealPowerAction[] = ['shutdown', 'hibernate', 'sleep', 'lock'];

interface Recorded {
  file: string;
  args: readonly string[];
  options: RunOptions;
}

/** Deps whose runner never starts a process. `names` answers the lock confirmation polls in order. */
function fakeDeps(result: RunResult | Error = runResult(), names: (string[] | null)[] = [], env: NodeJS.ProcessEnv = {}) {
  const calls: Recorded[] = [];
  const delays: number[] = [];
  let polls = 0;
  const deps: PowerDeps = {
    env,
    systemRoot: ROOT,
    run: async (file, args, options) => {
      calls.push({ file, args, options });
      if (result instanceof Error) throw result;
      return result;
    },
    processNames: async () => names[Math.min(polls++, names.length - 1)] ?? null,
    delay: async (ms) => {
      delays.push(ms);
    },
  };
  return { deps, calls, delays, polls: () => polls };
}

describe('buildPowerCommand', () => {
  it('shuts down with /f only when force is on', () => {
    expect(buildPowerCommand('shutdown', { force: true }, ROOT)).toEqual({ file: 'C:\\Windows\\System32\\shutdown.exe', args: ['/s', '/t', '0', '/f'] });
    expect(buildPowerCommand('shutdown', { force: false }, ROOT)).toEqual({ file: 'C:\\Windows\\System32\\shutdown.exe', args: ['/s', '/t', '0'] });
  });

  it('adds /f for nothing but a real boolean true', () => {
    for (const force of ['true', 1, {}, null, undefined] as unknown[]) {
      expect(buildPowerCommand('shutdown', { force: force as boolean }, ROOT).args, String(force)).toEqual(['/s', '/t', '0']);
    }
  });

  it('hibernates with shutdown.exe /h and never forces', () => {
    expect(buildPowerCommand('hibernate', { force: true }, ROOT)).toEqual({ file: 'C:\\Windows\\System32\\shutdown.exe', args: ['/h'] });
  });

  it('sleeps through the Windows Forms one-liner in PowerShell', () => {
    const command = buildPowerCommand('sleep', { force: true }, ROOT);
    expect(command.file).toBe('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
    expect(command.args).toEqual(['-NoProfile', '-NonInteractive', '-Command', SLEEP_SCRIPT]);
    expect(SLEEP_SCRIPT).toBe(
      "Add-Type -AssemblyName System.Windows.Forms; if ([System.Windows.Forms.Application]::SetSuspendState('Suspend',$false,$false)) { exit 0 } else { exit 1 }",
    );
  });

  it('never sleeps through rundll32 / powrprof (that hibernates instead)', () => {
    const line = formatCommandLine(buildPowerCommand('sleep', { force: true }, ROOT)).toLowerCase();
    expect(line).not.toContain('rundll32');
    expect(line).not.toContain('powrprof');
  });

  it('locks with rundll32 user32.dll,LockWorkStation', () => {
    expect(buildPowerCommand('lock', { force: true }, ROOT)).toEqual({ file: 'C:\\Windows\\System32\\rundll32.exe', args: ['user32.dll,LockWorkStation'] });
  });

  it('uses absolute System32 paths of the given Windows folder for every action', () => {
    for (const action of REAL_ACTIONS) {
      const { file } = buildPowerCommand(action, { force: true }, 'D:\\WinNT');
      expect(path.win32.isAbsolute(file), action).toBe(true);
      expect(file.startsWith('D:\\WinNT\\System32\\'), action).toBe(true);
    }
  });

  it('uses neither a shell nor an encoded or hidden-window command', () => {
    for (const action of REAL_ACTIONS) {
      const command = buildPowerCommand(action, { force: true }, ROOT);
      expect(path.win32.basename(command.file).toLowerCase()).not.toBe('cmd.exe');
      const flags = command.args.map((arg) => arg.toLowerCase());
      expect(flags.some((arg) => arg.startsWith('-enc') || arg.startsWith('-w')), action).toBe(false);
    }
  });

  it('has no command for anything else', () => {
    expect(() => buildPowerCommand('notify' as never, { force: true }, ROOT)).toThrow();
    expect(() => buildPowerCommand('restart' as never, { force: true }, ROOT)).toThrow();
  });

  it('formats the command for the log, quoting parts with spaces', () => {
    expect(formatCommandLine({ file: 'C:\\Windows\\System32\\shutdown.exe', args: ['/s', '/t', '0', '/f'] })).toBe('C:\\Windows\\System32\\shutdown.exe /s /t 0 /f');
    expect(formatCommandLine({ file: 'C:\\Win dows\\a.exe', args: ['say "hi"'] })).toBe('"C:\\Win dows\\a.exe" "say \\"hi\\""');
  });
});

describe('interpretPowerResult', () => {
  it('counts exit code 0 as done', () => {
    for (const action of REAL_ACTIONS) {
      expect(interpretPowerResult(action, runResult(), 'cmd')).toMatchObject({ ok: true, command: 'cmd', exitCode: 0 });
    }
  });

  it('reports an early non-zero exit as a failure with the message Windows printed', () => {
    const result = interpretPowerResult('shutdown', runResult({ code: 5, stderr: '\r\nAccess is denied.(5)\r\n', elapsedMs: 120 }), 'cmd');
    expect(result).toMatchObject({ ok: false, exitCode: 5, command: 'cmd' });
    expect(result.detail).toContain('Access is denied.(5)');
    expect(result.detail).toContain('exit code 5');
  });

  it('falls back to stdout, then to "no message"', () => {
    expect(interpretPowerResult('hibernate', runResult({ code: 1, stdout: 'Hibernation is not enabled.\n' }), 'cmd').detail).toContain('Hibernation is not enabled.');
    expect(interpretPowerResult('hibernate', runResult({ code: 1 }), 'cmd').detail).toContain('no message');
  });

  it('reports a command that could not be started', () => {
    const result = interpretPowerResult('shutdown', runResult({ started: false, code: null, error: 'not found: C:\\Windows\\System32\\shutdown.exe' }), 'cmd');
    expect(result).toMatchObject({ ok: false, exitCode: null });
    expect(result.detail).toContain('not found');
  });

  it('treats a shut down or lock command that hangs as a failure', () => {
    for (const action of ['shutdown', 'lock'] as const) {
      expect(interpretPowerResult(action, runResult({ code: null, timedOut: true, elapsedMs: ACTION_TIMEOUT_MS }), 'cmd').ok, action).toBe(false);
    }
  });

  describe('sleep and hibernate return only after the PC wakes up', () => {
    for (const action of ['sleep', 'hibernate'] as const) {
      it(`${action}: a timeout means the PC went to sleep`, () => {
        expect(interpretPowerResult(action, runResult({ code: null, timedOut: true, elapsedMs: ACTION_TIMEOUT_MS + 12 }), 'cmd').ok).toBe(true);
      });

      it(`${action}: a timeout after hours of wall time says the PC slept and woke up`, () => {
        const result = interpretPowerResult(action, runResult({ code: null, timedOut: true, elapsedMs: 8 * 3600_000 }), 'cmd');
        expect(result.ok).toBe(true);
        expect(result.detail).toMatch(/woken up/);
      });

      it(`${action}: exit 0 after a long time is a wake-up, not an error`, () => {
        const result = interpretPowerResult(action, runResult({ code: 0, elapsedMs: 3 * 3600_000 }), 'cmd');
        expect(result).toMatchObject({ ok: true, exitCode: 0 });
        expect(result.detail).toMatch(/woken up/);
      });

      it(`${action}: only an immediate non-zero exit is a failure`, () => {
        expect(interpretPowerResult(action, runResult({ code: 1, elapsedMs: 900 }), 'cmd')).toMatchObject({ ok: false, exitCode: 1 });
        expect(interpretPowerResult(action, runResult({ code: 1, elapsedMs: 5000 }), 'cmd').ok).toBe(false);
        expect(interpretPowerResult(action, runResult({ code: 1, elapsedMs: 5001 }), 'cmd').ok).toBe(true);
        expect(interpretPowerResult(action, runResult({ code: 1, elapsedMs: 6 * 3600_000 }), 'cmd').ok).toBe(true);
      });

      it(`${action}: is confirmed only by a resume gap longer than the call's own timeout allows`, () => {
        const result = (overrides: Parameters<typeof runResult>[0]) => interpretPowerResult(action, runResult(overrides), 'cmd');
        expect(result({ code: null, timedOut: true, elapsedMs: 8 * 3600_000 }).confirmed).toBe(true);
        expect(result({ code: 0, elapsedMs: 3 * 3600_000 }).confirmed).toBe(true);
        expect(result({ code: 1, elapsedMs: 6 * 3600_000 }).confirmed).toBe(true);
        // Exited soon after: accepted, but nothing shows either way.
        expect(result({ code: 0, elapsedMs: 900 }).confirmed).toBeNull();
        expect(result({ code: 0, elapsedMs: 12_000 }).confirmed).toBeNull();
        expect(result({ code: 1, elapsedMs: 900 }).confirmed).toBeNull();
      });

      it(`${action}: still running at the timeout with no gap means this PC stayed awake: NOT confirmed`, () => {
        const result = interpretPowerResult(action, runResult({ code: null, timedOut: true, elapsedMs: ACTION_TIMEOUT_MS + 12 }), 'cmd');
        expect(result).toMatchObject({ ok: true, confirmed: false });
        expect(result.detail).toMatch(/still running after 25 seconds, and nothing showed that this PC went to/);
      });
    }
  });

  it('never confirms a shut down by itself, and a failure carries no confirmation', () => {
    expect(interpretPowerResult('shutdown', runResult(), 'cmd')).toMatchObject({ ok: true, confirmed: null });
    expect(interpretPowerResult('shutdown', runResult({ code: 0, elapsedMs: 3 * 3600_000 }), 'cmd').confirmed).toBeNull();
    expect(interpretPowerResult('lock', runResult({ code: null, timedOut: true, elapsedMs: ACTION_TIMEOUT_MS }), 'cmd')).toMatchObject({ ok: false, confirmed: null });
    expect(interpretPowerResult('shutdown', runResult({ started: false, code: null, error: 'not found' }), 'cmd').confirmed).toBeNull();
  });
});

describe('executePowerAction', () => {
  it('refuses every power action when CLAUDE_AUTOSHUTDOWN_NO_POWER=1 and starts nothing', async () => {
    for (const action of REAL_ACTIONS) {
      const fake = fakeDeps(runResult(), [['logonui']], { CLAUDE_AUTOSHUTDOWN_NO_POWER: '1' });
      const result = await executePowerAction(action, { force: true }, fake.deps);
      expect(result, action).toMatchObject({ ok: false, command: null, exitCode: null });
      expect(result.detail).toContain('CLAUDE_AUTOSHUTDOWN_NO_POWER');
      expect(fake.calls, action).toHaveLength(0);
    }
  });

  it('does nothing for notify and still succeeds', async () => {
    const fake = fakeDeps();
    expect(await executePowerAction('notify', { force: true }, fake.deps)).toEqual({
      ok: true,
      detail: 'Nothing was done to this PC.',
      command: null,
      exitCode: null,
      confirmed: null,
    });
    expect(fake.calls).toHaveLength(0);
  });

  it('refuses an action it does not know instead of guessing', async () => {
    for (const action of ['restart', '', 'SHUTDOWN', undefined, null, 5] as unknown[]) {
      const fake = fakeDeps();
      const result = await executePowerAction(action as never, { force: true }, fake.deps);
      expect(result.ok, String(action)).toBe(false);
      expect(fake.calls, String(action)).toHaveLength(0);
    }
  });

  it('refuses when the Windows folder is unknown', async () => {
    const fake = fakeDeps();
    const result = await executePowerAction('shutdown', { force: true }, { ...fake.deps, systemRoot: null });
    expect(result).toMatchObject({ ok: false, command: null });
    expect(fake.calls).toHaveLength(0);
  });

  it('runs exactly one command with the 25 s timeout and reports it', async () => {
    const fake = fakeDeps(runResult());
    const result = await executePowerAction('shutdown', { force: true }, fake.deps);
    expect(fake.calls).toEqual([{ file: 'C:\\Windows\\System32\\shutdown.exe', args: ['/s', '/t', '0', '/f'], options: { timeoutMs: 25_000 } }]);
    expect(result).toMatchObject({ ok: true, exitCode: 0, command: 'C:\\Windows\\System32\\shutdown.exe /s /t 0 /f' });
  });

  it('passes force through and leaves /f out when it is off or malformed', async () => {
    for (const force of [false, 'yes', undefined] as unknown[]) {
      const fake = fakeDeps();
      await executePowerAction('shutdown', { force: force as boolean }, fake.deps);
      expect(fake.calls[0]?.args, String(force)).toEqual(['/s', '/t', '0']);
    }
    const missing = fakeDeps();
    await executePowerAction('shutdown', undefined as never, missing.deps);
    expect(missing.calls[0]?.args).toEqual(['/s', '/t', '0']);
  });

  it('reports an early refusal by Windows as a failure', async () => {
    const fake = fakeDeps(runResult({ code: 1, stderr: 'A required privilege is not held by the client.(1314)', elapsedMs: 200 }));
    const result = await executePowerAction('hibernate', { force: false }, fake.deps);
    expect(result).toMatchObject({ ok: false, exitCode: 1, command: 'C:\\Windows\\System32\\shutdown.exe /h' });
    expect(result.detail).toContain('A required privilege is not held by the client.(1314)');
  });

  it('reports a sleep that outlived the timeout as done', async () => {
    const fake = fakeDeps(runResult({ code: null, timedOut: true, elapsedMs: 7 * 3600_000 }));
    const result = await executePowerAction('sleep', { force: true }, fake.deps);
    expect(result.ok).toBe(true);
    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0]?.file).toBe('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
  });

  it('never rejects, even when the runner throws', async () => {
    const fake = fakeDeps(new Error('spawn EPERM'));
    const result = await executePowerAction('shutdown', { force: true }, fake.deps);
    expect(result.ok).toBe(false);
    expect(result.detail).toContain('spawn EPERM');
  });

  describe('lock', () => {
    it('is confirmed when the lock screen process appears', async () => {
      const fake = fakeDeps(runResult(), [['explorer', 'code'], ['explorer', 'logonui']]);
      const result = await executePowerAction('lock', { force: true }, fake.deps);
      expect(result).toMatchObject({
        ok: true,
        detail: 'This PC is locked.',
        command: 'C:\\Windows\\System32\\rundll32.exe user32.dll,LockWorkStation',
        confirmed: true,
      });
      expect(fake.polls()).toBe(2);
    });

    it('still succeeds, but reports it as NOT confirmed, when Windows never shows the lock screen within about 3 s', async () => {
      const fake = fakeDeps(runResult(), [['explorer']]);
      const result = await executePowerAction('lock', { force: true }, fake.deps);
      expect(result).toMatchObject({ ok: true, confirmed: false });
      expect(result.detail).toMatch(/didn't confirm/);
      expect(fake.polls()).toBe(6);
      expect(fake.delays.reduce((sum, ms) => sum + ms, 0)).toBe(3000);
    });

    it('does not take an unreadable process list for a confirmation', async () => {
      const fake = fakeDeps(runResult(), [null]);
      const result = await executePowerAction('lock', { force: true }, fake.deps);
      expect(result).toMatchObject({ ok: true, confirmed: false });
      expect(result.detail).toMatch(/didn't confirm/);
    });

    it('does not look for the lock screen when the command could not be started', async () => {
      const fake = fakeDeps(runResult({ started: false, code: null, error: 'not found' }), [['logonui']]);
      const result = await executePowerAction('lock', { force: true }, fake.deps);
      expect(result.ok).toBe(false);
      expect(fake.polls()).toBe(0);
    });
  });
});
