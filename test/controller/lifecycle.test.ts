import * as fs from 'node:fs';

import { afterEach, describe, expect, it } from 'vitest';

import type { ScanResult } from '../../src/core/types';
import { POWER_ACTIONS, toArmContract } from '../../src/shared/config';
import type { HandoverPayload, LastResult } from '../../src/shared/protocol';
import {
  Harness,
  LEADER,
  TEST_CONFIG,
  busyScan,
  clearScan,
  deferred,
  drain,
  makeScan,
  makeSession,
  makeTempDir,
  removeTempDirs,
} from './harness';

afterEach(removeTempDirs);

const DAY_MS = 24 * 60 * 60 * 1000;

function writeLastRun(h: Harness, record: { testPassedOnce?: boolean; lastResult: LastResult | null; dismissed?: boolean }): void {
  h.stateDir.writeJson(h.stateDir.lastRunFile, { testPassedOnce: false, dismissed: false, ...record });
}

describe('engine activity', () => {
  it('does nothing at all while not watching and not viewed', async () => {
    const h = new Harness();
    await h.clock.advance(600_000);

    expect(h.scanner.requests).toHaveLength(0);
    expect(h.platform.capabilityCalls).toHaveLength(0);
    expect(h.clock.pending).toBe(0);
    expect(h.state.scan).toMatchObject({ engineActive: false, lastCompletedAgoMs: null, stale: false });
  });

  it("scans at the leader's poll interval while a dashboard is visible, and stops when it closes", async () => {
    const h = new Harness({ config: { pollSeconds: 20 } });
    h.world.viewers = true;
    h.controller.peersChanged();
    await drain();
    expect(h.scanner.requests).toHaveLength(1);
    expect(h.state.scan.engineActive).toBe(true);
    expect(h.state.confirm.nextCheckInMs).toBe(20_000);

    await h.clock.advance(60_000);
    expect(h.scanner.requests).toHaveLength(4);
    expect(h.state).toMatchObject({ armed: false, phase: 'off', countdown: null });

    h.world.viewers = false;
    h.controller.peersChanged();
    await h.clock.advance(600_000);
    expect(h.scanner.requests).toHaveLength(4);
    expect(h.clock.pending).toBe(0);
  });

  it('while only viewed, checks what this PC can do for every action', async () => {
    const h = new Harness({ viewers: true });
    h.platform.capabilityOf.hibernate = { ok: false, detail: 'Hibernation is turned off on this PC.' };
    h.controller.peersChanged();
    await drain();

    expect([...h.platform.capabilityCalls].sort()).toEqual([...POWER_ACTIONS].sort());
    expect(h.state.platform.capability).toEqual({ ok: true, detail: 'Allowed' });
    expect(h.state.platform.capabilities.hibernate).toEqual({ ok: false, detail: 'Hibernation is turned off on this PC.' });
    expect(Object.keys(h.state.platform.capabilities).sort()).toEqual([...POWER_ACTIONS].sort());

    await h.clock.advance(120_000);
    expect(h.platform.capabilityCalls).toHaveLength(POWER_ACTIONS.length); // cached for 5 minutes
  });

  it('a scan from before a long pause is not shown as current when the engine starts again', async () => {
    const h = new Harness({ viewers: true });
    h.controller.peersChanged();
    await drain();
    expect(h.state.sessions).toHaveLength(1);

    h.world.viewers = false;
    h.controller.peersChanged();
    await h.clock.advance(3_600_000);

    h.scanner.script = () => new Promise(() => undefined);
    h.world.viewers = true;
    h.controller.peersChanged();
    await drain();
    expect(h.state.sessions).toHaveLength(0);
    expect(h.state.scan.lastCompletedAgoMs).toBeNull();
  });

  it('keeps scanning while watching without any viewer', async () => {
    const h = new Harness();
    h.scanner.script = () => busyScan();
    await h.arm();
    await h.clock.advance(60_000);
    expect(h.scanner.requests).toHaveLength(7);
    expect(h.state.scan.engineActive).toBe(true);
  });

  it('reports the platform, the stop folder and the log file', async () => {
    const h = new Harness();
    h.platform.helper = { tier: 'limited', problem: 'Idle time is not available.' };
    expect(h.state.platform).toMatchObject({
      id: 'windows',
      osName: 'Windows',
      experimental: false,
      helperTier: 'limited',
      problem: 'Idle time is not available.',
      keepAwake: 'off',
    });
    expect(h.state.stop).toEqual({ present: false, dir: h.stateDir.dir, auto: false });
    expect(h.state.logFile).toBe(h.stateDir.logFile);
    expect(h.state).toMatchObject({ v: 1, hostname: 'test-pc', leader: LEADER, sessionsOmitted: 0 });
  });

  it('seq increases with every publish and listeners can unsubscribe', async () => {
    const h = new Harness();
    const seen: number[] = [];
    const subscription = h.controller.onState((state) => seen.push(state.seq));
    await h.arm();
    await h.clock.advance(10_000);
    expect(seen.length).toBeGreaterThan(2);
    for (let i = 1; i < seen.length; i++) expect(seen[i]).toBeGreaterThan(seen[i - 1] ?? Infinity);

    subscription.dispose();
    const count = seen.length;
    await h.clock.advance(30_000);
    expect(seen).toHaveLength(count);
  });
});

describe('keep-awake', () => {
  it('is held exactly while watching', async () => {
    const h = new Harness();
    h.scanner.script = () => busyScan();
    expect(h.platform.keepAwakeCalls).toEqual([]);
    expect(h.state.platform.keepAwake).toBe('off');

    await h.arm();
    expect(h.platform.keepAwakeCalls).toEqual([true]);
    expect(h.state.platform.keepAwake).toBe('held');

    await h.clock.advance(120_000);
    expect(h.platform.keepAwakeCalls).toEqual([true]);

    await h.send({ name: 'disarm' });
    expect(h.platform.keepAwakeCalls).toEqual([true, false]);
    expect(h.state.platform.keepAwake).toBe('off');
  });

  it('is released when watching stops by itself (time jump)', async () => {
    const h = new Harness();
    await h.arm();
    h.clock.shiftWall(3_600_000);
    await h.clock.advance(1_000);
    expect(h.state.armed).toBe(false);
    expect(h.platform.keepAwakeCalls).toEqual([true, false]);
  });

  it('is not requested when the setting is off, and says so when the OS refuses', async () => {
    const off = new Harness({ config: { keepAwake: false } });
    await off.arm();
    expect(off.platform.keepAwakeCalls).toEqual([]);
    expect(off.state.platform.keepAwake).toBe('off');

    const refused = new Harness();
    refused.platform.keepAwakeOk = false;
    await refused.arm();
    expect(refused.state.platform.keepAwake).toBe('unavailable');
    expect(refused.state.armed).toBe(true);
  });
});

describe('handover', () => {
  it('returns null when not watching, and stops taking commands', async () => {
    const h = new Harness();
    expect(h.controller.beginHandover()).toBeNull();
    expect((await h.send({ name: 'refresh' })).ok).toBe(false);
    expect(h.scanner.requests).toHaveLength(0);
  });

  it('exports the armed state, cancels the countdown and refuses every later command', async () => {
    const h = new Harness();
    h.scanner.script = () => makeScan({ sessions: [makeSession()] });
    await h.send({ name: 'ignore', key: 'proc:1:2', on: true });
    await h.armUntilCountdown();
    const armedAtMs = h.state.armedAtMs;
    await h.clock.advance(4_000);

    const payload = h.controller.beginHandover();

    expect(payload).toEqual({
      contract: toArmContract(TEST_CONFIG),
      contractRealm: LEADER.realm,
      armedAtMs,
      sawAnySession: true,
      sinceLastSessionMs: 0,
      cooldownRemainingMs: 60_000,
      ignores: ['proc:1:2'],
    });
    expect(h.state).toMatchObject({ armed: true, countdown: null });
    expect(h.state.lastResult).toMatchObject({ kind: 'cancelled', reason: { id: 'leaderChanged' } });
    expect(h.platform.alerts[0]?.stopped).toBe(true);

    // Even the "always accepted" ones: answering ok after the state went on offer would be a lie.
    for (const command of [{ name: 'disarm' }, { name: 'cancel', via: 'esc' }, { name: 'refresh' }] as const) {
      expect((await h.send(command)).ok).toBe(false);
    }
    expect(h.state.armed).toBe(true);

    await h.clock.advance(300_000);
    expect(h.state.countdown).toBeNull();
    expect(h.platform.executeCalls).toHaveLength(0);
  });

  it('imports: watching with the same contract, confirmations from 0, no countdown, cooldown kept', async () => {
    const first = new Harness();
    await first.armUntilCountdown();
    const payload = first.controller.beginHandover();
    first.controller.dispose({ handedOver: true });
    expect(first.watchingFileExists()).toBe(true); // the successor owns it now

    const next = new Harness({
      dir: first.stateDir.dir,
      config: { quietSeconds: 999, testMode: true }, // the new leader's own settings must not leak in
      start: false,
    });
    const firstScan = deferred<ScanResult>();
    next.scanner.script = (_request, index) => (index === 0 ? firstScan.promise : clearScan());
    next.controller.start({ handover: payload, previousLeaderWasWatching: true, freshStart: false });
    await drain();

    expect(next.state).toMatchObject({ armed: true, armedBy: 'handover', phase: 'watching', countdown: null });
    expect(next.state.confirm).toMatchObject({ k: 0, n: 3 }); // not the three of the old leader
    expect(next.state.contractRealm).toBe(LEADER.realm);
    expect(next.state.armedAtMs).toBe(payload?.armedAtMs);
    expect(next.state.contract).toEqual(payload?.contract);

    firstScan.resolve(clearScan());
    await drain();
    expect(next.state).toMatchObject({ phase: 'confirming', confirm: { k: 1 }, countdown: null });
    expect(next.state.lastResult?.kind).not.toBe('stopped');
    expect(next.logText()).toContain('Took over watching from a window that closed.');
    expect(next.platform.keepAwakeCalls).toEqual([true]);
    expect(next.stateDir.readJson(next.stateDir.watchRecordFile)).toMatchObject({ real: true, pid: LEADER.pid });

    await next.clock.advance(55_000);
    expect(next.state).toMatchObject({ phase: 'confirming', confirm: { k: 3 }, countdown: null }); // cooldown
    await next.clock.advance(15_000);
    expect(next.state.phase).toBe('countdown');
    expect(next.state.countdown?.kind).toBe('real');
  });

  it('a Cancel re-sent to the window that took over stops watching there', async () => {
    const first = new Harness();
    await first.armUntilCountdown();
    const payload = first.controller.beginHandover(); // the countdown ends without the user
    expect((await first.send({ name: 'cancel', via: 'esc' })).ok).toBe(false); // stays pending
    first.controller.dispose({ handedOver: true });

    const next = new Harness({ dir: first.stateDir.dir, start: { handover: payload, previousLeaderWasWatching: true } });
    await drain();
    expect(next.state).toMatchObject({ armed: true, countdown: null });
    expect(await next.send({ name: 'cancel', via: 'esc' })).toEqual({ ok: true });

    expect(next.state).toMatchObject({ armed: false, phase: 'off' });
    expect(next.state.lastResult).toMatchObject({
      kind: 'cancelled',
      reason: { id: 'user', via: 'esc' },
      stillWatching: false,
      countdownKind: 'real',
    });
    expect(next.watchingFileExists()).toBe(false);
    await next.clock.advance(600_000);
    expect(next.platform.executeCalls).toHaveLength(0);
  });

  it('a payload that does not validate is not adopted, and the next start says watching stopped', async () => {
    const broken = { contract: { action: 'shutdown' }, contractRealm: LEADER.realm, armedAtMs: 1 } as unknown as HandoverPayload;
    const h = new Harness({ start: { handover: broken } });

    expect(h.state.armed).toBe(false);
    expect(h.state.lastResult).toMatchObject({ kind: 'stopped', cause: 'windowClosed' });
    expect(h.scanner.requests).toHaveLength(0);
  });

  it('carries "time since the last session" so the no-sessions rule keeps working', async () => {
    const payload: HandoverPayload = {
      contract: toArmContract(TEST_CONFIG),
      contractRealm: LEADER.realm,
      armedAtMs: 1_768_000_000_000,
      sawAnySession: true,
      sinceLastSessionMs: 120_000,
      cooldownRemainingMs: 0,
      ignores: ['session:0:1:abc:1:1:0', 'nonsense', 'remote:WSL: Ubuntu'],
    };
    let seen: { sawAnySession: boolean; secondsSinceLastSession: number | null } | null = null;
    const h = new Harness({
      start: { handover: payload },
      deps: {
        evaluate: (input) => {
          seen = { sawAnySession: input.sawAnySession, secondsSinceLastSession: input.secondsSinceLastSession };
          return { checks: [], allClear: false, ok: false, stablePolls: 0, requiredPolls: 3 };
        },
      },
    });
    h.scanner.script = () => makeScan({ sessions: [] });
    await h.clock.advance(10_000);

    expect(seen).toEqual({ sawAnySession: true, secondsSinceLastSession: 130 });
    expect([...(h.scanner.requests[0]?.ignores ?? [])]).toEqual(['session:0:1:abc:1:1:0', 'remote:WSL: Ubuntu']);
  });

  it('keeps the ignore of a remote window while that window reconnects to the new leader', async () => {
    const payload: HandoverPayload = {
      contract: toArmContract(TEST_CONFIG),
      contractRealm: LEADER.realm,
      armedAtMs: 1_768_000_000_000,
      sawAnySession: true,
      sinceLastSessionMs: 0,
      cooldownRemainingMs: 0,
      ignores: ['remote:WSL: Ubuntu', 'remote:SSH: gone'],
    };
    const h = new Harness({ start: { handover: payload } });
    await h.clock.advance(2_000); // first scans done, the remote window is not back yet

    h.world.remoteWindows = ['WSL: Ubuntu'];
    h.controller.peersChanged();
    expect(h.state.remoteWindows[0]).toMatchObject({ name: 'WSL: Ubuntu', ignored: true });

    await h.clock.advance(30_000);
    expect(h.state.remoteWindows[0]?.ignored).toBe(true);
    // The window that never came back loses its ignore: a later window of that name blocks again.
    expect(h.scanner.requests.at(-1)?.ignores.has('remote:SSH: gone')).toBe(false);
  });
});

describe('start: records from the previous run', () => {
  it('a leftover watching.json means the editor restarted while watching', async () => {
    const dir = makeTempDir();
    const before = new Harness({ dir });
    await before.arm();
    const armedAtMs = before.state.armedAtMs;
    // The window dies without dispose(): watching.json stays behind.

    const h = new Harness({ dir });
    expect(h.state.armed).toBe(false);
    expect(h.state.lastResult).toMatchObject({ kind: 'stopped', cause: 'editorRestarted', armedAtMs, wasReal: true });
    expect(h.watchingFileExists()).toBe(false);
    expect(h.lastRunFile()).toMatchObject({ dismissed: false, lastResult: { kind: 'stopped', cause: 'editorRestarted' } });
    expect(h.logText()).toContain('The editor closed or restarted while watching');
  });

  it('... or, when this window saw the previous leader watching, that its window closed', async () => {
    const dir = makeTempDir();
    const before = new Harness({ dir, config: { testMode: true } });
    await before.arm();

    const h = new Harness({ dir, start: { previousLeaderWasWatching: true } });
    expect(h.state.lastResult).toMatchObject({ kind: 'stopped', cause: 'windowClosed', wasReal: false });
  });

  it('a previous leader that was watching and left no trace at all is still reported', async () => {
    const h = new Harness({ start: { previousLeaderWasWatching: true } });
    expect(h.state.armed).toBe(false);
    expect(h.state.lastResult).toMatchObject({ kind: 'stopped', cause: 'windowClosed', armedAtMs: null });
    expect(h.logText()).toContain('The window that was watching closed');
  });

  it('... but the record the closing window wrote itself is kept, not replaced', async () => {
    const before = new Harness();
    await before.arm();
    const armedAtMs = before.state.armedAtMs;
    before.controller.dispose({ handedOver: false });

    const h = new Harness({ dir: before.stateDir.dir, start: { previousLeaderWasWatching: true } });
    expect(h.state.lastResult).toMatchObject({ kind: 'stopped', cause: 'windowClosed', armedAtMs, wasReal: true });
    expect(h.logLines('The window that was watching closed')).toHaveLength(0);
  });

  it('an unreadable watching.json still counts', async () => {
    const dir = makeTempDir();
    const seed = new Harness({ dir, start: false });
    fs.writeFileSync(seed.stateDir.watchRecordFile, '{ not json');

    const h = new Harness({ dir });
    expect(h.state.lastResult).toMatchObject({ kind: 'stopped', cause: 'editorRestarted', armedAtMs: null, wasReal: false });
  });

  it('shows an undismissed result younger than 7 days', async () => {
    const seed = new Harness({ start: false });
    const result: LastResult = { kind: 'done', atMs: seed.clock.now() - 6 * DAY_MS, action: 'sleep', resumedAtMs: null, confirmed: null };
    writeLastRun(seed, { lastResult: result, testPassedOnce: true });

    const h = new Harness({ dir: seed.stateDir.dir });
    expect(h.state.lastResult).toEqual(result);
    expect(h.state.testPassedOnce).toBe(true);
  });

  it('hides a dismissed result, an old one, and a broken one', async () => {
    const dismissed = new Harness({ start: false });
    const recent: LastResult = { kind: 'failed', atMs: dismissed.clock.now() - 1000, action: 'shutdown', message: 'no' };
    writeLastRun(dismissed, { lastResult: recent, dismissed: true });
    expect(new Harness({ dir: dismissed.stateDir.dir }).state.lastResult).toBeNull();

    const old = new Harness({ start: false });
    writeLastRun(old, { lastResult: { ...recent, atMs: old.clock.now() - 8 * DAY_MS } });
    expect(new Harness({ dir: old.stateDir.dir }).state.lastResult).toBeNull();

    const broken = new Harness({ start: false });
    broken.stateDir.writeJson(broken.stateDir.lastRunFile, { testPassedOnce: 'yes', lastResult: { kind: 'done', atMs: 'now' } });
    const h = new Harness({ dir: broken.stateDir.dir });
    expect(h.state.lastResult).toBeNull();
    expect(h.state.testPassedOnce).toBe(false);
  });

  it('a "cancelled, still watching" result is not shown as still watching after a restart', async () => {
    const seed = new Harness({ start: false });
    writeLastRun(seed, {
      lastResult: { kind: 'cancelled', atMs: seed.clock.now() - 1000, reason: { id: 'userCameBack' }, stillWatching: true, countdownKind: 'real' },
    });
    const h = new Harness({ dir: seed.stateDir.dir });
    expect(h.state.lastResult).toMatchObject({ kind: 'cancelled', stillWatching: false });
  });
});

describe('watchOnStartup', () => {
  it('starts watching on a fresh start, with the leader settings', async () => {
    const h = new Harness({ config: { watchOnStartup: true, testMode: true }, start: { freshStart: true } });
    await drain();

    expect(h.state).toMatchObject({ armed: true, armedBy: 'startup', contractRealm: LEADER.realm });
    expect(h.state.contract).toEqual(toArmContract(h.world.config));
    expect(h.logText()).toContain('Started by the "watch on startup" setting');
    expect(h.scanner.requests.length).toBeGreaterThan(0);
  });

  it('does not start when this window merely took over leadership', async () => {
    const h = new Harness({ config: { watchOnStartup: true }, start: { freshStart: false } });
    await drain();
    expect(h.state.armed).toBe(false);
  });

  it('does not start when the setting is off', async () => {
    const h = new Harness({ config: { watchOnStartup: false }, start: { freshStart: true } });
    await drain();
    expect(h.state.armed).toBe(false);
  });

  it('goes through the same validations as a manual start', async () => {
    const h = new Harness({ config: { watchOnStartup: true }, start: false });
    h.platform.capabilityOf.shutdown = { ok: false, detail: 'Shutting down is not allowed for this account.' };
    h.controller.start({ handover: null, previousLeaderWasWatching: false, freshStart: true });
    await drain();

    expect(h.state.armed).toBe(false);
    expect(h.logText()).toContain("Couldn't start watching at startup: Shutting down is not allowed for this account.");

    const stopped = new Harness({ config: { watchOnStartup: true }, start: false });
    stopped.createStopFile();
    stopped.controller.start({ handover: null, previousLeaderWasWatching: false, freshStart: true });
    await drain();
    expect(stopped.state.armed).toBe(false);
  });

  it("keeps last night's result on screen", async () => {
    const seed = new Harness({ start: false });
    writeLastRun(seed, { lastResult: { kind: 'done', atMs: seed.clock.now() - 1000, action: 'shutdown', resumedAtMs: null, confirmed: null } });
    const h = new Harness({ dir: seed.stateDir.dir, config: { watchOnStartup: true }, start: { freshStart: true } });
    await drain();
    expect(h.state.armed).toBe(true);
    expect(h.state.lastResult).toMatchObject({ kind: 'done', action: 'shutdown' });
  });
});

describe('dispose', () => {
  it('while watching without a handover: records that the window closed', async () => {
    const h = new Harness();
    await h.armUntilCountdown();
    const armedAtMs = h.published.at(-1)?.state.armedAtMs;

    h.controller.dispose({ handedOver: false });

    expect(h.lastRunFile()).toMatchObject({
      dismissed: false,
      lastResult: { kind: 'stopped', cause: 'windowClosed', armedAtMs, wasReal: true },
    });
    expect(h.watchingFileExists()).toBe(false);
    expect(h.clock.pending).toBe(0);
    expect(h.platform.alerts[0]?.stopped).toBe(true);
    expect(h.platform.keepAwakeCalls).toEqual([true, false]);

    const published = h.published.length;
    await h.clock.advance(300_000);
    expect(h.platform.executeCalls).toHaveLength(0);
    expect(h.published).toHaveLength(published);
    expect((await h.send({ name: 'refresh' })).ok).toBe(false);

    // The next start shows it.
    const next = new Harness({ dir: h.stateDir.dir });
    expect(next.state.lastResult).toMatchObject({ kind: 'stopped', cause: 'windowClosed' });
  });

  it('a window that lost its leader connection while watching says so, not that it closed', async () => {
    const h = new Harness();
    await h.armUntilCountdown();
    h.controller.dispose({ handedOver: false, cause: 'lostControl' });

    expect(h.lastRunFile()).toMatchObject({ lastResult: { kind: 'stopped', cause: 'lostControl', wasReal: true } });
    expect(h.logText()).toContain(
      'This window lost control of watching (its leader connection ended), so watching stopped. Nothing was done to this PC.',
    );
    expect(h.logLines('closed while watching')).toHaveLength(0);
    expect(h.watchingFileExists()).toBe(false);
    expect(h.platform.alerts[0]?.stopped).toBe(true);

    // The same window usually wins the next election: it shows that record and adds no other.
    const next = new Harness({ dir: h.stateDir.dir, start: { previousLeaderWasWatching: true } });
    expect(next.state.lastResult).toMatchObject({ kind: 'stopped', cause: 'lostControl', wasReal: true });
    expect(next.logLines('The window that was watching closed')).toHaveLength(0);
  });

  it('after a handover: writes no "stopped" record and leaves watching.json to the successor', async () => {
    const h = new Harness();
    await h.arm();
    h.controller.beginHandover();
    h.controller.dispose({ handedOver: true });

    expect(h.lastRunFile()).not.toMatchObject({ lastResult: { kind: 'stopped' } });
    expect(h.watchingFileExists()).toBe(true);
    expect(h.clock.pending).toBe(0);
    expect(h.platform.keepAwakeCalls).toEqual([true, false]);
  });

  it('while not watching: just stops everything', async () => {
    const h = new Harness({ viewers: true });
    h.controller.peersChanged();
    await drain();
    h.controller.dispose({ handedOver: false });

    expect(h.lastRunFile()).toBeNull();
    expect(h.clock.pending).toBe(0);
    h.controller.dispose({ handedOver: false }); // idempotent
  });

  it('a scan that completes after dispose changes nothing', async () => {
    const h = new Harness();
    let finish: (() => void) | null = null;
    h.scanner.script = () =>
      new Promise((resolve) => {
        finish = () => resolve(makeScan());
      });
    await h.arm();
    h.controller.dispose({ handedOver: false });
    const published = h.published.length;
    (finish as (() => void) | null)?.();
    await drain();
    expect(h.published).toHaveLength(published);
    expect(h.clock.pending).toBe(0);
  });
});
