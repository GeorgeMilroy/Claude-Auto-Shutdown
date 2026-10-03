import * as fs from 'node:fs';
import * as path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import type { ScanResult } from '../../src/core/types';
import type { Capability } from '../../src/platform/types';
import { contractDigest, toArmContract } from '../../src/shared/config';
import type { Command } from '../../src/shared/protocol';
import { HELLO, Harness, LEADER, busyScan, clearScan, deferred, drain, makeScan, makeTempDir, removeTempDirs } from './harness';

afterEach(removeTempDirs);

describe('start', () => {
  it('starts not watching, with no timers and no scans', async () => {
    const h = new Harness();
    await h.clock.advance(60_000);

    expect(h.state).toMatchObject({ armed: false, phase: 'off', countdown: null, armedBy: null, armedAtMs: null });
    expect(h.state.scan.engineActive).toBe(false);
    expect(h.scanner.requests).toHaveLength(0);
    expect(h.platform.executeCalls).toHaveLength(0);
    expect(h.watchingFileExists()).toBe(false);
  });

  it('refuses commands before start()', async () => {
    const h = new Harness({ start: false });
    const result = await h.send({ name: 'refresh' });
    expect(result.ok).toBe(false);
    expect(h.scanner.requests).toHaveLength(0);
  });
});

describe('arm validations', () => {
  async function expectRefused(h: Harness, command: Command, error: RegExp): Promise<void> {
    const result = await h.send(command);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(error);
    expect(h.state.armed).toBe(false);
    expect(h.watchingFileExists()).toBe(false);
  }

  it('accepts the plan the leader currently has, freezes it and writes watching.json', async () => {
    const h = new Harness();
    const result = await h.arm();

    expect(result).toEqual({ ok: true });
    expect(h.state).toMatchObject({ armed: true, armedBy: 'user', contractRealm: LEADER.realm });
    expect(h.state.armedAtMs).toBe(h.clock.now());
    expect(h.state.contractDigest).toBe(contractDigest(toArmContract(h.world.config)));
    expect(h.stateDir.readJson(h.stateDir.watchRecordFile)).toEqual({
      armedAtMs: h.state.armedAtMs,
      real: true,
      action: 'shutdown',
      pid: LEADER.pid,
    });
    expect(h.logText()).toContain('Started watching for real');
  });

  it('refuses an arm issued against another leader epoch', async () => {
    const h = new Harness();
    await expectRefused(h, h.armCommand({ epoch: 'someone-else' }), /controlling window changed/);
  });

  it('refuses a contract that does not validate', async () => {
    const h = new Harness();
    const contract = { ...toArmContract(h.world.config), quietSeconds: 1 };
    await expectRefused(h, h.armCommand({ contract, digest: contractDigest(contract) }), /isn't valid/);
  });

  it('refuses a contract whose digest does not match', async () => {
    const h = new Harness();
    await expectRefused(h, h.armCommand({ digest: '0000000000000000' }), /isn't valid/);
  });

  it("refuses when the leader's own settings differ from the plan the user saw", async () => {
    const h = new Harness();
    const command = h.armCommand();
    h.world.config = { ...h.world.config, testMode: true };
    await expectRefused(h, command, /^Settings changed\. Check the plan and try again\.$/);
  });

  it('accepts a different plan from another editor (another realm) and keeps that realm', async () => {
    const h = new Harness();
    const contract = toArmContract({ ...h.world.config, quietSeconds: 120 });
    const result = await h.arm({ contract, digest: contractDigest(contract), realm: 'realm-cursor' });

    expect(result.ok).toBe(true);
    expect(h.state.contract.quietSeconds).toBe(120);
    expect(h.state.contractRealm).toBe('realm-cursor');
  });

  it('refuses while Emergency stop is set', async () => {
    const h = new Harness();
    h.createStopFile('STOP.txt');
    await expectRefused(h, h.armCommand(), /Emergency stop is set/);
  });

  it('refuses when the state folder cannot be written to', async () => {
    const blocker = path.join(makeTempDir(), 'not-a-folder');
    fs.writeFileSync(blocker, '');
    const h = new Harness({ dir: path.join(blocker, 'state') });
    const result = await h.arm();

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/can't be written to/);
    expect(h.state.armed).toBe(false);
    expect(h.state.stop.present).toBe(true); // a brake that cannot be read counts as set
  });

  it('refuses when the platform reports an environment problem', async () => {
    const h = new Harness();
    h.platform.environment = "VS Code runs inside Flatpak, so other programs on this PC can't be seen.";
    await expectRefused(h, h.armCommand(), /inside Flatpak/);
  });

  it('refuses when the helper is unavailable', async () => {
    const h = new Harness();
    h.platform.helper = { tier: 'unavailable', problem: 'PowerShell is blocked by policy.' };
    await expectRefused(h, h.armCommand(), /PowerShell is blocked by policy/);
  });

  it('asks the OS afresh and refuses when the action is not allowed', async () => {
    const h = new Harness();
    h.platform.capabilityOf.shutdown = { ok: false, detail: 'Hibernation is turned off on this PC.' };
    await expectRefused(h, h.armCommand(), /Hibernation is turned off/);
    expect(h.platform.capabilityCalls).toEqual(['shutdown']);
  });

  it('refuses when the OS cannot say whether the action is allowed', async () => {
    const h = new Harness();
    h.platform.capabilityOf.shutdown = { ok: null, detail: '' };
    await expectRefused(h, h.armCommand(), /Couldn't check whether this PC can shut down/);
  });

  it('does not need a capability for "notify"', async () => {
    const h = new Harness({ config: { action: 'notify' } });
    h.platform.capabilityOf.notify = { ok: false, detail: 'irrelevant' };
    expect((await h.arm()).ok).toBe(true);
  });

  it("refuses when the arming window's editor reported a settings change while the OS was asked", async () => {
    const h = new Harness();
    const answer = deferred<Capability>();
    h.platform.capability = () => answer.promise;
    const contract = toArmContract({ ...h.world.config, quietSeconds: 120 });
    const arming = h.controller.handleCommand(h.armCommand({ contract, digest: contractDigest(contract), realm: 'realm-cursor' }), HELLO);
    await drain();

    // The plan is still editable while the OS answers: the user flips that editor to a test run.
    const changed = toArmContract({ ...h.world.config, quietSeconds: 120, testMode: true });
    expect(await h.send({ name: 'settingsChanged', realm: 'realm-cursor', digest: contractDigest(changed) })).toEqual({ ok: true });
    answer.resolve({ ok: true, detail: 'Allowed' });

    expect(await arming).toEqual({ ok: false, error: 'Settings changed. Check the plan and try again.' });
    await drain();
    expect(h.state.armed).toBe(false);
    expect(h.watchingFileExists()).toBe(false);
  });

  it('a change reported by another realm, or back to the plan that was sent, does not void the arm', async () => {
    const h = new Harness();
    const answer = deferred<Capability>();
    h.platform.capability = () => answer.promise;
    const contract = toArmContract({ ...h.world.config, quietSeconds: 120 });
    const digest = contractDigest(contract);
    const arming = h.controller.handleCommand(h.armCommand({ contract, digest, realm: 'realm-cursor' }), HELLO);
    await drain();

    await h.send({ name: 'settingsChanged', realm: 'realm-other', digest: 'ffffffffffffffff' });
    await h.send({ name: 'settingsChanged', realm: 'realm-cursor', digest: 'eeeeeeeeeeeeeeee' });
    await h.send({ name: 'settingsChanged', realm: 'realm-cursor', digest }); // changed back
    answer.resolve({ ok: true, detail: 'Allowed' });

    expect(await arming).toEqual({ ok: true });
    expect(h.state).toMatchObject({ armed: true, contractRealm: 'realm-cursor' });
  });

  it("refuses when the leader's own settings changed while the OS was asked", async () => {
    const h = new Harness();
    const answer = deferred<Capability>();
    h.platform.capability = () => answer.promise;
    const arming = h.controller.handleCommand(h.armCommand(), HELLO);
    await drain();
    h.world.config = { ...h.world.config, testMode: true };
    h.controller.configChanged();
    answer.resolve({ ok: true, detail: 'Allowed' });

    expect(await arming).toEqual({ ok: false, error: 'Settings changed. Check the plan and try again.' });
    expect(h.state.armed).toBe(false);
  });

  it('refuses a second arm while already watching', async () => {
    const h = new Harness();
    expect((await h.arm()).ok).toBe(true);
    const again = await h.arm();
    expect(again).toEqual({ ok: false, error: 'Already watching.' });
    expect(h.state.armed).toBe(true);
  });

  it('refuses once a handover has begun', async () => {
    const h = new Harness();
    const command = h.armCommand();
    h.controller.beginHandover();
    await expectRefused(h, command, /starting or closing/);
  });

  it('refuses a malformed arm instead of throwing', async () => {
    const h = new Harness();
    const broken = { name: 'arm', contract: 'shutdown please', epoch: h.state.epoch } as unknown as Command;
    await expectRefused(h, broken, /didn't understand/);
  });
});

describe('confirmations', () => {
  it('goes watching -> confirming -> countdown after exactly requiredPolls clear polls', async () => {
    const h = new Harness();
    h.scanner.script = (_request, index) => (index === 0 ? busyScan() : clearScan());

    await h.arm();
    expect(h.scanner.requests).toHaveLength(1);
    expect(h.state).toMatchObject({ phase: 'watching', confirm: { k: 0, n: 3 }, countdown: null });

    await h.clock.advance(10_000);
    expect(h.state).toMatchObject({ phase: 'confirming', confirm: { k: 1, n: 3 }, countdown: null });

    await h.clock.advance(10_000);
    expect(h.state).toMatchObject({ phase: 'confirming', confirm: { k: 2, n: 3 }, countdown: null });

    await h.clock.advance(9_999);
    expect(h.scanner.requests).toHaveLength(3);
    expect(h.state.countdown).toBeNull();

    await h.clock.advance(1);
    expect(h.scanner.requests).toHaveLength(4);
    expect(h.state).toMatchObject({ phase: 'countdown', confirm: { k: 3, n: 3 } });
    expect(h.state.countdown).toMatchObject({ kind: 'real', action: 'shutdown', totalMs: 30_000 });
    expect(h.platform.executeCalls).toHaveLength(0);
  });

  it('"Check again" and ignore clicks cannot squeeze the confirmations together', async () => {
    const h = new Harness({ config: { requireUserIdle: false } });
    await h.arm();
    expect(h.state.confirm.k).toBe(1);

    await h.send({ name: 'refresh' });
    await h.send({ name: 'refresh' });
    await h.send({ name: 'ignore', key: 'proc:1:2', on: true });
    expect(h.scanner.requests).toHaveLength(4);
    expect(h.state).toMatchObject({ phase: 'confirming', confirm: { k: 1 }, countdown: null });

    await h.clock.advance(10_000);
    expect(h.state.confirm.k).toBe(2);
    await h.clock.advance(9_000);
    await h.send({ name: 'refresh' }); // 9 s after the last counted check: still too close
    expect(h.state).toMatchObject({ phase: 'confirming', confirm: { k: 2 }, countdown: null });

    await h.clock.advance(10_000); // the next regular poll, a full interval later
    expect(h.state.phase).toBe('countdown');
    expect(h.platform.executeCalls).toHaveLength(0);
  });

  it('an extra scan still resets the count when it is not clear', async () => {
    const h = new Harness();
    await h.arm();
    await h.clock.advance(10_000);
    expect(h.state.confirm.k).toBe(2);

    h.scanner.script = () => busyScan();
    await h.send({ name: 'refresh' });
    expect(h.state).toMatchObject({ phase: 'watching', confirm: { k: 0 } });
  });

  it('scans with the frozen contract and the current ignores, never forceWide while polling', async () => {
    const h = new Harness({ config: { quietSeconds: 240, guardProcesses: ['ffmpeg'], scanWsl: false } });
    await h.arm();
    await h.clock.advance(10_000);

    for (const request of h.scanner.requests) {
      expect(request).toMatchObject({ quietSeconds: 240, guardPatterns: ['ffmpeg'], scanWsl: false, forceWide: false });
    }
  });

  it('one unclear poll resets the count', async () => {
    const h = new Harness();
    const script: ScanResult[] = [clearScan(), clearScan(), busyScan(), clearScan(), clearScan(), clearScan()];
    h.scanner.script = (_request, index) => script[index] ?? clearScan();

    await h.arm();
    await h.clock.advance(10_000);
    expect(h.state.confirm.k).toBe(2);

    await h.clock.advance(10_000);
    expect(h.state).toMatchObject({ phase: 'watching', confirm: { k: 0 }, countdown: null });

    await h.clock.advance(20_000);
    expect(h.state).toMatchObject({ phase: 'confirming', confirm: { k: 2 }, countdown: null });

    await h.clock.advance(10_000);
    expect(h.state.phase).toBe('countdown');
  });

  it('a scan that started before the rules changed is shown but never counted', async () => {
    const h = new Harness();
    const stale = deferred<ScanResult>();
    const current = deferred<ScanResult>();
    h.scanner.script = (_request, index) => (index === 2 ? stale.promise : index === 3 ? current.promise : clearScan());

    await h.arm();
    await h.clock.advance(10_000);
    expect(h.state.confirm.k).toBe(2);

    await h.clock.advance(10_000); // third scan is in flight
    expect(h.scanner.requests).toHaveLength(3);
    await h.send({ name: 'ignore', key: 'proc:777:123456', on: true }); // bumps the generation

    stale.resolve(makeScan({ sessions: [] }));
    await drain();
    // The stale result is displayed (no sessions) ...
    expect(h.state.sessions).toHaveLength(0);
    // ... but it is not the third confirmation, and a current scan was started right away.
    expect(h.state).toMatchObject({ phase: 'confirming', confirm: { k: 2 }, countdown: null });
    expect(h.scanner.requests).toHaveLength(4);
    expect(h.scanner.requests[3]?.ignores.has('proc:777:123456')).toBe(true);

    current.resolve(clearScan());
    await drain();
    expect(h.state.phase).toBe('countdown');
  });

  it('a scan that was already running when watching started does not count as the first poll', async () => {
    const h = new Harness({ viewers: true });
    const before = deferred<ScanResult>();
    const after = deferred<ScanResult>();
    h.scanner.script = (_request, index) => (index === 0 ? before.promise : index === 1 ? after.promise : clearScan());
    h.controller.peersChanged();
    await drain();
    expect(h.scanner.requests).toHaveLength(1);

    await h.arm();
    before.resolve(clearScan());
    await drain();
    expect(h.state).toMatchObject({ armed: true, confirm: { k: 0 } });
    expect(h.scanner.requests).toHaveLength(2);

    after.resolve(clearScan());
    await drain();
    expect(h.state.confirm.k).toBe(1);
  });

  it('a scanner that rejects blocks instead of counting', async () => {
    const h = new Harness();
    h.scanner.script = () => {
      throw new Error('EIO: registry unreadable');
    };
    await h.arm();
    await h.clock.advance(60_000);

    expect(h.state).toMatchObject({ armed: true, phase: 'watching', confirm: { k: 0 }, countdown: null });
    expect(h.state.checks.find((check) => check.id === 'scanner')?.state).toBe('cantTell');
    expect(h.scanner.requests.length).toBeGreaterThan(5);
    expect(h.logLines('EIO: registry unreadable')).toHaveLength(1); // once, not once per poll
  });

  it('a remote-window list that cannot be read blocks like an unknown remote window', async () => {
    const h = new Harness({
      deps: {
        getRemoteWindows: () => {
          throw new Error('coordinator not ready');
        },
      },
    });
    await h.arm();
    await h.clock.advance(60_000);
    expect(h.state).toMatchObject({ armed: true, phase: 'watching', countdown: null });
    expect(h.state.remoteWindows).toHaveLength(1);
    expect(h.state.remoteWindows[0]).toMatchObject({ ignored: false, covered: false });
  });

  it('never counts more than one step per poll, whatever evaluate claims', async () => {
    const h = new Harness({
      deps: {
        evaluate: (input) => ({
          checks: [{ id: 'confirmed', state: 'pass', data: { k: 99, n: 3 } }],
          allClear: true,
          ok: true,
          stablePolls: 99,
          requiredPolls: input.contract.requiredPolls,
        }),
      },
    });
    await h.arm();
    expect(h.state).toMatchObject({ confirm: { k: 1 }, countdown: null });
    await h.clock.advance(10_000);
    expect(h.state).toMatchObject({ confirm: { k: 2 }, countdown: null });
  });

  it('an evaluate that throws means nothing passes', async () => {
    const h = new Harness({
      deps: {
        evaluate: () => {
          throw new Error('boom');
        },
      },
    });
    await h.arm();
    await h.clock.advance(60_000);
    expect(h.state).toMatchObject({ armed: true, phase: 'watching', countdown: null });
    expect(h.platform.executeCalls).toHaveLength(0);
  });

  it('blocks while a remote window is connected, until it is ignored', async () => {
    const h = new Harness();
    h.world.remoteWindows = ['SSH: build-box'];
    await h.arm();
    await h.clock.advance(40_000);
    expect(h.state).toMatchObject({ phase: 'watching', countdown: null });
    expect(h.state.remoteWindows).toEqual([
      { name: 'SSH: build-box', ignoreKey: 'remote:SSH: build-box', ignored: false, covered: false },
    ]);

    await h.send({ name: 'ignore', key: 'remote:SSH: build-box', on: true });
    expect(h.state.remoteWindows[0]?.ignored).toBe(true);
    // The scan right after the click comes too soon after the last poll to count as a check.
    await h.clock.advance(20_000);
    expect(h.state).toMatchObject({ phase: 'confirming', confirm: { k: 2 } });
    await h.clock.advance(10_000);
    expect(h.state.phase).toBe('countdown');
  });

  it('passes unregistered Claude processes through to the state', async () => {
    const h = new Harness({ viewers: true });
    expect(h.state.strays).toBeNull(); // no scan yet = can't tell
    const stray = { pid: 77, name: 'claude', path: null, accounted: false, ignoreKey: 'proc:77:1', ignored: false, children: [] };
    h.scanner.script = () => makeScan({ strays: [stray] });
    h.controller.peersChanged();
    await drain();
    expect(h.state.strays).toEqual([stray]);
  });

  it('treats a remote window as covered when the scan reads its own Claude folder', async () => {
    const h = new Harness({ viewers: true });
    h.world.remoteWindows = ['WSL: Ubuntu'];
    h.scanner.script = () =>
      makeScan({
        roots: [
          { path: '\\\\wsl.localhost\\Ubuntu\\home\\me\\.claude', label: 'WSL: Ubuntu', kind: 'foreign', ok: true, missing: false, detail: null },
        ],
      });
    h.controller.peersChanged();
    await drain();
    expect(h.state.remoteWindows[0]).toMatchObject({ name: 'WSL: Ubuntu', covered: true });
  });
});

describe('records on disk while watching', () => {
  it('watching.json exists exactly while watching', async () => {
    const h = new Harness();
    expect(h.watchingFileExists()).toBe(false);
    await h.arm();
    expect(h.watchingFileExists()).toBe(true);
    await h.send({ name: 'disarm' });
    expect(h.watchingFileExists()).toBe(false);
    expect(fs.readdirSync(h.stateDir.dir)).not.toContain(path.basename(h.stateDir.watchRecordFile));
  });

  it('names the window that asked in the log', async () => {
    const h = new Harness();
    await h.send(h.armCommand(), { ...HELLO, label: 'my-project' });
    expect(h.logText()).toContain('Started by window "my-project"');
  });
});
