import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { RunResult } from '../../src/platform/exec';
import {
  KeepAwake,
  alertDeadlineMs,
  alertSeconds,
  alertText,
  blankDetail,
  containsAny,
  countdownSoundOffsetsMs,
  describeRunFailure,
  detailNeedles,
  errnoCode,
  exitedCleanly,
  firstLine,
  formatClock,
  formatCommand,
  helperStatusOf,
  inertAlert,
  mapLimit,
  normaliseProcessName,
  powerActionsDisabled,
  runPowerCommand,
  scheduleCountdownSounds,
  validPids,
} from '../../src/platform/posixShared';
import type { CountdownAlertOptions } from '../../src/platform/types';
import { FakeSystem, errno } from './fakeSystem';

const result = (overrides: Partial<RunResult>): RunResult => ({
  started: true,
  code: 0,
  stdout: '',
  stderr: '',
  timedOut: false,
  error: null,
  elapsedMs: 5,
  ...overrides,
});

describe('validators', () => {
  it('keeps positive integer PIDs only, once each', () => {
    expect(validPids([1, 72450, 72450, 0, -3, 1.5, Number.NaN, Number.POSITIVE_INFINITY, '7', null, undefined, 2 ** 60])).toEqual([1, 72450]);
    expect(validPids(undefined)).toEqual([]);
    expect(validPids('1,2')).toEqual([]);
  });

  it('normalises detail names and drops empty ones', () => {
    expect(detailNeedles(['Claude', ' node ', '', '   ', 7, null])).toEqual(['claude', 'node']);
    expect(detailNeedles(undefined)).toEqual([]);
  });

  it('matches case-insensitively and never on unknown text', () => {
    expect(containsAny('/Users/u/.local/bin/Claude', ['claude'])).toBe(true);
    expect(containsAny('node', ['claude'])).toBe(false);
    expect(containsAny(null, ['claude'])).toBe(false);
    expect(containsAny('anything', [])).toBe(false);
  });

  it('normalises process names', () => {
    expect(normaliseProcessName('Claude')).toBe('claude');
    expect(normaliseProcessName('Notepad.EXE')).toBe('notepad');
    expect(normaliseProcessName('2.1.283')).toBe('2.1.283');
  });

  it('reads errno codes', () => {
    expect(errnoCode(errno('EACCES'))).toBe('EACCES');
    expect(errnoCode(new Error('plain'))).toBe('UNKNOWN');
    expect(errnoCode(null)).toBe('UNKNOWN');
    expect(errnoCode({ code: 13 })).toBe('UNKNOWN');
  });

  it('builds an all-unknown detail', () => {
    expect(blankDetail('denied')).toEqual({ state: 'denied', path: null, startRaw: null, startEpochMs: null, cpuSeconds: null, ioBytes: null });
  });

  it('takes the first non-empty line of a message', () => {
    expect(firstLine('\n  Call to PowerOff failed: Access denied\nmore\n')).toBe('Call to PowerOff failed: Access denied');
    expect(firstLine('')).toBe('');
    expect(firstLine('x'.repeat(1000))).toHaveLength(300);
  });
});

describe('mapLimit', () => {
  it('keeps the order and never runs more than the limit at once', async () => {
    let running = 0;
    let peak = 0;
    const out = await mapLimit([5, 4, 3, 2, 1, 0], 2, async (value) => {
      running++;
      peak = Math.max(peak, running);
      await new Promise((resolve) => setTimeout(resolve, value));
      running--;
      return value * 10;
    });
    expect(out).toEqual([50, 40, 30, 20, 10, 0]);
    expect(peak).toBe(2);
  });

  it('handles an empty list', async () => {
    expect(await mapLimit([], 8, async (value: number) => value)).toEqual([]);
  });
});

describe('helperStatusOf', () => {
  it('is unavailable for an environment or process-list problem, limited without idle time, else full', () => {
    expect(helperStatusOf({ environmentProblem: 'sandbox', processListProblem: 'no list', idleProblem: 'no idle' })).toEqual({
      tier: 'unavailable',
      problem: 'sandbox',
    });
    expect(helperStatusOf({ environmentProblem: null, processListProblem: 'no list', idleProblem: null })).toEqual({
      tier: 'unavailable',
      problem: 'no list',
    });
    expect(helperStatusOf({ environmentProblem: null, processListProblem: null, idleProblem: 'no idle' })).toEqual({
      tier: 'limited',
      problem: 'no idle',
    });
    expect(helperStatusOf({ environmentProblem: null, processListProblem: null, idleProblem: null })).toEqual({ tier: 'full', problem: null });
  });
});

describe('judging a tool run', () => {
  it('is clean only for a started process that exited 0 in time', () => {
    expect(exitedCleanly(result({}))).toBe(true);
    expect(exitedCleanly(result({ code: 1 }))).toBe(false);
    expect(exitedCleanly(result({ code: null }))).toBe(false);
    expect(exitedCleanly(result({ timedOut: true, code: null }))).toBe(false);
    expect(exitedCleanly(result({ started: false, code: null, error: 'ENOENT' }))).toBe(false);
  });

  it('describes each kind of failure', () => {
    expect(describeRunFailure('systemctl', result({ started: false, code: null, error: 'spawn EACCES' }))).toBe(
      'systemctl could not be started (spawn EACCES)',
    );
    expect(describeRunFailure('busctl', result({ timedOut: true, code: null }))).toBe('busctl did not answer in time');
    expect(describeRunFailure('systemctl', result({ code: 1, stderr: 'Failed to hibernate system via logind: Not enough swap space\n' }))).toBe(
      'systemctl failed with exit code 1: Failed to hibernate system via logind: Not enough swap space',
    );
    expect(describeRunFailure('pmset', result({ code: 2, stdout: 'usage: pmset\n' }))).toBe('pmset failed with exit code 2: usage: pmset');
    expect(describeRunFailure('pmset', result({ code: null }))).toBe('pmset failed with exit code none: it gave no reason');
  });

  it('prints a command line the way it would be typed', () => {
    expect(formatCommand('/usr/bin/systemctl', ['poweroff', '-i'])).toBe('/usr/bin/systemctl poweroff -i');
    expect(formatCommand('/usr/bin/osascript', ['-e', 'tell application "System Events" to shut down'])).toBe(
      `/usr/bin/osascript -e 'tell application "System Events" to shut down'`,
    );
    expect(formatCommand('/bin/x', ["it's", ''])).toBe(`/bin/x 'it'\\''s' ''`);
  });
});

describe('powerActionsDisabled', () => {
  it('is on only for exactly "1"', () => {
    expect(powerActionsDisabled({ CLAUDE_AUTOSHUTDOWN_NO_POWER: '1' })).toBe(true);
    expect(powerActionsDisabled({ CLAUDE_AUTOSHUTDOWN_NO_POWER: '0' })).toBe(false);
    expect(powerActionsDisabled({})).toBe(false);
  });

  it('is on in this test run', () => {
    expect(powerActionsDisabled(process.env)).toBe(true);
  });
});

describe('runPowerCommand', () => {
  const run = async (suspends: boolean, reply: Partial<RunResult>) => {
    const system = new FakeSystem();
    system.install('tool');
    system.on('tool', () => reply);
    const outcome = await runPowerCommand(system, { file: '/usr/bin/tool', args: ['now'], suspends, done: 'Done.' }, { A: 'b' });
    return { system, outcome };
  };

  it('succeeds on exit 0 and passes the environment and the 25 s timeout', async () => {
    const { system, outcome } = await run(false, {});
    expect(outcome).toEqual({ ok: true, detail: 'Done.', command: '/usr/bin/tool now', exitCode: 0, confirmed: null });
    expect(system.calls[0]?.options).toEqual({ timeoutMs: 25_000, env: { A: 'b' } });
  });

  it('is confirmed only by a resume gap, and never for a command that cannot show it', async () => {
    expect((await run(true, { timedOut: true, code: null, elapsedMs: 30_001 })).outcome.confirmed).toBe(true);
    expect((await run(true, {})).outcome).toMatchObject({ ok: true, confirmed: null });
    expect((await run(false, { code: 1, stderr: 'no' })).outcome.confirmed).toBeNull();

    const system = new FakeSystem();
    system.install('tool');
    const command = { file: '/usr/bin/tool', args: ['now'], suspends: false, done: 'Display off.', neverConfirmed: true };
    expect(await runPowerCommand(system, command, {})).toMatchObject({ ok: true, detail: 'Display off.', confirmed: false });
  });

  it('fails on a non-zero exit, a timeout and a failed start', async () => {
    expect((await run(false, { code: 1, stderr: 'no' })).outcome).toMatchObject({ ok: false, exitCode: 1, command: '/usr/bin/tool now' });
    expect((await run(false, { timedOut: true, code: null, elapsedMs: 25_001 })).outcome.ok).toBe(false);
    expect((await run(true, { started: false, code: null, error: 'EACCES', elapsedMs: 99_999_999 })).outcome.ok).toBe(false);
  });

  it('treats a call that outlived its own timeout by more than 5 s as "we slept" - for suspending actions only', async () => {
    expect((await run(true, { timedOut: true, code: null, elapsedMs: 30_001 })).outcome.ok).toBe(true);
    expect((await run(true, { code: 1, stderr: 'woke up', elapsedMs: 3_600_000 })).outcome.ok).toBe(true);
    expect((await run(true, { timedOut: true, code: null, elapsedMs: 30_000 })).outcome.ok).toBe(false);
    expect((await run(false, { timedOut: true, code: null, elapsedMs: 3_600_000 })).outcome.ok).toBe(false);
  });

  it('fails a suspending action that exits non-zero early', async () => {
    const { outcome } = await run(true, { code: 1, stderr: 'Call to Suspend failed: Access denied', elapsedMs: 40 });
    expect(outcome).toMatchObject({ ok: false, exitCode: 1 });
    expect(outcome.detail).toMatch(/Access denied/);
  });
});

describe('KeepAwake', () => {
  const make = (command: () => { file: string; args: string[] } | { problem: string } = () => ({ file: '/usr/bin/holder', args: ['-x'] })) => {
    const system = new FakeSystem();
    return { system, keepAwake: new KeepAwake(system, command, () => ({ ENV: 'yes' })) };
  };

  it('starts one child and passes the environment', async () => {
    const { system, keepAwake } = make();
    expect((await keepAwake.set(true)).ok).toBe(true);
    expect(system.holds).toHaveLength(1);
    expect(system.holds[0]).toMatchObject({ file: '/usr/bin/holder', args: ['-x'], env: { ENV: 'yes' } });
  });

  it('reports a child that ends within the grace period, with its message or its exit code', async () => {
    const withMessage = make();
    withMessage.system.holdEndsWith = { code: 1, stderr: 'Failed to inhibit: Access denied\n' };
    expect(await withMessage.keepAwake.set(true)).toEqual({ ok: false, detail: "Can't keep this computer awake: Failed to inhibit: Access denied" });

    const silent = make();
    silent.system.holdEndsWith = { code: 127, stderr: '' };
    expect((await silent.keepAwake.set(true)).detail).toBe("Can't keep this computer awake: holder stopped at once (exit code 127)");
  });

  it('reports why it is not possible without starting anything', async () => {
    const { system, keepAwake } = make(() => ({ problem: 'no tool' }));
    expect(await keepAwake.set(true)).toEqual({ ok: false, detail: 'no tool' });
    expect(system.holds).toHaveLength(0);
  });

  it('releasing without holding is fine', async () => {
    const { keepAwake } = make();
    expect((await keepAwake.set(false)).ok).toBe(true);
  });

  it('turns an unexpected error into a failed outcome and keeps working afterwards', async () => {
    const { system, keepAwake } = make();
    const original = system.hold;
    system.hold = () => {
      throw new Error('boom');
    };
    expect(await keepAwake.set(true)).toEqual({ ok: false, detail: 'Keeping this computer awake failed: boom' });
    system.hold = original;
    expect((await keepAwake.set(true)).ok).toBe(true);
  });
});

describe('countdown alert helpers', () => {
  const options: CountdownAlertOptions = {
    seconds: 90,
    kind: 'real',
    title: 'Shutting down this PC in',
    body: 'All Claude sessions finished.',
    cancelLabel: 'Cancel: keep this PC on',
    sound: true,
  };

  it('formats m:ss', () => {
    expect(formatClock(90)).toBe('1:30');
    expect(formatClock(5)).toBe('0:05');
    expect(formatClock(600)).toBe('10:00');
    expect(formatClock(59.9)).toBe('0:59');
    expect(formatClock(-3)).toBe('0:00');
    expect(formatClock(Number.NaN)).toBe('0:00');
  });

  it('names the wall-clock time the countdown ends at', () => {
    const now = new Date(2026, 9, 3, 2, 58, 30).getTime();
    expect(alertText(options, now)).toEqual({
      title: 'Shutting down this PC in 1:30',
      body: 'All Claude sessions finished.\nPlanned for 03:00:00. To cancel, go back to your editor.',
    });
  });

  it('fixes one deadline at the call, in whole seconds rounded down', () => {
    const now = new Date(2026, 9, 3, 2, 58, 30).getTime();
    expect(alertSeconds({ ...options, seconds: 89.9 })).toBe(89);
    expect(alertDeadlineMs({ ...options, seconds: 89.9 }, now)).toBe(now + 89_000);
    expect(alertText({ ...options, seconds: 89.9 }, now).title).toBe('Shutting down this PC in 1:29');
    for (const seconds of [0, -4, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(alertDeadlineMs({ ...options, seconds }, now), String(seconds)).toBe(now);
    }
  });

  it('plays at the start and at each of the last five seconds', () => {
    expect(countdownSoundOffsetsMs(90)).toEqual([0, 85_000, 86_000, 87_000, 88_000, 89_000]);
    expect(countdownSoundOffsetsMs(15)).toEqual([0, 10_000, 11_000, 12_000, 13_000, 14_000]);
  });

  it('does not schedule sounds before the start of a very short countdown', () => {
    expect(countdownSoundOffsetsMs(3)).toEqual([0, 1000, 2000]);
    expect(countdownSoundOffsetsMs(5)).toEqual([0, 1000, 2000, 3000, 4000]);
    expect(countdownSoundOffsetsMs(0)).toEqual([0]);
    expect(countdownSoundOffsetsMs(-10)).toEqual([0]);
    expect(countdownSoundOffsetsMs(Number.NaN)).toEqual([0]);
  });

  describe('scheduleCountdownSounds', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('plays now, then on schedule, and can be cancelled', () => {
      const play = vi.fn();
      const cancel = scheduleCountdownSounds(10, play);
      expect(play).toHaveBeenCalledTimes(1);
      vi.advanceTimersByTime(5_000);
      expect(play).toHaveBeenCalledTimes(2);
      vi.advanceTimersByTime(2_000);
      expect(play).toHaveBeenCalledTimes(4);
      cancel();
      vi.advanceTimersByTime(60_000);
      expect(play).toHaveBeenCalledTimes(4);
    });
  });

  it('an inert alert never fires and can be stopped', () => {
    const listener = vi.fn();
    const alert = inertAlert();
    alert.onCancel(listener);
    alert.stop();
    expect(listener).not.toHaveBeenCalled();
  });
});
