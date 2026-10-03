import * as fs from 'node:fs';

import { afterEach, describe, expect, it } from 'vitest';

import type { ScanResult } from '../../src/core/types';
import type { ActionResult } from '../../src/platform/types';
import { contractDigest, toArmContract } from '../../src/shared/config';
import type { LastResult, Phase } from '../../src/shared/protocol';
import { Harness, LEADER, busyScan, clearScan, deferred, drain, removeTempDirs } from './harness';

afterEach(removeTempDirs);

/** Arm, count down, and stop at the instant the countdown has elapsed (phase `committing`). */
async function untilCommitting(h: Harness): Promise<void> {
  await h.armUntilCountdown();
  await h.advanceUntil((state) => state.phase === 'committing', 60_000);
}

function cancelled(h: Harness): Extract<LastResult, { kind: 'cancelled' }> {
  const result = h.state.lastResult;
  if (result?.kind !== 'cancelled') throw new Error(`expected a cancelled result, got ${JSON.stringify(result)}`);
  return result;
}

describe('the final gate', () => {
  it('runs a fresh forceWide scan after the countdown and waits for it before acting', async () => {
    const h = new Harness();
    const fresh = deferred<ScanResult>();
    h.scanner.script = (request) => (request.forceWide ? fresh.promise : clearScan());

    await untilCommitting(h);
    const forceWide = h.scanner.requests.filter((request) => request.forceWide);
    expect(forceWide).toHaveLength(1);
    expect(h.scanner.requests.at(-1)?.forceWide).toBe(true);
    expect(h.state.countdown?.remainingMs).toBe(0);

    // The 250 ms barrier is long over, but the fresh scan has not answered: nothing may run.
    await h.clock.advance(5_000);
    expect(h.state.phase).toBe('committing');
    expect(h.platform.executeCalls).toHaveLength(0);

    fresh.resolve(clearScan());
    await drain();
    expect(h.platform.executeCalls).toEqual([{ action: 'shutdown', force: true }]);
  });

  it('waits out the 250 ms barrier even when the fresh scan answers at once', async () => {
    const h = new Harness();
    await untilCommitting(h);
    await h.clock.advance(249);
    expect(h.platform.executeCalls).toHaveLength(0);
    await h.clock.advance(1);
    expect(h.platform.executeCalls).toHaveLength(1);
  });

  it('a fresh scan that is not clear blocks: cancelled, still watching', async () => {
    const h = new Harness();
    h.scanner.script = (request) => (request.forceWide ? busyScan('late-session') : clearScan());
    await h.armUntilCountdown();
    await h.clock.advance(30_000); // the countdown elapses; the fresh scan answers within the same tick

    expect(h.scanner.requests.filter((request) => request.forceWide)).toHaveLength(1);
    expect(h.platform.executeCalls).toHaveLength(0);
    expect(h.state).toMatchObject({ armed: true, phase: 'watching', countdown: null });
    expect(cancelled(h)).toMatchObject({ reason: { id: 'sessionResumed', name: 'late-session' }, stillWatching: true });
    expect(h.state.cooldownRemainingMs).toBe(60_000);

    await h.clock.advance(5_000);
    expect(h.platform.executeCalls).toHaveLength(0);
  });

  it('a fresh scan that fails blocks', async () => {
    const h = new Harness();
    h.scanner.script = (request) => {
      if (request.forceWide) throw new Error('helper timed out');
      return clearScan();
    };
    await h.armUntilCountdown();
    await h.clock.advance(30_000);

    expect(h.platform.executeCalls).toHaveLength(0);
    expect(h.state).toMatchObject({ armed: true, phase: 'watching', countdown: null });
    expect(cancelled(h).reason).toEqual({ id: 'checkFailed', check: 'scanner' });

    await h.clock.advance(5_000);
    expect(h.platform.executeCalls).toHaveLength(0);
  });

  it('a STOP file that appears during the barrier blocks', async () => {
    const h = new Harness();
    await untilCommitting(h);
    h.createStopFile('stop.txt');
    await h.clock.advance(250);

    expect(h.platform.executeCalls).toHaveLength(0);
    expect(h.state).toMatchObject({ armed: true, phase: 'watching', countdown: null });
    expect(cancelled(h)).toMatchObject({ reason: { id: 'emergencyStop' }, stillWatching: true });
  });

  it('a state dir that cannot be read counts as Emergency stop', async () => {
    const h = new Harness();
    await untilCommitting(h);
    fs.rmSync(h.stateDir.dir, { recursive: true, force: true });
    await h.clock.advance(250);

    expect(h.platform.executeCalls).toHaveLength(0);
    expect(h.state.stop.present).toBe(true);
    expect(cancelled(h).reason).toEqual({ id: 'emergencyStop' });
  });

  it('a Cancel that arrives during the barrier blocks and stops watching', async () => {
    const h = new Harness();
    await untilCommitting(h);
    expect(await h.send({ name: 'cancel', via: 'esc' })).toEqual({ ok: true });
    await h.clock.advance(5_000);

    expect(h.platform.executeCalls).toHaveLength(0);
    expect(h.state).toMatchObject({ armed: false, phase: 'off', countdown: null });
    expect(cancelled(h)).toMatchObject({ reason: { id: 'user', via: 'esc' }, stillWatching: false });
  });

  it('Stop watching during the barrier blocks', async () => {
    const h = new Harness();
    await untilCommitting(h);
    await h.send({ name: 'disarm' });
    await h.clock.advance(5_000);
    expect(h.platform.executeCalls).toHaveLength(0);
    expect(h.state.armed).toBe(false);
  });

  it('no longer holding the leadership endpoint blocks', async () => {
    const h = new Harness();
    await untilCommitting(h);
    h.world.leader = false;
    await h.clock.advance(250);

    expect(h.platform.executeCalls).toHaveLength(0);
    expect(h.state).toMatchObject({ armed: true, countdown: null });
    expect(cancelled(h)).toMatchObject({ reason: { id: 'leaderChanged' }, stillWatching: true });
  });

  it('a time jump during the barrier blocks and stops watching', async () => {
    const h = new Harness();
    const fresh = deferred<ScanResult>();
    h.scanner.script = (request) => (request.forceWide ? fresh.promise : clearScan());
    await untilCommitting(h);
    await h.clock.advance(250);

    h.clock.shiftWall(3_600_000); // the gate is the first to look at the clocks again
    fresh.resolve(clearScan());
    await drain();

    expect(h.platform.executeCalls).toHaveLength(0);
    expect(h.state.armed).toBe(false);
    expect(h.state.lastResult).toMatchObject({ kind: 'stopped', cause: 'timeJump' });
  });

  it('rules that changed during the barrier (an ignore) void the fresh scan', async () => {
    const h = new Harness();
    const fresh = deferred<ScanResult>();
    const followUp = deferred<ScanResult>();
    let deferredScans = 0;
    h.scanner.script = (request) => {
      if (!request.forceWide && h.state.phase !== 'committing') return clearScan();
      return deferredScans++ === 0 ? fresh.promise : followUp.promise;
    };
    await untilCommitting(h);
    await h.send({ name: 'ignore', key: 'proc:1:2', on: true });
    await h.clock.advance(250);
    fresh.resolve(clearScan());
    await drain();

    expect(h.platform.executeCalls).toHaveLength(0);
    expect(h.state.armed).toBe(true);
    expect(cancelled(h).reason).toEqual({ id: 'checkFailed', check: 'scanner' });
  });
});

describe('test run', () => {
  it('ends in testPassed without calling execute, and remembers that a test run passed', async () => {
    const h = new Harness({ config: { testMode: true } });
    await h.armUntilCountdown();
    const armedAtMs = h.state.armedAtMs;
    expect(h.state.countdown?.kind).toBe('test');
    expect(h.platform.alerts[0]?.options.kind).toBe('test');

    await h.clock.advance(31_000);

    expect(h.platform.executeCalls).toHaveLength(0);
    expect(h.state).toMatchObject({ armed: false, phase: 'off', countdown: null, testPassedOnce: true });
    expect(h.state.lastResult).toMatchObject({ kind: 'testPassed', action: 'shutdown', armedAtMs });
    expect(h.watchingFileExists()).toBe(false);
    expect(h.lastRunFile()).toMatchObject({ testPassedOnce: true, dismissed: false, lastResult: { kind: 'testPassed' } });
    expect(h.logText()).toContain('Test run passed');
    expect(h.platform.alerts[0]?.stopped).toBe(true);

    await h.clock.advance(300_000);
    expect(h.platform.executeCalls).toHaveLength(0);
    expect(h.state.armed).toBe(false);
  });

  it('reports when everything went clear and which session held things up', async () => {
    const h = new Harness({ config: { testMode: true } });
    h.scanner.script = (_request, index) => (index < 4 ? busyScan('slow-build') : clearScan());
    await h.arm();
    await h.advanceUntil((state) => state.lastResult?.kind === 'testPassed', 300_000, 1_000);

    const result = h.state.lastResult;
    if (result?.kind !== 'testPassed') throw new Error('unreachable');
    expect(result.heldUpBy).toEqual({ name: 'slow-build', seconds: 30 });
    expect(result.allClearAtMs).toBeLessThan(result.atMs);
    expect(result.allClearAtMs).toBeGreaterThan(result.armedAtMs ?? 0);
    expect(result.lastSessionFinishedAtMs).toBe(clearScan().sessions[0]?.lastActivityMs);
  });

  it('testPassedOnce survives later results', async () => {
    const h = new Harness({ config: { testMode: true } });
    await h.armUntilCountdown();
    await h.clock.advance(31_000);
    await h.arm();
    await h.send({ name: 'disarm' });
    expect(h.state.testPassedOnce).toBe(true);
    expect(h.lastRunFile()).toMatchObject({ testPassedOnce: true });
  });
});

describe('real run', () => {
  it('writes the log and last-run.json and stops watching BEFORE execute is called', async () => {
    const h = new Harness();
    const seen: { armed?: boolean; phase?: Phase; lastRun?: unknown; log?: string; watching?: boolean; keepAwake?: boolean[] } = {};
    h.platform.onExecute = () => {
      seen.armed = h.state.armed;
      seen.phase = h.state.phase;
      seen.lastRun = h.lastRunFile();
      seen.log = h.logText();
      seen.watching = h.watchingFileExists();
      seen.keepAwake = [...h.platform.keepAwakeCalls];
    };
    await h.armUntilCountdown();
    await h.clock.advance(31_000);

    expect(h.platform.executeCalls).toEqual([{ action: 'shutdown', force: true }]);
    expect(seen.armed).toBe(false);
    expect(seen.phase).toBe('executing');
    expect(seen.lastRun).toMatchObject({ dismissed: false, lastResult: { kind: 'done', action: 'shutdown', confirmed: null } });
    expect(seen.log).toContain('This PC will now shut down');
    expect(seen.watching).toBe(false);
    expect(seen.keepAwake).toEqual([true, false]);

    expect(h.state).toMatchObject({ armed: false, phase: 'off', countdown: null });
    expect(h.state.lastResult).toMatchObject({ kind: 'done', action: 'shutdown', confirmed: null, resumedAtMs: null });
    expect(h.platform.alerts[0]?.stopped).toBe(true);
  });

  it('while the action runs, every window is shown the rules of that run, not the leader settings', async () => {
    // The leader's own settings are a test run that would sleep; another editor armed a real shut down.
    const h = new Harness({ config: { testMode: true, action: 'sleep' } });
    const running = deferred<ActionResult>();
    h.platform.executeResult = running.promise;
    const contract = toArmContract({ ...h.world.config, testMode: false, action: 'shutdown' });
    expect((await h.arm({ contract, digest: contractDigest(contract), realm: 'realm-cursor' })).ok).toBe(true);
    await h.advanceUntil((state) => state.phase === 'executing', 120_000);

    expect(h.platform.executeCalls).toEqual([{ action: 'shutdown', force: true }]);
    expect(h.state).toMatchObject({ armed: false, phase: 'executing', contractRealm: 'realm-cursor' });
    expect(h.state.contract).toEqual(contract);
    expect(h.state.contractDigest).toBe(contractDigest(contract));
    expect(h.published.at(-1)?.state.contract).toEqual(contract);
    await h.clock.advance(5_000);
    expect(h.state.contract).toEqual(contract);

    running.resolve({ ok: true, detail: 'sent', command: 'fake', exitCode: 0, confirmed: null });
    await drain();
    expect(h.state.phase).toBe('off');
    expect(h.state.contract).toEqual(toArmContract(h.world.config));
    expect(h.state.contractRealm).toBe(LEADER.realm);
  });

  it('passes the contract\'s "close other apps" choice to execute', async () => {
    const h = new Harness({ config: { forceCloseApps: false } });
    await h.armUntilCountdown();
    await h.clock.advance(31_000);
    expect(h.platform.executeCalls).toEqual([{ action: 'shutdown', force: false }]);
  });

  it('shows `executing` while the command runs and refuses a new Start meanwhile', async () => {
    const h = new Harness({ config: { action: 'lock' } });
    const running = deferred<ActionResult>();
    h.platform.executeResult = running.promise;
    await h.armUntilCountdown();
    await h.clock.advance(31_000);

    expect(h.state).toMatchObject({ armed: false, phase: 'executing' });
    expect((await h.arm()).ok).toBe(false);

    running.resolve({ ok: true, detail: 'locked', command: 'fake', exitCode: 0, confirmed: true });
    await drain();
    expect(h.state.phase).toBe('off');
    expect(h.state.lastResult).toMatchObject({ kind: 'done', action: 'lock', confirmed: true });
  });

  it('a command that fails ends in `failed`, loudly', async () => {
    const h = new Harness();
    h.platform.executeResult = { ok: false, detail: 'Access is denied. (5)', command: 'fake', exitCode: 5, confirmed: null };
    await h.armUntilCountdown();
    await h.clock.advance(31_000);

    expect(h.state).toMatchObject({ armed: false, phase: 'off' });
    expect(h.state.lastResult).toMatchObject({ kind: 'failed', action: 'shutdown', message: 'Access is denied. (5)' });
    expect(h.lastRunFile()).toMatchObject({ lastResult: { kind: 'failed' } });
    expect(h.logText()).toContain('Error: The action failed and this PC is still on: Access is denied. (5)');
  });

  it('an execute that rejects ends in `failed`', async () => {
    const h = new Harness();
    h.platform.executeResult = new Error('spawn EPERM');
    await h.armUntilCountdown();
    await h.clock.advance(31_000);
    expect(h.state.lastResult).toMatchObject({ kind: 'failed', message: 'spawn EPERM' });
  });

  it('a shut down that has not happened after 120 s is reported as not confirmed', async () => {
    const h = new Harness();
    await h.armUntilCountdown();
    await h.clock.advance(31_000);
    expect(h.state.lastResult).toMatchObject({ kind: 'done', confirmed: null });

    await h.clock.advance(119_000);
    expect(h.state.lastResult).toMatchObject({ kind: 'done', confirmed: null });
    await h.clock.advance(2_000);
    expect(h.state.lastResult).toMatchObject({ kind: 'done', confirmed: false });
    expect(h.lastRunFile()).toMatchObject({ lastResult: { kind: 'done', confirmed: false } });
  });

  it('records when this PC woke up again after sleep', async () => {
    const h = new Harness({ config: { action: 'sleep' } });
    const asleep = deferred<ActionResult>();
    h.platform.executeResult = asleep.promise;
    await h.armUntilCountdown();
    await h.clock.advance(31_000);
    expect(h.platform.executeCalls).toEqual([{ action: 'sleep', force: true }]);

    h.clock.shiftWall(8 * 3_600_000);
    asleep.resolve({ ok: true, detail: 'resumed', command: 'fake', exitCode: null, confirmed: true });
    await drain();

    expect(h.state.lastResult).toMatchObject({ kind: 'done', action: 'sleep', resumedAtMs: h.clock.now(), confirmed: true });
    expect(h.state).toMatchObject({ armed: false, phase: 'off' });
  });

  it('a lock nobody saw happen is recorded as NOT confirmed, with a warning instead of "Done"', async () => {
    const h = new Harness({ config: { action: 'lock' } });
    const detail = "The lock command was sent, but Windows didn't confirm that this PC locked.";
    h.platform.executeResult = { ok: true, detail, command: 'fake', exitCode: 0, confirmed: false };
    await h.armUntilCountdown();
    await h.clock.advance(31_000);

    expect(h.state).toMatchObject({ armed: false, phase: 'off' });
    expect(h.state.lastResult).toMatchObject({ kind: 'done', action: 'lock', confirmed: false, resumedAtMs: null });
    expect(h.lastRunFile()).toMatchObject({ lastResult: { kind: 'done', action: 'lock', confirmed: false } });
    expect(h.logText()).toContain(`Warning: The command to lock was sent, but it could not be confirmed that it happened: ${detail}`);
    expect(h.logLines('Done:')).toHaveLength(0);
  });

  it('a sleep that was still running at the timeout without a resume gap is NOT confirmed', async () => {
    const h = new Harness({ config: { action: 'sleep' } });
    h.platform.executeResult = { ok: true, detail: 'still running after 25 seconds', command: 'fake', exitCode: null, confirmed: false };
    await h.armUntilCountdown();
    await h.clock.advance(31_000);
    expect(h.state.lastResult).toMatchObject({ kind: 'done', action: 'sleep', confirmed: false, resumedAtMs: null });
  });

  it('keeps a confirmation the OS gave, and takes nothing else for one', async () => {
    const confirmed = new Harness({ config: { action: 'lock' } });
    confirmed.platform.executeResult = { ok: true, detail: 'This PC is locked.', command: 'fake', exitCode: 0, confirmed: true };
    await confirmed.armUntilCountdown();
    await confirmed.clock.advance(31_000);
    expect(confirmed.state.lastResult).toMatchObject({ kind: 'done', action: 'lock', confirmed: true });
    expect(confirmed.logText()).toContain('Done: This PC is locked.');

    // A malformed answer, or a "confirmation" that comes with a failure, is no confirmation.
    const odd = new Harness({ config: { action: 'lock' } });
    odd.platform.executeResult = { ok: true, detail: 'sent', command: 'fake', exitCode: 0, confirmed: 'yes' } as unknown as ActionResult;
    await odd.armUntilCountdown();
    await odd.clock.advance(31_000);
    expect(odd.state.lastResult).toMatchObject({ kind: 'done', confirmed: null });
  });

  it('after an action that leaves this PC on (lock), it is not watching and never acts twice', async () => {
    const h = new Harness({ config: { action: 'lock' }, viewers: true });
    h.controller.peersChanged();
    await h.armUntilCountdown();
    await h.clock.advance(31_000);
    expect(h.platform.executeCalls).toEqual([{ action: 'lock', force: true }]);

    const scansBefore = h.scanner.requests.length;
    await h.clock.advance(600_000);
    expect(h.scanner.requests.length).toBeGreaterThan(scansBefore); // still scanning for the dashboard
    expect(h.state).toMatchObject({ armed: false, phase: 'off', countdown: null });
    expect(h.platform.executeCalls).toHaveLength(1);
  });
});

describe('notify', () => {
  it('has no countdown: straight to the final gate, then the notification', async () => {
    const h = new Harness({ config: { action: 'notify' } });
    await h.arm();
    await h.clock.advance(20_000);

    expect(h.state).toMatchObject({ armed: true, phase: 'committing', countdown: null });
    expect(h.platform.alerts).toHaveLength(0);
    expect(h.platform.executeCalls).toHaveLength(0);
    expect(h.scanner.requests.at(-1)?.forceWide).toBe(true);

    await h.clock.advance(250);
    expect(h.platform.executeCalls).toEqual([{ action: 'notify', force: true }]);
    expect(h.state).toMatchObject({ armed: false, phase: 'off' });
    expect(h.state.lastResult).toMatchObject({ kind: 'done', action: 'notify' });
    expect(h.published.every((entry) => entry.state.countdown === null)).toBe(true);
  });

  it('can still be cancelled during its final gate', async () => {
    const h = new Harness({ config: { action: 'notify' } });
    await h.arm();
    await h.clock.advance(20_000);
    await h.send({ name: 'cancel', via: 'statusBar' });
    await h.clock.advance(5_000);

    expect(h.platform.executeCalls).toHaveLength(0);
    expect(h.state.armed).toBe(false);
    expect(cancelled(h)).toMatchObject({ reason: { id: 'user', via: 'statusBar' }, countdownKind: 'real' });
  });

  it('as a test run ends in testPassed without execute', async () => {
    const h = new Harness({ config: { action: 'notify', testMode: true } });
    await h.arm();
    await h.clock.advance(21_000);
    expect(h.platform.executeCalls).toHaveLength(0);
    expect(h.state.lastResult).toMatchObject({ kind: 'testPassed', action: 'notify' });
  });
});

describe('capability while watching', () => {
  it('is asked again after 5 minutes, and a "no" then blocks', async () => {
    const h = new Harness();
    h.scanner.script = () => busyScan();
    await h.arm();
    expect(h.platform.capabilityCalls).toEqual(['shutdown']);

    await h.clock.advance(4 * 60_000);
    expect(h.platform.capabilityCalls).toEqual(['shutdown']);

    h.platform.capabilityOf.shutdown = { ok: false, detail: 'A policy now forbids shutting down.' };
    await h.clock.advance(2 * 60_000);
    expect(h.platform.capabilityCalls).toEqual(['shutdown', 'shutdown']);
    expect(h.state.platform.capability).toEqual({ ok: false, detail: 'A policy now forbids shutting down.' });

    h.scanner.script = () => clearScan();
    await h.clock.advance(120_000);
    expect(h.state).toMatchObject({ armed: true, phase: 'watching', countdown: null });
    expect(h.platform.executeCalls).toHaveLength(0);
  });
});
