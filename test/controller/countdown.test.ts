import * as fs from 'node:fs';
import * as path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import type { ScanResult } from '../../src/core/types';
import type { LastResult } from '../../src/shared/protocol';
import { FakeClock, Harness, busyScan, clearScan, makeScan, removeTempDirs } from './harness';

afterEach(removeTempDirs);

function cancelled(h: Harness): Extract<LastResult, { kind: 'cancelled' }> {
  const result = h.state.lastResult;
  if (result?.kind !== 'cancelled') throw new Error(`expected a cancelled result, got ${JSON.stringify(result)}`);
  return result;
}

describe('countdown', () => {
  it('ticks, publishes at least every 500 ms, and remainingMs keeps a 1 s guard band', async () => {
    const h = new Harness();
    await h.armUntilCountdown();
    const startedMono = h.clock.mono();
    const id = h.state.countdown?.id;
    expect(h.state.countdown).toMatchObject({ kind: 'real', action: 'shutdown', totalMs: 30_000, remainingMs: 29_000 });

    h.published.length = 0;
    await h.clock.advance(29_750);

    const during = h.published.filter((entry) => entry.state.countdown?.id === id);
    expect(during.length).toBeGreaterThanOrEqual(59);
    let previousMono = startedMono;
    let previousRemaining = 29_000;
    for (const { state, mono } of during) {
      const remaining = state.countdown?.remainingMs ?? NaN;
      expect(mono - previousMono).toBeLessThanOrEqual(500);
      expect(remaining).toBeLessThanOrEqual(previousRemaining); // never increases
      expect(remaining).toBe(Math.max(0, 30_000 - (mono - startedMono) - 1000)); // guard band
      previousMono = mono;
      previousRemaining = remaining;
    }
    expect(h.state.countdown?.remainingMs).toBe(0);
    expect(h.state.phase).toBe('countdown');
    expect(h.platform.executeCalls).toHaveLength(0);
  });

  it('publishes whole milliseconds, rounded down, when the monotonic clock is fractional', async () => {
    const h = new Harness();
    h.clock.skip(0.3775); // performance.now() is not an integer
    await h.armUntilCountdown();
    await h.clock.advance(333.3);

    const remaining = h.state.countdown?.remainingMs ?? NaN;
    expect(Number.isInteger(remaining)).toBe(true);
    expect(remaining).toBe(28_666); // floor(30 000 - 333.3 - 1000)
    expect(Number.isInteger(h.state.confirm.nextCheckInMs)).toBe(true);
    expect(Number.isInteger(h.state.scan.lastCompletedAgoMs)).toBe(true);
  });

  it('polls every 2 s during the countdown', async () => {
    const h = new Harness();
    await h.armUntilCountdown();
    const before = h.scanner.requests.length;
    await h.clock.advance(10_000);
    expect(h.scanner.requests.length - before).toBe(5);
  });

  it('a user Cancel stops watching, and the action never runs', async () => {
    const h = new Harness();
    await h.armUntilCountdown();
    await h.clock.advance(5_000);

    expect(await h.send({ name: 'cancel', via: 'button' })).toEqual({ ok: true });
    expect(h.state).toMatchObject({ armed: false, phase: 'off', countdown: null });
    expect(cancelled(h)).toMatchObject({
      reason: { id: 'user', via: 'button' },
      stillWatching: false,
      countdownKind: 'real',
    });
    expect(h.watchingFileExists()).toBe(false);

    await h.clock.advance(300_000);
    expect(h.platform.executeCalls).toHaveLength(0);
    expect(h.state.armed).toBe(false);
  });

  it('a Cancel with an unknown origin still cancels', async () => {
    const h = new Harness();
    await h.armUntilCountdown();
    await h.send({ name: 'cancel', via: 'telepathy' } as never);
    expect(h.state.armed).toBe(false);
    expect(cancelled(h).reason).toEqual({ id: 'user', via: 'command' });
  });

  it('a Cancel while not watching is a no-op', async () => {
    const h = new Harness();
    expect(await h.send({ name: 'cancel', via: 'esc' })).toEqual({ ok: true });
    expect(h.state).toMatchObject({ armed: false, phase: 'off', lastResult: null });
    expect(h.logLines('Cancel pressed')).toHaveLength(0);
  });

  it('a Cancel while watching, with no countdown running, stops watching', async () => {
    const h = new Harness();
    h.scanner.script = () => busyScan();
    await h.arm();
    expect(await h.send({ name: 'cancel', via: 'esc' })).toEqual({ ok: true });

    expect(h.state).toMatchObject({ armed: false, phase: 'off', countdown: null, lastResult: null });
    expect(h.watchingFileExists()).toBe(false);
    expect(h.logText()).toContain('Cancel pressed while watching: watching stopped');
  });

  it('a Cancel that arrives right after an automatic cancel (Emergency stop) still stops watching', async () => {
    const h = new Harness();
    await h.armUntilCountdown();
    // A follower whose Cancel went unanswered sets Emergency stop; the leader's tick sees it first.
    h.createStopFile();
    await h.clock.advance(250);
    expect(cancelled(h)).toMatchObject({ reason: { id: 'emergencyStop' }, stillWatching: true });

    expect(await h.send({ name: 'cancel', via: 'button' })).toEqual({ ok: true });
    expect(h.state).toMatchObject({ armed: false, phase: 'off', countdown: null });
    expect(cancelled(h)).toMatchObject({ reason: { id: 'user', via: 'button' }, stillWatching: false, countdownKind: 'real' });
    expect(h.watchingFileExists()).toBe(false);

    // On that "ok" the follower removes its Emergency stop: nothing may happen afterwards.
    fs.rmSync(path.join(h.stateDir.dir, 'STOP'));
    await h.clock.advance(900_000);
    expect(h.platform.executeCalls).toHaveLength(0);
    expect(h.state.armed).toBe(false);
  });

  it('a Cancel clicked just after moving the mouse (userCameBack) still stops watching', async () => {
    const h = new Harness({ config: { testMode: true } });
    await h.armUntilCountdown();
    await h.clock.advance(5_000);
    h.platform.idle = 0;
    await h.clock.advance(1_250);
    expect(cancelled(h)).toMatchObject({ reason: { id: 'userCameBack' }, stillWatching: true });

    await h.send({ name: 'cancel', via: 'notification' });
    expect(h.state).toMatchObject({ armed: false, phase: 'off' });
    expect(cancelled(h)).toMatchObject({ reason: { id: 'user', via: 'notification' }, stillWatching: false, countdownKind: 'test' });
  });

  it('a session going back to work cancels, keeps watching, and holds a 60 s cooldown', async () => {
    const h = new Harness();
    await h.armUntilCountdown();
    h.scanner.script = () => busyScan('api-server');
    await h.clock.advance(2_000);

    expect(h.state).toMatchObject({ armed: true, phase: 'watching', countdown: null, confirm: { k: 0 } });
    expect(cancelled(h)).toMatchObject({
      reason: { id: 'sessionResumed', name: 'api-server' },
      stillWatching: true,
      countdownKind: 'real',
    });
    expect(h.state.cooldownRemainingMs).toBe(60_000);
    expect(h.watchingFileExists()).toBe(true);
    const cancelledAt = h.clock.mono();

    // Everything is clear again at once, and stays clear: three polls in a row come quickly, but
    // no countdown may start before the cooldown is over.
    h.scanner.script = () => clearScan();
    await h.advanceUntil((state) => state.confirm.k === 3, 60_000, 1_000);
    expect(h.clock.mono() - cancelledAt).toBeLessThan(40_000);
    await h.advanceUntil(() => h.clock.mono() - cancelledAt >= 59_000, 60_000, 1_000);
    expect(h.state).toMatchObject({ phase: 'confirming', countdown: null });
    expect(h.state.cooldownRemainingMs).toBeGreaterThan(0);

    await h.advanceUntil((state) => state.phase === 'countdown', 20_000, 1_000);
    expect(h.clock.mono() - cancelledAt).toBeGreaterThanOrEqual(60_000);
    expect(h.state.cooldownRemainingMs).toBeNull();
    expect(h.platform.executeCalls).toHaveLength(0);
  });

  it('a failing check cancels with its id and keeps watching', async () => {
    const h = new Harness();
    await h.armUntilCountdown();
    h.scanner.script = () => makeScan({ errors: ["Couldn't read C:\\fixture\\.claude\\sessions\\9.json"] });
    await h.clock.advance(2_000);

    expect(h.state).toMatchObject({ armed: true, phase: 'watching', countdown: null });
    expect(cancelled(h)).toMatchObject({ reason: { id: 'checkFailed', check: 'scanner' }, stillWatching: true });
  });

  it('the user coming back (scan idle time) cancels with userCameBack', async () => {
    const h = new Harness({ config: { requireUserIdle: true } });
    await h.armUntilCountdown();
    h.scanner.script = () => makeScan({ idleSeconds: 1 });
    await h.clock.advance(2_000);
    expect(cancelled(h)).toMatchObject({ reason: { id: 'userCameBack' }, stillWatching: true });
  });

  it('Emergency stop cancels within one tick and keeps watching', async () => {
    const h = new Harness();
    await h.armUntilCountdown();
    await h.clock.advance(1_000);
    h.createStopFile();
    await h.clock.advance(250);

    expect(h.state).toMatchObject({ armed: true, phase: 'watching', countdown: null, stop: { present: true } });
    expect(cancelled(h)).toMatchObject({ reason: { id: 'emergencyStop' }, stillWatching: true });
    await h.clock.advance(300_000);
    expect(h.state.countdown).toBeNull();
    expect(h.platform.executeCalls).toHaveLength(0);
  });

  it('removing the STOP file lets watching carry on, from zero confirmations', async () => {
    const h = new Harness();
    await h.arm();
    h.createStopFile();
    await h.clock.advance(30_000);
    expect(h.state).toMatchObject({ armed: true, phase: 'watching', confirm: { k: 0 }, stop: { present: true } });

    fs.rmSync(path.join(h.stateDir.dir, 'STOP'));
    await h.clock.advance(1_000); // the next tick notices, without waiting for a poll
    expect(h.state.stop.present).toBe(false);
    expect(h.state).toMatchObject({ phase: 'confirming', confirm: { k: 0 } });
    await h.clock.advance(30_000);
    expect(h.state.phase).toBe('countdown');
  });

  it('a remote window that connects during the countdown cancels it', async () => {
    const h = new Harness();
    await h.armUntilCountdown();
    h.world.remoteWindows = ['Dev Container'];
    h.controller.peersChanged();

    expect(h.state).toMatchObject({ armed: true, phase: 'watching', countdown: null });
    expect(cancelled(h)).toMatchObject({ reason: { id: 'checkFailed', check: 'remoteWindows' }, stillWatching: true });
  });

  it('Stop watching during the countdown cancels it and records why', async () => {
    const h = new Harness();
    await h.armUntilCountdown();
    expect(await h.send({ name: 'disarm' })).toEqual({ ok: true });

    expect(h.state).toMatchObject({ armed: false, phase: 'off', countdown: null });
    expect(cancelled(h)).toMatchObject({ reason: { id: 'stoppedWatching' }, stillWatching: false });
    await h.clock.advance(120_000);
    expect(h.platform.executeCalls).toHaveLength(0);
  });
});

describe('idle sampling during the countdown', () => {
  it('samples about once per second and cancels when input happened after the countdown began', async () => {
    const h = new Harness();
    await h.armUntilCountdown();
    expect(h.platform.idleCalls).toBe(0);

    await h.clock.advance(5_000);
    expect(h.platform.idleCalls).toBeGreaterThanOrEqual(4);
    expect(h.platform.idleCalls).toBeLessThanOrEqual(6);
    expect(h.state.phase).toBe('countdown');

    h.platform.idle = 0; // the user touched the mouse just now
    await h.clock.advance(1_250);

    expect(h.state).toMatchObject({ armed: true, countdown: null });
    expect(h.state.phase).not.toBe('countdown');
    expect(cancelled(h)).toMatchObject({ reason: { id: 'userCameBack' }, stillWatching: true, countdownKind: 'real' });
    expect(h.state.cooldownRemainingMs).toBeGreaterThan(58_000);
    expect(h.platform.executeCalls).toHaveLength(0);
  });

  it('tolerates input from just before the countdown began', async () => {
    const h = new Harness({ config: { requireUserIdle: true } });
    await h.armUntilCountdown();
    const idleAtStart = 700;
    const startedMono = h.clock.mono();
    // Idle time keeps growing in step with the countdown: no new input.
    for (let i = 0; i < 20; i++) {
      h.platform.idle = idleAtStart + (h.clock.mono() - startedMono) / 1000;
      await h.clock.advance(250);
    }
    expect(h.state.phase).toBe('countdown');
  });

  it('unknown idle time counts as "the user is here"', async () => {
    const h = new Harness();
    await h.armUntilCountdown();
    h.platform.idle = null;
    await h.clock.advance(1_250);
    expect(cancelled(h)).toMatchObject({ reason: { id: 'userCameBack' }, stillWatching: true });
  });

  it('does not sample when the contract does not require the user to be away', async () => {
    const h = new Harness({ config: { requireUserIdle: false } });
    await h.armUntilCountdown();
    h.platform.idle = 0;
    await h.clock.advance(10_000);
    expect(h.platform.idleCalls).toBe(0);
    expect(h.state.phase).toBe('countdown');
  });
});

describe('time discontinuities', () => {
  const jumps: Record<string, (clock: FakeClock) => void> = {
    'the tick is late on both clocks (stall or sleep)': (clock) => clock.skip(40_000),
    'the wall clock jumps ahead (sleep seen by the wall clock only)': (clock) => clock.shiftWall(6_000),
    'the wall clock goes backwards': (clock) => clock.shiftWall(-2_500),
    'the two clocks disagree': (clock) => clock.shiftWall(2_500),
  };

  for (const [name, jump] of Object.entries(jumps)) {
    it(`during a countdown: ${name} -> cancelled, stopped watching, nothing executed`, async () => {
      const h = new Harness();
      await h.armUntilCountdown();
      const armedAtMs = h.state.armedAtMs;
      await h.clock.advance(5_000);

      jump(h.clock);
      await h.clock.advance(250);

      expect(h.state).toMatchObject({ armed: false, phase: 'off', countdown: null, confirm: { k: 0 } });
      expect(h.state.lastResult).toMatchObject({ kind: 'stopped', cause: 'timeJump', wasReal: true, armedAtMs });
      expect(h.watchingFileExists()).toBe(false);
      await h.clock.advance(300_000);
      expect(h.platform.executeCalls).toHaveLength(0);
      expect(h.state.armed).toBe(false);
    });

    it(`while merely watching: ${name} -> stopped watching`, async () => {
      const h = new Harness();
      h.scanner.script = () => busyScan();
      await h.arm();
      await h.clock.advance(25_000);
      expect(h.state.phase).toBe('watching');

      jump(h.clock);
      await h.clock.advance(1_000);

      expect(h.state).toMatchObject({ armed: false, phase: 'off' });
      expect(h.state.lastResult).toMatchObject({ kind: 'stopped', cause: 'timeJump', wasReal: true });
      expect(h.logText()).toContain('slept, stalled or its clock changed');
    });
  }

  it('a deadline that passed while this PC slept does not fire: lateness is checked first', async () => {
    const h = new Harness();
    await h.armUntilCountdown();
    const scansBefore = h.scanner.requests.length;
    h.clock.skip(3_600_000);
    await h.clock.advance(0);

    expect(h.state.lastResult).toMatchObject({ kind: 'stopped', cause: 'timeJump' });
    expect(h.scanner.requests.slice(scansBefore).some((request) => request.forceWide)).toBe(false);
    expect(h.platform.executeCalls).toHaveLength(0);
  });

  it('a preview that sleeps through its deadline just ends', async () => {
    const h = new Harness();
    await h.send({ name: 'preview' });
    h.clock.skip(60_000);
    await h.clock.advance(0);

    expect(h.state).toMatchObject({ armed: false, phase: 'off', countdown: null, lastResult: null });
    expect(h.platform.alerts[0]?.stopped).toBe(true);
    expect(h.platform.executeCalls).toHaveLength(0);
  });

  it('ordinary ticks, a little late, are not a discontinuity', async () => {
    const h = new Harness();
    h.scanner.script = () => busyScan();
    await h.arm();
    for (let i = 0; i < 10; i++) {
      h.clock.skip(1_500);
      h.clock.shiftWall(300);
      await h.clock.advance(1_000);
    }
    expect(h.state.armed).toBe(true);
  });
});

describe('watchdog', () => {
  const never = new Promise<ScanResult>(() => undefined);

  it('marks the scan stale while watching when scans stop completing', async () => {
    const h = new Harness();
    await h.arm();
    h.scanner.script = () => never;
    await h.clock.advance(10_000); // the next scan starts and hangs
    expect(h.state.scan.stale).toBe(false);

    await h.clock.advance(35_000);
    expect(h.state.scan.stale).toBe(true);
    expect(h.state).toMatchObject({ armed: true, phase: 'watching', confirm: { k: 0 } });
    expect(h.state.checks.find((check) => check.id === 'scanner')?.state).toBe('cantTell');
    expect(h.logLines('The checks stopped answering')).toHaveLength(1);
  });

  it('cancels a running countdown when scans stop completing', async () => {
    const h = new Harness({ config: { countdownSeconds: 120 } });
    await h.armUntilCountdown();
    h.scanner.script = () => never;
    await h.clock.advance(40_000);

    expect(h.state.scan.stale).toBe(true);
    expect(h.state).toMatchObject({ armed: true, phase: 'watching', countdown: null });
    expect(cancelled(h)).toMatchObject({ reason: { id: 'scanStale' }, stillWatching: true });
    await h.clock.advance(300_000);
    expect(h.platform.executeCalls).toHaveLength(0);
  });

  it('publishes at least every 10 s while the engine is active', async () => {
    const h = new Harness({ config: { pollSeconds: 60 } });
    h.scanner.script = () => busyScan();
    await h.arm();
    h.published.length = 0;
    const from = h.clock.mono();
    await h.clock.advance(180_000);

    let previous = from;
    for (const { mono } of h.published) {
      expect(mono - previous).toBeLessThanOrEqual(10_000);
      previous = mono;
    }
    expect(h.clock.mono() - previous).toBeLessThanOrEqual(10_000);
  });
});

describe('OS countdown alert', () => {
  it('starts with the countdown and stops when the countdown is cancelled', async () => {
    const h = new Harness();
    await h.arm();
    expect(h.platform.alerts).toHaveLength(0);
    await h.clock.advance(20_000);

    expect(h.platform.alerts).toHaveLength(1);
    const alert = h.platform.alerts[0];
    // The seconds left at the call, minus the 1 s guard band: like every other surface, never more.
    expect(alert?.options).toMatchObject({ seconds: 29, kind: 'real', sound: true });
    expect(alert?.options.title).toBe('Shutting down this PC in');
    expect(alert?.stopped).toBe(false);

    h.scanner.script = () => busyScan();
    await h.clock.advance(2_000);
    expect(h.state.countdown).toBeNull();
    expect(alert?.stopped).toBe(true);
  });

  it('its Cancel button works like the cancel command', async () => {
    const h = new Harness();
    await h.armUntilCountdown();
    h.platform.alerts[0]?.press();

    expect(h.state).toMatchObject({ armed: false, phase: 'off', countdown: null });
    expect(cancelled(h)).toMatchObject({ reason: { id: 'user', via: 'osAlert' }, stillWatching: false });
    expect(h.platform.alerts[0]?.stopped).toBe(true);
    await h.clock.advance(120_000);
    expect(h.platform.executeCalls).toHaveLength(0);
  });

  it('a press on an alert whose countdown was already cancelled automatically still stops watching', async () => {
    const h = new Harness();
    await h.armUntilCountdown();
    const first = h.platform.alerts[0];
    h.scanner.script = () => busyScan();
    await h.clock.advance(2_000);
    expect(cancelled(h)).toMatchObject({ reason: { id: 'sessionResumed' }, stillWatching: true });

    first?.press();
    expect(h.state).toMatchObject({ armed: false, phase: 'off', countdown: null });
    expect(cancelled(h)).toMatchObject({ reason: { id: 'user', via: 'osAlert' }, stillWatching: false });
  });

  it('an alert left over from an earlier countdown, pressed during a later one, stops watching', async () => {
    const h = new Harness();
    await h.armUntilCountdown();
    const first = h.platform.alerts[0];
    h.scanner.script = () => busyScan();
    await h.clock.advance(2_000);
    h.scanner.script = () => clearScan();
    await h.advanceUntil((state) => state.phase === 'countdown', 120_000, 1_000);

    first?.press();
    expect(h.state).toMatchObject({ armed: false, phase: 'off', countdown: null });
    expect(h.platform.alerts[1]?.stopped).toBe(true);
    await h.clock.advance(120_000);
    expect(h.platform.executeCalls).toHaveLength(0);
  });

  it('a leftover alert pressed while not watching changes nothing (not even a preview)', async () => {
    const h = new Harness();
    await h.armUntilCountdown();
    const first = h.platform.alerts[0];
    await h.send({ name: 'disarm' });
    await h.send({ name: 'preview' });

    first?.press();
    expect(h.state).toMatchObject({ armed: false, phase: 'countdown' });
    expect(h.state.countdown?.kind).toBe('preview');
  });

  it('is not shown when the setting is off, and uses injected wording when given', async () => {
    const off = new Harness({ config: { countdownAlert: false } });
    await off.armUntilCountdown();
    expect(off.platform.alerts).toHaveLength(0);

    const worded = new Harness({
      config: { countdownSound: false },
      deps: { alertText: (state) => ({ title: `T ${state.countdown?.kind}`, body: 'B', cancelLabel: 'C' }) },
    });
    await worded.armUntilCountdown();
    expect(worded.platform.alerts[0]?.options).toMatchObject({ title: 'T real', body: 'B', cancelLabel: 'C', sound: false });
  });
});
