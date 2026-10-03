import { afterEach, describe, expect, it } from 'vitest';

import { contractDigest, toArmContract } from '../../src/shared/config';
import type { Command } from '../../src/shared/protocol';
import { Harness, LEADER, busyScan, clearScan, drain, makeScan, makeSession, removeTempDirs, workingSession } from './harness';

afterEach(removeTempDirs);

describe('settingsChanged / configChanged', () => {
  it("from the contract's realm with another digest: stops watching and says why", async () => {
    const h = new Harness();
    await h.arm();
    const armedAtMs = h.state.armedAtMs;

    const result = await h.send({ name: 'settingsChanged', realm: LEADER.realm, digest: 'ffffffffffffffff' });

    expect(result).toEqual({ ok: true });
    expect(h.state).toMatchObject({ armed: false, phase: 'off' });
    expect(h.state.lastResult).toMatchObject({ kind: 'stopped', cause: 'settingsChanged', armedAtMs, wasReal: true });
    expect(h.watchingFileExists()).toBe(false);
    expect(h.lastRunFile()).toMatchObject({ lastResult: { kind: 'stopped', cause: 'settingsChanged' } });
  });

  it('from another realm: keeps watching', async () => {
    const h = new Harness();
    await h.arm();
    await h.send({ name: 'settingsChanged', realm: 'realm-cursor', digest: 'ffffffffffffffff' });
    expect(h.state.armed).toBe(true);
    expect(h.state.lastResult).toBeNull();
  });

  it("from the contract's realm with the same digest: keeps watching", async () => {
    const h = new Harness();
    await h.arm();
    await h.send({ name: 'settingsChanged', realm: LEADER.realm, digest: h.state.contractDigest });
    expect(h.state.armed).toBe(true);
  });

  it('cancels a running countdown when it stops watching', async () => {
    const h = new Harness();
    await h.armUntilCountdown();
    await h.send({ name: 'settingsChanged', realm: LEADER.realm, digest: 'ffffffffffffffff' });

    expect(h.state).toMatchObject({ armed: false, phase: 'off', countdown: null });
    expect(h.platform.alerts[0]?.stopped).toBe(true);
    await h.clock.advance(120_000);
    expect(h.platform.executeCalls).toHaveLength(0);
  });

  it("configChanged(): the leader's own safety settings changed while watching -> stops", async () => {
    const h = new Harness({ config: { testMode: true } });
    await h.arm();
    h.world.config = { ...h.world.config, testMode: false }; // a test run must never turn into a real one
    h.controller.configChanged();

    expect(h.state.armed).toBe(false);
    expect(h.state.lastResult).toMatchObject({ kind: 'stopped', cause: 'settingsChanged', wasReal: false });
  });

  it('configChanged(): a contract armed from another editor is not affected by the leader settings', async () => {
    const h = new Harness();
    const contract = toArmContract({ ...h.world.config, quietSeconds: 120 });
    await h.arm({ contract, digest: contractDigest(contract), realm: 'realm-cursor' });
    h.world.config = { ...h.world.config, quietSeconds: 600 };
    h.controller.configChanged();

    expect(h.state.armed).toBe(true);
    expect(h.state.contract.quietSeconds).toBe(120);
  });

  it('configChanged(): a setting outside the contract keeps watching (and keep-awake follows it)', async () => {
    const h = new Harness();
    await h.arm();
    expect(h.platform.keepAwakeCalls).toEqual([true]);
    h.world.config = { ...h.world.config, keepAwake: false };
    h.controller.configChanged();
    await drain();

    expect(h.state.armed).toBe(true);
    expect(h.platform.keepAwakeCalls).toEqual([true, false]);
    expect(h.state.platform.keepAwake).toBe('off');
  });

  it('while not watching: shows the new plan and scans with it', async () => {
    const h = new Harness({ viewers: true });
    h.controller.peersChanged();
    await drain();
    h.world.config = { ...h.world.config, quietSeconds: 90, action: 'sleep' };
    h.controller.configChanged();
    await drain();

    expect(h.state.contract).toMatchObject({ quietSeconds: 90, action: 'sleep' });
    expect(h.state.contractDigest).toBe(contractDigest(toArmContract(h.world.config)));
    expect(h.scanner.requests.at(-1)?.quietSeconds).toBe(90);
  });
});

describe('ignore', () => {
  const sessionKey = makeSession().ignoreKey;

  it('only accepts session:, proc: and remote: keys', async () => {
    const h = new Harness();
    for (const key of ['', 'session:', 'whatever', 'SESSION:1', '../etc', `proc:${'9'.repeat(2000)}`]) {
      const result = await h.send({ name: 'ignore', key, on: true });
      expect(result.ok).toBe(false);
    }
    expect((await h.send({ name: 'ignore', key: 5, on: true } as unknown as Command)).ok).toBe(false);
    expect((await h.send({ name: 'ignore', key: sessionKey, on: 'yes' } as unknown as Command)).ok).toBe(false);
    await h.send({ name: 'refresh' });
    expect(h.scanner.requests.at(-1)?.ignores.size).toBe(0);
  });

  it('adds the key to the scan request at once, logs it, and removes it again', async () => {
    const h = new Harness();
    h.scanner.script = (request) =>
      makeScan({ sessions: [workingSession({ ignored: request.ignores.has(sessionKey) })] });
    await h.arm();
    await h.clock.advance(5_000);
    const scans = h.scanner.requests.length;

    expect(await h.send({ name: 'ignore', key: sessionKey, on: true })).toEqual({ ok: true });
    expect(h.scanner.requests).toHaveLength(scans + 1); // scanned now, not at the next poll
    expect(h.scanner.requests.at(-1)?.ignores.has(sessionKey)).toBe(true);
    expect(h.state.sessions[0]?.ignored).toBe(true);
    expect(h.state.phase).toBe('confirming');
    expect(h.logText()).toContain('Not waiting for session "web-ui"');

    expect(await h.send({ name: 'ignore', key: sessionKey, on: false })).toEqual({ ok: true });
    expect(h.scanner.requests.at(-1)?.ignores.has(sessionKey)).toBe(false);
    expect(h.state).toMatchObject({ phase: 'watching', confirm: { k: 0 } });
    expect(h.logText()).toContain('Waiting for session "web-ui"');
  });

  it('un-ignoring during a countdown cancels it as soon as the scan shows the session working', async () => {
    const h = new Harness();
    h.scanner.script = (request) =>
      makeScan({ sessions: [workingSession({ ignored: request.ignores.has(sessionKey) })] });
    await h.send({ name: 'ignore', key: sessionKey, on: true });
    await h.armUntilCountdown();

    await h.send({ name: 'ignore', key: sessionKey, on: false });
    expect(h.state).toMatchObject({ armed: true, phase: 'watching', countdown: null });
    expect(h.state.lastResult).toMatchObject({ kind: 'cancelled', reason: { id: 'sessionResumed', name: 'web-ui' } });
  });

  it('prunes a session key once the session wrote again (its key changed)', async () => {
    const h = new Harness({ viewers: true });
    h.controller.peersChanged();
    await h.send({ name: 'ignore', key: sessionKey, on: true });
    await h.clock.advance(10_000);
    expect(h.scanner.requests.at(-1)?.ignores.has(sessionKey)).toBe(true); // still listed: kept

    h.scanner.script = () => makeScan({ sessions: [workingSession({ ignoreKey: 'session:0:4242:aaaa1111:2000:1768440099:0' })] });
    await h.clock.advance(10_000); // this scan no longer lists the key
    await h.clock.advance(10_000);
    expect(h.scanner.requests.at(-1)?.ignores.has(sessionKey)).toBe(false);
  });

  it('does not prune on a scan that could not see everything', async () => {
    const h = new Harness({ viewers: true });
    h.controller.peersChanged();
    await h.send({ name: 'ignore', key: sessionKey, on: true });

    h.scanner.script = () => makeScan({ sessions: [], errors: ['\\\\wsl.localhost\\Ubuntu timed out'] });
    await h.clock.advance(20_000);
    expect(h.scanner.requests.at(-1)?.ignores.has(sessionKey)).toBe(true);

    h.scanner.script = () => makeScan({ sessions: [], strays: null, processListOk: false });
    await h.clock.advance(20_000);
    expect(h.scanner.requests.at(-1)?.ignores.has(sessionKey)).toBe(true);

    h.scanner.script = () => makeScan({ sessions: [] });
    await h.clock.advance(20_000);
    expect(h.scanner.requests.at(-1)?.ignores.has(sessionKey)).toBe(false);
  });

  it('keeps a process key while the process pauses, and prunes it after 30 minutes of absence', async () => {
    const h = new Harness({ viewers: true });
    const procKey = 'proc:5150:133800000000000000';
    const child = { pid: 5150, name: 'webpack', cpuPercent: 40, ioBytesPerSecond: 0, busy: true, ignoreKey: procKey, ignored: true };
    h.scanner.script = () => makeScan({ sessions: [makeSession({ children: [child] })] });
    h.controller.peersChanged();
    await drain();
    await h.send({ name: 'ignore', key: procKey, on: true });
    expect(h.logText()).toContain('Not waiting for process webpack (PID 5150)');

    h.scanner.script = () => clearScan(); // the process is idle: scans stop listing it
    await h.clock.advance(29 * 60_000);
    expect(h.scanner.requests.at(-1)?.ignores.has(procKey)).toBe(true);

    await h.clock.advance(2 * 60_000);
    expect(h.scanner.requests.at(-1)?.ignores.has(procKey)).toBe(false);
  });

  it('prunes a remote-window key as soon as that window disconnects', async () => {
    const h = new Harness({ viewers: true });
    h.world.remoteWindows = ['SSH: build-box'];
    h.controller.peersChanged();
    await h.send({ name: 'ignore', key: 'remote:SSH: build-box', on: true });
    expect(h.state.remoteWindows).toEqual([
      { name: 'SSH: build-box', ignoreKey: 'remote:SSH: build-box', ignored: true, covered: false },
    ]);

    h.world.remoteWindows = [];
    h.controller.peersChanged();
    h.world.remoteWindows = ['SSH: build-box']; // a new window with the same name must block again
    h.controller.peersChanged();
    expect(h.state.remoteWindows[0]?.ignored).toBe(false);
  });
});

describe('preview', () => {
  it('counts down 20 s, never executes, never samples idle, and ends in `off`', async () => {
    const h = new Harness({ config: { action: 'hibernate' } });
    expect(await h.send({ name: 'preview' })).toEqual({ ok: true });

    expect(h.state).toMatchObject({ armed: false, phase: 'countdown' });
    expect(h.state.countdown).toMatchObject({ kind: 'preview', action: 'hibernate', totalMs: 20_000, remainingMs: 19_000 });
    expect(h.platform.alerts[0]?.options).toMatchObject({ kind: 'preview', seconds: 19 }); // minus the guard band

    await h.clock.advance(19_750);
    expect(h.state.phase).toBe('countdown');
    await h.clock.advance(250);

    expect(h.state).toMatchObject({ armed: false, phase: 'off', countdown: null, lastResult: null });
    expect(h.logText()).toContain('Preview finished.');
    expect(h.platform.alerts[0]?.stopped).toBe(true);
    expect(h.platform.idleCalls).toBe(0);
    expect(h.scanner.requests.every((request) => !request.forceWide)).toBe(true);

    await h.clock.advance(120_000);
    expect(h.platform.executeCalls).toHaveLength(0);
    expect(h.clock.pending).toBe(0);
  });

  it('is refused while watching or while another countdown runs', async () => {
    const h = new Harness();
    await h.send({ name: 'preview' });
    expect((await h.send({ name: 'preview' })).ok).toBe(false);

    const watching = new Harness();
    await watching.arm();
    const result = await watching.send({ name: 'preview' });
    expect(result).toEqual({ ok: false, error: 'The preview only works while not watching.' });
    expect(watching.state.countdown).toBeNull();
  });

  it('Cancel just ends it, without a result card', async () => {
    const h = new Harness();
    await h.send({ name: 'preview' });
    await h.clock.advance(3_000);
    await h.send({ name: 'cancel', via: 'esc' });

    expect(h.state).toMatchObject({ phase: 'off', countdown: null, lastResult: null });
    expect(h.platform.alerts[0]?.stopped).toBe(true);
  });

  it('gives way when watching starts', async () => {
    const h = new Harness();
    await h.send({ name: 'preview' });
    await h.arm();
    expect(h.state).toMatchObject({ armed: true, countdown: null });
    await h.clock.advance(15_000);
    expect(h.state.countdown).toBeNull();
    expect(h.platform.executeCalls).toHaveLength(0);
  });
});

describe('refresh, dismissResult, disarm, unknown commands', () => {
  it('refresh runs one scan when the engine is inactive, and no more', async () => {
    const h = new Harness();
    expect(await h.send({ name: 'refresh' })).toEqual({ ok: true });
    expect(h.scanner.requests).toHaveLength(1);
    expect(h.state.sessions).toHaveLength(1);
    expect(h.state.scan.lastCompletedAgoMs).toBe(0);

    await h.clock.advance(120_000);
    expect(h.scanner.requests).toHaveLength(1);
    expect(h.state.scan).toMatchObject({ engineActive: false, lastCompletedAgoMs: 120_000, stale: false });
  });

  it('refresh while watching scans now instead of waiting for the next poll', async () => {
    const h = new Harness();
    h.scanner.script = () => busyScan();
    await h.arm();
    await h.clock.advance(3_000);
    const scans = h.scanner.requests.length;
    await h.send({ name: 'refresh' });
    expect(h.scanner.requests).toHaveLength(scans + 1);
  });

  it('dismissResult hides the result but keeps it on disk, marked dismissed', async () => {
    const h = new Harness();
    await h.armUntilCountdown();
    await h.send({ name: 'cancel', via: 'button' });
    expect(h.state.lastResult?.kind).toBe('cancelled');

    expect(await h.send({ name: 'dismissResult' })).toEqual({ ok: true });
    expect(h.state.lastResult).toBeNull();
    expect(h.lastRunFile()).toMatchObject({ dismissed: true, lastResult: { kind: 'cancelled' } });
  });

  it('starting to watch clears the previous result', async () => {
    const h = new Harness();
    await h.armUntilCountdown();
    await h.send({ name: 'cancel', via: 'button' });
    await h.arm();
    expect(h.state.lastResult).toBeNull();
  });

  it('disarm is always ok, also when not watching', async () => {
    const h = new Harness();
    expect(await h.send({ name: 'disarm' })).toEqual({ ok: true });
    await h.arm();
    expect(await h.send({ name: 'disarm' })).toEqual({ ok: true });
    expect(h.state).toMatchObject({ armed: false, phase: 'off', lastResult: null });
    expect(h.logText()).toContain('Stopped watching (asked from "web-ui")');
  });

  it('an unknown or malformed command is refused, never thrown', async () => {
    const h = new Harness();
    for (const raw of [{ name: 'executeNow' }, { name: 'settingsChanged', realm: 5 }, null, 'cancel', []]) {
      const result = await h.send(raw as unknown as Command);
      expect(result.ok).toBe(false);
      expect(typeof result.error).toBe('string');
    }
    expect(h.state.armed).toBe(false);
  });
});
