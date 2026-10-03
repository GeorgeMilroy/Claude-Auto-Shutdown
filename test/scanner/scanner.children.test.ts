// Processes a session started: found through the process tree, measured between scans.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { CLAUDE_EXE, CLOSED, NOW, SESSION_START, createWorkspace, detail, only, sessionNamed, type Workspace } from './support';

const ID = 'aaaaaaaa-1111-2222-3333-444444444444';
const WATCH = { waitForChildProcesses: true };

let ws: Workspace;
beforeEach(() => {
  ws = createWorkspace();
  // A session whose turn ended long ago: only a child process can keep it working.
  ws.liveSession(100, ID, { name: 'builder' });
  ws.claude.transcript('p', ID, CLOSED, NOW - 5000_000);
});
afterEach(() => ws.cleanup());

/** The next scan happens ten seconds later. */
function tenSecondsLater(): void {
  ws.clock.now += 10_000;
}

describe('child processes', () => {
  it('finds everything below the session and counts a first sample as busy', async () => {
    ws.platform.run(200, 'cmd', 100);
    ws.platform.run(300, 'node', 200);
    ws.platform.run(201, 'conhost', 100);
    ws.platform.run(900, 'node', 1);

    const session = only(await ws.scan(WATCH));

    expect(ws.platform.probeRequests).toEqual([[200, 300]]);
    expect(session.children).toEqual([
      { pid: 200, name: 'cmd', cpuPercent: null, ioBytesPerSecond: null, busy: true, ignoreKey: `proc:200:${detail().startRaw}`, ignored: false },
      { pid: 300, name: 'node', cpuPercent: null, ioBytesPerSecond: null, busy: true, ignoreKey: `proc:300:${detail().startRaw}`, ignored: false },
    ]);
    expect(session).toMatchObject({ status: 'working', working: true, why: { id: 'childBusy', name: 'cmd', pid: 200 } });
  });

  it('lets the session finish once its children are idle', async () => {
    ws.platform.run(200, 'node', 100, { cpuSeconds: 5, ioBytes: 1000 });
    await ws.scan(WATCH);

    tenSecondsLater();
    ws.platform.probeSamples[200] = detail({ cpuSeconds: 5.1, ioBytes: 301_000 });
    expect(only(await ws.scan(WATCH))).toMatchObject({ children: [], status: 'finished', working: false });
  });

  it('keeps the session working while a child uses the CPU', async () => {
    ws.platform.run(200, 'cargo', 100, { cpuSeconds: 5, ioBytes: 1000 });
    await ws.scan(WATCH);

    tenSecondsLater();
    ws.platform.probeSamples[200] = detail({ cpuSeconds: 9, ioBytes: 1000 });
    expect(only(await ws.scan(WATCH))).toMatchObject({
      children: [{ pid: 200, name: 'cargo', cpuPercent: 40, ioBytesPerSecond: 0, busy: true }],
      status: 'working',
      why: { id: 'childBusy', name: 'cargo', pid: 200 },
    });
  });

  it('keeps the session working while a child reads or writes', async () => {
    ws.platform.run(200, 'curl', 100, { cpuSeconds: 5, ioBytes: 1000 });
    await ws.scan(WATCH);

    tenSecondsLater();
    ws.platform.probeSamples[200] = detail({ cpuSeconds: 5, ioBytes: 5_001_000 });
    expect(only(await ws.scan(WATCH))).toMatchObject({
      children: [{ pid: 200, cpuPercent: 0, ioBytesPerSecond: 500_000, busy: true }],
      status: 'working',
    });
  });

  it('does not wait for a child the user chose to ignore, but still shows it', async () => {
    ws.platform.run(200, 'cargo', 100);
    const ignoreKey = `proc:200:${detail().startRaw}`;

    const session = only(await ws.scan({ ...WATCH, ignores: new Set([ignoreKey]) }));

    expect(session.children).toMatchObject([{ pid: 200, busy: true, ignoreKey, ignored: true }]);
    expect(session).toMatchObject({ status: 'finished', working: false, why: { id: 'quiet' } });
  });

  it('names the first child that is not ignored as the reason', async () => {
    ws.platform.run(200, 'cargo', 100);
    ws.platform.run(300, 'rustc', 200);
    const session = only(await ws.scan({ ...WATCH, ignores: new Set([`proc:200:${detail().startRaw}`]) }));
    expect(session.why).toEqual({ id: 'childBusy', name: 'rustc', pid: 300 });
    expect(session.children.map((child) => [child.pid, child.ignored])).toEqual([
      [300, false],
      [200, true],
    ]);
  });

  it('lists at most 10 children and never cuts one that blocks in favour of an ignored one', async () => {
    const ignores = new Set<string>();
    for (let pid = 201; pid <= 212; pid++) {
      ws.platform.run(pid, 'worker', 100);
      if (pid <= 211) ignores.add(`proc:${pid}:${detail().startRaw}`);
    }

    const session = only(await ws.scan({ ...WATCH, ignores }));

    expect(session.children).toHaveLength(10);
    expect(session.children[0]).toMatchObject({ pid: 212, ignored: false });
    expect(session.why).toEqual({ id: 'childBusy', name: 'worker', pid: 212 });
  });

  it('leaves out a process that started before the session: a leftover of a reused parent PID', async () => {
    ws.platform.run(200, 'old-daemon', 100, { startEpochMs: SESSION_START - 1001 });
    ws.platform.run(300, 'its-child', 200);
    ws.platform.run(210, 'just-in-time', 100, { startEpochMs: SESSION_START - 1000 });

    const session = only(await ws.scan(WATCH));

    expect(session.children.map((child) => child.pid)).toEqual([210]);
  });

  it('does not reach into another registered session', async () => {
    ws.liveSession(500, 'bbbbbbbb-1111-2222-3333-444444444444', { name: 'nested' });
    ws.claude.transcript('p', 'bbbbbbbb-1111-2222-3333-444444444444', CLOSED, NOW - 5000_000);
    const nested = ws.platform.processes?.find((row) => row.pid === 500);
    if (nested) nested.ppid = 100;
    ws.platform.run(600, 'npm', 500);

    const result = await ws.scan(WATCH);

    expect(sessionNamed(result, 'builder').children).toEqual([]);
    expect(sessionNamed(result, 'nested').children.map((child) => child.pid)).toEqual([600]);
    expect(result.strays).toEqual([]);
  });

  it('counts a child the probe says nothing about as busy for as long as that lasts', async () => {
    ws.platform.run(200, 'elevated', 100, null);
    await ws.scan(WATCH);
    tenSecondsLater();
    expect(only(await ws.scan(WATCH))).toMatchObject({ children: [{ pid: 200, cpuPercent: null, busy: true, ignoreKey: 'proc:200:0' }], status: 'working' });
  });

  it('counts every child as busy when the probe fails', async () => {
    ws.platform.run(200, 'node', 100, null);
    ws.platform.failing.add('probe');
    const result = await ws.scan(WATCH);
    expect(only(result)).toMatchObject({ children: [{ pid: 200, busy: true }], status: 'working' });
  });

  it('drops a child that exited between the process list and the probe', async () => {
    ws.platform.run(200, 'node', 100);
    ws.platform.probeSamples[200] = detail({ state: 'gone', path: null, startRaw: null, startEpochMs: null, cpuSeconds: null, ioBytes: null });
    expect(only(await ws.scan(WATCH))).toMatchObject({ children: [], status: 'finished' });
  });

  it('starts a new baseline for a child that was away for a scan', async () => {
    ws.platform.run(200, 'node', 100, { cpuSeconds: 5 });
    await ws.scan(WATCH);

    const rows = ws.platform.processes ?? [];
    ws.platform.processes = rows.filter((row) => row.pid !== 200);
    tenSecondsLater();
    expect(only(await ws.scan(WATCH)).children).toEqual([]);

    ws.platform.processes = rows;
    tenSecondsLater();
    expect(only(await ws.scan(WATCH)).children).toMatchObject([{ pid: 200, cpuPercent: null, busy: true }]);
  });

  it('asks the next snapshot for the detail of the processes it found', async () => {
    ws.platform.run(200, 'cmd', 100);
    ws.platform.run(300, 'node', 200);
    await ws.scan();
    await ws.scan();
    expect([...(ws.platform.snapshotRequests[0]?.detailPids ?? [])].sort()).toEqual([100]);
    expect([...(ws.platform.snapshotRequests[1]?.detailPids ?? [])].sort()).toEqual([100, 200, 300]);
  });

  it('measures nothing while the check is off', async () => {
    ws.platform.run(200, 'cargo', 100);
    const session = only(await ws.scan({ waitForChildProcesses: false }));
    expect(ws.platform.probeRequests).toEqual([]);
    expect(session).toMatchObject({ children: [], status: 'finished' });
  });

  it('has no children to offer when the process list cannot be read', async () => {
    ws.platform.run(200, 'cargo', 100);
    ws.platform.processes = null;
    const result = await ws.scan(WATCH);
    expect(only(result)).toMatchObject({ children: [], liveness: 'verified' });
    expect(result.processListOk).toBe(false);
  });

  it('says so when no process has a known parent: "no children" would be a guess', async () => {
    ws.platform.run(200, 'cargo', 100);
    ws.platform.processes = (ws.platform.processes ?? []).map((row) => ({ ...row, ppid: null }));

    const blind = await ws.scan(WATCH);
    expect(only(blind).children).toEqual([]);
    expect(blind.errors).toHaveLength(1);
    expect(blind.errors[0]).toMatch(/which program started which/);

    // With the check off nobody asks for the tree, so nothing is missing.
    ws.clock.now += 10_000;
    expect((await ws.scan({ waitForChildProcesses: false })).errors).toEqual([]);
  });

  it('does not take a child of a session for an unregistered Claude process', async () => {
    ws.platform.run(200, 'cmd', 100);
    ws.platform.run(300, 'claude', 200, { path: CLAUDE_EXE });
    const result = await ws.scan(WATCH);
    expect(result.strays).toEqual([]);
    expect(only(result).children.map((child) => child.pid)).toEqual([200, 300]);
  });
});
